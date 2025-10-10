import { task, types } from "hardhat/config";
import type { TaskArguments, HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType, HardhatFhevmRuntimeEnvironment } from "@fhevm/hardhat-plugin";
import fs from "fs";
import path from "path";

type HermesConfig = {
  ESCROW_ADDRESS?: string;
  NOTARY_ADDRESS?: string;

  DEFAULT_TOKEN_IN?: string;
  DEFAULT_TOKEN_OUT?: string;

  LAST_RFQ?: string;

  OPERATOR_DEADLINE_SECS?: number; // default validity window when setting token operator
};

const HERMES_JSON_PATH = path.resolve(__dirname, "..", "HERMES.json");

function readConfig(): HermesConfig {
  if (!fs.existsSync(HERMES_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(HERMES_JSON_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${HERMES_JSON_PATH}: ${(e as Error).message}`);
  }
}
function writeConfig(patch: Partial<HermesConfig>) {
  const current = readConfig();
  const merged = { ...current, ...patch };
  fs.writeFileSync(HERMES_JSON_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
function requireConfig(): HermesConfig {
  if (!fs.existsSync(HERMES_JSON_PATH)) {
    console.warn(`Could not find HERMES.json. Run 'npx hardhat hermes:deploy' (or set addresses manually).`);
    process.exit(1);
  }
  return readConfig();
}

async function getEscrow(hre: HardhatRuntimeEnvironment) {
  const cfg = requireConfig();
  if (!cfg.ESCROW_ADDRESS) throw new Error("ESCROW_ADDRESS not set in HERMES.json");
  const signer = (await hre.ethers.getSigners())[0];
  return hre.ethers.getContractAt("HermesOtcEscrow", cfg.ESCROW_ADDRESS, signer);
}
async function getNotary(hre: HardhatRuntimeEnvironment) {
  const cfg = requireConfig();
  if (!cfg.NOTARY_ADDRESS) throw new Error("NOTARY_ADDRESS not set in HERMES.json");
  const signer = (await hre.ethers.getSigners())[0];
  return hre.ethers.getContractAt("HermesNotary", cfg.NOTARY_ADDRESS, signer);
}
async function getToken(hre: HardhatRuntimeEnvironment, tokenAddr: string, signer?: HardhatEthersSigner) {
  const s = signer ?? (await hre.ethers.getSigners())[0];
  return hre.ethers.getContractAt("ConfidentialToken", tokenAddr, s);
}
const scalingFactor = (d: number) => BigInt(10) ** BigInt(d);

async function userDecrypt64(
  fhevm: HardhatFhevmRuntimeEnvironment,
  handle: string,
  contractAddr: string,
  signer: HardhatEthersSigner,
) {
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddr, signer);
}

const EIP712_NAME = "Hermes-OTC";
const EIP712_VERSION = "1";

type RfqView = {
  maker: string;
  taker: string;
  tokenAddressIn: string;
  tokenAddressOut: string;
  tokenAmountIn: string; // bytes32 handle
  tokenAmountOut: string; // bytes32 handle
  createdAt: bigint;
  expirationTimestamp: bigint;
};

function makerTypes() {
  return {
    MakerAgree: [
      { name: "rfqId", type: "bytes32" },
      { name: "maker", type: "address" },
      { name: "taker", type: "address" },
      { name: "tokenAddressIn", type: "address" },
      { name: "tokenAddressOut", type: "address" },
      { name: "amountIn", type: "bytes32" },
      { name: "amountOut", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "expirationTimestamp", type: "uint256" },
    ],
  };
}
function takerTypes() {
  return {
    TakerAgree: [
      { name: "rfqId", type: "bytes32" },
      { name: "maker", type: "address" },
      { name: "taker", type: "address" },
      { name: "tokenAddressIn", type: "address" },
      { name: "tokenAddressOut", type: "address" },
      { name: "amountIn", type: "bytes32" },
      { name: "amountOut", type: "bytes32" },
      { name: "createdAt", type: "uint256" },
      { name: "expirationTimestamp", type: "uint256" },
    ],
  };
}
async function eip712Domain(hre: HardhatRuntimeEnvironment, verifyingContract: string) {
  const net = await hre.ethers.provider.getNetwork();
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: Number(net.chainId),
    verifyingContract,
  };
}
async function signMakerAgree(
  hre: HardhatRuntimeEnvironment,
  signer: HardhatEthersSigner,
  escrowAddr: string,
  rfqId: string,
  rfq: RfqView,
) {
  const domain = await eip712Domain(hre, escrowAddr);
  const types = makerTypes();
  const value = {
    rfqId,
    maker: rfq.maker,
    taker: rfq.taker,
    tokenAddressIn: rfq.tokenAddressIn,
    tokenAddressOut: rfq.tokenAddressOut,
    amountIn: rfq.tokenAmountIn,
    amountOut: rfq.tokenAmountOut,
    createdAt: rfq.createdAt,
    expirationTimestamp: rfq.expirationTimestamp,
  };
  // ethers v6
  return signer.signTypedData(domain as any, types as any, value as any);
}
async function signTakerAgree(
  hre: HardhatRuntimeEnvironment,
  signer: HardhatEthersSigner,
  escrowAddr: string,
  rfqId: string,
  rfq: RfqView,
) {
  const domain = await eip712Domain(hre, escrowAddr);
  const types = takerTypes();
  const value = {
    rfqId,
    maker: rfq.maker,
    taker: rfq.taker,
    tokenAddressIn: rfq.tokenAddressIn,
    tokenAddressOut: rfq.tokenAddressOut,
    amountIn: rfq.tokenAmountIn,
    amountOut: rfq.tokenAmountOut,
    createdAt: rfq.createdAt,
    expirationTimestamp: rfq.expirationTimestamp,
  };
  return signer.signTypedData(domain as any, types as any, value as any);
}

function waitForRFQCreated(
  escrow: HermesOtcEscrow,
  timeoutMs = 120_000,
): Promise<{ maker: string; blockNumber: bigint; rfqID: string; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = escrow.getEvent("RFQCreated"); // TypedContractEvent
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (maker: string, blockNumber: bigint, rfqID: string, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] RFQCreated maker=${maker} block=${blockNumber.toString()} rfqID=${rfqID}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ maker, blockNumber, rfqID, txHash: event?.log?.transactionHash });
    };

    void escrow.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for RFQCreated after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

function waitForProofOfDeposit(
  escrow: HermesOtcEscrow,
  timeoutMs = 180_000,
): Promise<{ maker: string; taker: string; blockNumber: bigint; rfqID: string; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = escrow.getEvent("ProofOfDeposit");
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (maker: string, taker: string, blockNumber: bigint, rfqID: string, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] ProofOfDeposit maker=${maker} taker=${taker} block=${blockNumber.toString()} rfqID=${rfqID}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ maker, taker, blockNumber, rfqID, txHash: event?.log?.transactionHash });
    };

    void escrow.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ProofOfDeposit after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

function waitForOrderCanceled(
  escrow: HermesOtcEscrow,
  timeoutMs = 120_000,
): Promise<{ maker: string; taker: string; blockNumber: bigint; rfqID: string; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = escrow.getEvent("OrderCanceled");
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (maker: string, taker: string, blockNumber: bigint, rfqID: string, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] OrderCanceled maker=${maker} taker=${taker} block=${blockNumber.toString()} rfqID=${rfqID}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ maker, taker, blockNumber, rfqID, txHash: event?.log?.transactionHash });
    };

    void escrow.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for OrderCanceled after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

function waitForOrderFulfilled(
  escrow: HermesOtcEscrow,
  timeoutMs = 120_000,
): Promise<{ maker: string; taker: string; blockNumber: bigint; rfqID: string; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = escrow.getEvent("OrderFulfilled");
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (maker: string, taker: string, blockNumber: bigint, rfqID: string, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] OrderFulfilled maker=${maker} taker=${taker} block=${blockNumber.toString()} rfqID=${rfqID}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ maker, taker, blockNumber, rfqID, txHash: event?.log?.transactionHash });
    };

    void escrow.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for OrderFulfilled after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

task("hermes:deploy", "Deploy HermesNotary + HermesOtcEscrow + default tokens").setAction(async (_args, hre) => {
  const { run, deployments, getNamedAccounts, ethers } = hre;
  const { deploy, get, getOrNull, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // 1) Deploy Notary + Escrow via tags
  await run("deploy", { tags: "notary" });
  const notary = await get("HermesNotary");

  await run("deploy", { tags: "escrow" });
  const escrow = await get("HermesOtcEscrow");

  // 2) Wire Notary -> Escrow defensively (in case scripts were run out-of-order)
  const notaryCtr = await ethers.getContractAt("HermesNotary", notary.address);
  const currentEscrow = await notaryCtr.escrow();
  if (currentEscrow.toLowerCase() !== escrow.address.toLowerCase()) {
    const owner = (await ethers.getSigners())[0];
    await (await notaryCtr.connect(owner).setEscrow(escrow.address)).wait();
    log(`Set HermesNotary.escrow -> ${escrow.address}`);
  }

  // 3) Deploy default confidential tokens if missing
  //    TokenIn  = "US Dollar" (USD)
  //    TokenOut = "Euro"      (EUR)
  let tokenInDep = await getOrNull("HermesTokenIn");
  if (!tokenInDep) {
    tokenInDep = await deploy("HermesTokenIn", {
      from: deployer,
      log: true,
      contract: "ConfidentialToken",
      args: ["US Dollar", "USD"],
    });
  }

  let tokenOutDep = await getOrNull("HermesTokenOut");
  if (!tokenOutDep) {
    tokenOutDep = await deploy("HermesTokenOut", {
      from: deployer,
      log: true,
      contract: "ConfidentialToken",
      args: ["Euro", "EUR"],
    });
  }

  log(`HermesNotary:     ${notary.address}`);
  log(`HermesOtcEscrow:  ${escrow.address}`);
  log(`Default tokenIn:  ${tokenInDep.address} (US Dollar / USD)`);
  log(`Default tokenOut: ${tokenOutDep.address} (Euro / EUR)`);

  // 4) Always save to HERMES.json
  writeConfig({
    NOTARY_ADDRESS: notary.address,
    ESCROW_ADDRESS: escrow.address,
    DEFAULT_TOKEN_IN: tokenInDep.address,
    DEFAULT_TOKEN_OUT: tokenOutDep.address,
    OPERATOR_DEADLINE_SECS: 24 * 60 * 60, // 1 day
  });
  console.log(`Saved to HERMES.json`);
});

task("hermes:set_defaults", "Save default token addresses / operator deadline")
  .addOptionalParam("tokenin", "Default maker deposit token", undefined, types.string)
  .addOptionalParam("tokenout", "Default taker deposit token", undefined, types.string)
  .addOptionalParam("deadline", "Operator deadline (seconds from now)", undefined, types.int)
  .setAction(async (args: TaskArguments) => {
    const patch: Partial<HermesConfig> = {};
    if (args.tokenin) patch.DEFAULT_TOKEN_IN = args.tokenin;
    if (args.tokenout) patch.DEFAULT_TOKEN_OUT = args.tokenout;
    if (args.deadline !== undefined) patch.OPERATOR_DEADLINE_SECS = Number(args.deadline);
    writeConfig(patch);
    console.log(`Updated HERMES.json with: ${JSON.stringify(patch, null, 2)}`);
  });

task("hermes:get_balances", "Decrypt balances on both token").setAction(async (_args: TaskArguments, hre) => {
  const cfg = requireConfig();
  const tokenA = cfg.DEFAULT_TOKEN_IN;
  const tokenB = cfg.DEFAULT_TOKEN_OUT;
  if (!tokenA || !tokenB) {
    throw new Error("Token addresses not found in HERMES.json.");
  }

  const { ethers, fhevm } = hre;
  const [signer] = await ethers.getSigners();
  const token0 = await ethers.getContractAt("ConfidentialToken", tokenA, signer);
  const token1 = await ethers.getContractAt("ConfidentialToken", tokenB, signer);
  await fhevm.initializeCLIApi();

  const encryptedBalance0 = await token0.confidentialBalanceOf(signer.address);
  const encryptedBalance1 = await token1.confidentialBalanceOf(signer.address);

  const clearBalance0 = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    encryptedBalance0,
    await token0.getAddress(),
    signer,
  );
  const clearBalance1 = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    encryptedBalance1,
    await token1.getAddress(),
    signer,
  );

  console.log(`Decrypted balance on tokenA : ${clearBalance0}\nDecrypted balance on tokenB : ${clearBalance1}`);
});

task("hermes:airdrop", "Claims a 1000 token airdrop on both Hermes tokens").setAction(
  async (_args: TaskArguments, hre) => {
    const cfg = requireConfig();

    const tokenA = cfg.DEFAULT_TOKEN_IN;
    const tokenB = cfg.DEFAULT_TOKEN_OUT;
    if (!tokenA || !tokenB) {
      throw new Error("Token addresses not found in HERMES.json.");
    }

    const { ethers } = hre;
    const [signer] = await ethers.getSigners();

    const tA = await ethers.getContractAt("ConfidentialToken", tokenA, signer);
    const tB = await ethers.getContractAt("ConfidentialToken", tokenB, signer);

    console.log(`Claiming airdrop as ${signer.address}`);
    console.log(`Token A: ${tokenA}`);
    const txA = await tA.airDrop();
    const rcA = await txA.wait();
    if (!rcA?.status) throw new Error("Airdrop Tx on token A failed.");
    console.log(`Claimed airdrop on token A. tx=${rcA.hash}`);

    console.log(`Token B: ${tokenB}`);
    const txB = await tB.airDrop();
    const rcB = await txB.wait();
    if (!rcB?.status) throw new Error("Airdrop Tx on token B failed.");
    console.log(`Claimed airdrop on token B. tx=${rcB.hash}`);
  },
);

task("hermes:create_rfq", "Create a new RFQ using encrypted amounts")
  .addParam("taker", "Taker address", undefined, types.string)
  .addOptionalParam("tokenin", "Maker deposit token (defaults from config)", undefined, types.string)
  .addOptionalParam("tokenout", "Taker deposit token (defaults from config)", undefined, types.string)
  .addParam("amountin", "Maker amount (human units)", undefined, types.string)
  .addParam("amountout", "Taker amount (human units)", undefined, types.string)
  .addOptionalParam("decimals", "Token decimals (both sides)", 6, types.int)
  .addOptionalParam("expiresin", "Seconds from now for expiration", 3600, types.int)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const { ethers, fhevm } = hre;

    const taker = ethers.getAddress(String(args.taker));
    const tokenIn = ethers.getAddress(String(args.tokenin ?? cfg.DEFAULT_TOKEN_IN));
    const tokenOut = ethers.getAddress(String(args.tokenout ?? cfg.DEFAULT_TOKEN_OUT));
    if (!tokenIn || !tokenOut) throw new Error("tokenIn/tokenOut missing. Pass --tokenin/--tokenout or set defaults.");

    const dec = Number(args.decimals);
    const amountIn = BigInt(args.amountin) * scalingFactor(dec);
    const amountOut = BigInt(args.amountout) * scalingFactor(dec);

    const signer = (await ethers.getSigners())[0];
    const escrow = await getEscrow(hre);

    const nowBlock = await ethers.provider.getBlock("latest");
    if (!nowBlock) throw new Error("failed to fetch latest block");
    const expiration = BigInt(nowBlock.timestamp + Number(args.expiresin));

    await fhevm.initializeCLIApi();

    const rfqCreatedEvent = waitForRFQCreated(escrow);

    const clear = await fhevm.createEncryptedInput(await escrow.getAddress(), signer.address);
    clear.add64(amountIn);
    clear.add64(amountOut);
    const encrypted = await clear.encrypt();

    const tx = await escrow["createRFQ(address,address,address,bytes32,bytes32,uint256,bytes)"](
      taker,
      tokenIn,
      tokenOut,
      encrypted.handles[0],
      encrypted.handles[1],
      expiration,
      encrypted.inputProof,
    );
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("createRFQ tx failed");

    const { rfqID } = await rfqCreatedEvent;
    writeConfig({ LAST_RFQ: rfqID });
    console.log(`Created RFQ: ${rfqID}`);
  });

task("hermes:set_operator", "Set escrow as operator on a confidential token for the caller")
  .addParam("token", "Token address", undefined, types.string)
  .addOptionalParam("seconds", "Validity window in seconds (default from config or 86400)", undefined, types.int)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = readConfig();
    const { ethers } = hre;
    const tokenAddr = ethers.getAddress(String(args.token));
    const escrowAddr = cfg.ESCROW_ADDRESS;
    if (!escrowAddr) throw new Error("ESCROW_ADDRESS missing in HERMES.json");

    const secs = Number(args.seconds ?? cfg.OPERATOR_DEADLINE_SECS ?? 86400);
    const signer = (await ethers.getSigners())[0];
    const token = await getToken(hre, tokenAddr, signer);

    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("failed to fetch latest block");
    const deadline = latest.timestamp + secs;

    const isOp = await token.isOperator(signer.address, escrowAddr);
    if (!isOp) {
      const tx = await token.setOperator(escrowAddr, deadline);
      await tx.wait();
      console.log(`Operator set: ${escrowAddr}, deadline=${deadline}`);
    } else {
      console.log(`Operator already set for ${escrowAddr}`);
    }
  });

task("hermes:maker_agree", "Maker agrees and deposits tokenIn")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const { ethers } = hre;

    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ in HERMES.json");

    const escrow = await getEscrow(hre);
    const signer = (await ethers.getSigners())[0];

    // Fetch RFQ view (public mapping accessor)
    const r = await escrow.rfqs(rfqId);
    const rfq: RfqView = {
      maker: r.maker,
      taker: r.taker,
      tokenAddressIn: r.tokenAddressIn,
      tokenAddressOut: r.tokenAddressOut,
      tokenAmountIn: r.tokenAmountIn,
      tokenAmountOut: r.tokenAmountOut,
      createdAt: r.createdAt,
      expirationTimestamp: r.expirationTimestamp,
    };

    // Ensure escrow is operator on tokenIn (maker side)
    const tokenIn = await getToken(hre, rfq.tokenAddressIn, signer);
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("failed to fetch latest block");
    const secs = cfg.OPERATOR_DEADLINE_SECS ?? 86400;
    const deadline = latest.timestamp + secs;
    if (!(await tokenIn.isOperator(signer.address, await escrow.getAddress()))) {
      console.log("Setting escrow as operator on tokenIn for maker...");
      await (await tokenIn.setOperator(await escrow.getAddress(), deadline)).wait();
    }

    // EIP-712 sign and agree
    const sig = await signMakerAgree(hre, signer, await escrow.getAddress(), rfqId, rfq);
    const tx = await escrow.makerAgree(rfqId, sig);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("makerAgree failed");

    console.log(`makerAgree done. tx=${rc.hash}`);
  });

task("hermes:taker_agree", "Taker agrees and deposits tokenOut")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const { ethers } = hre;

    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ in HERMES.json");

    const escrow = await getEscrow(hre);

    // Switch to taker signer if needed; default is signer[0]
    const signer = (await ethers.getSigners())[0];

    const r = await escrow.rfqs(rfqId);
    const rfq: RfqView = {
      maker: r.maker,
      taker: r.taker,
      tokenAddressIn: r.tokenAddressIn,
      tokenAddressOut: r.tokenAddressOut,
      tokenAmountIn: r.tokenAmountIn,
      tokenAmountOut: r.tokenAmountOut,
      createdAt: r.createdAt,
      expirationTimestamp: r.expirationTimestamp,
    };

    // Ensure escrow is operator on tokenOut (taker side)
    const tokenOut = await getToken(hre, rfq.tokenAddressOut, signer);
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("failed to fetch latest block");
    const secs = cfg.OPERATOR_DEADLINE_SECS ?? 86400;
    const deadline = latest.timestamp + secs;
    if (!(await tokenOut.isOperator(signer.address, await escrow.getAddress()))) {
      console.log("Setting escrow as operator on tokenOut for taker...");
      await (await tokenOut.setOperator(await escrow.getAddress(), deadline)).wait();
    }

    // EIP-712 sign and agree
    const sig = await signTakerAgree(hre, signer, await escrow.getAddress(), rfqId, rfq);
    const tx = await escrow.takerAgree(rfqId, sig);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("takerAgree failed");

    console.log(`takerAgree done. tx=${rc.hash}`);
  });

task("hermes:pod", "Generate Proof-of-Deposit")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ");

    const escrow = await getEscrow(hre);

    const podP = (async () => {
      const r = await waitForProofOfDeposit(escrow, 180_000);
      return { kind: "pod" as const, ...r };
    })();

    const cancelP = (async () => {
      const r = await waitForOrderCanceled(escrow, 180_000);
      return { kind: "cancel" as const, ...r };
    })();

    const tx = await escrow.generatePoD(rfqId);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("generatePoD failed");

    console.log(`generatePoD sent: ${rc.hash}`);

    const winner = await Promise.race([podP, cancelP]);
    if (winner.kind === "pod") {
      console.log(`Event: ProofOfDeposit tx=${winner.txHash ?? "?"}`);
    } else {
      console.log(`Event: OrderCanceled tx=${winner.txHash ?? "?"}`);
    }
  });

task("hermes:settle", "Settle an RFQ after PoD")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ");

    const escrow = await getEscrow(hre);
    const eventPromise = waitForOrderFulfilled(escrow);
    const tx = await escrow.settle(rfqId);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("settle failed");

    const ev = await eventPromise.catch(() => null);
    console.log(`settle tx=${rc.hash}`);
    if (ev) console.log(`OrderFulfilled observed: tx=${ev.txHash ?? "?"}`);
  });

task("hermes:cancel", "Cancel an RFQ")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ");

    const escrow = await getEscrow(hre);
    const tx = await escrow.cancelRFQ(rfqId);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("cancelRFQ failed");

    const ev = await waitForOrderCanceled(escrow).catch(() => null);
    console.log(`cancel tx=${rc.hash}`);
    if (ev) console.log(`OrderCanceled observed: tx=${ev.txHash ?? "?"}`);
  });

task("hermes:my_rfqs", "List RFQs (sent/received) for the current signer").setAction(async (_args, hre) => {
  const escrow = await getEscrow(hre);
  const [sent, received] = await escrow.getRFQs();
  console.log(`Sent RFQs    :\n${sent.length ? sent.join("\n") : "(none)"}`);
  console.log(`Received RFQs:\n${received.length ? received.join("\n") : "(none)"}`);
});

task("hermes:agreement", "Read consent mask from escrow")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ");

    const escrow = await getEscrow(hre);
    try {
      const mask: number = await escrow.checkAgreementStatus(rfqId);
      console.log(`consentMask=${mask} (maker bit=1, taker bit=2)`);
    } catch (e) {
      console.log(`checkAgreementStatus failed (are you a participant?): ${(e as Error).message}`);
    }
  });

task("hermes:status", "Read RFQ status from Notary; decrypt allowed fields")
  .addOptionalParam("rfqid", "RFQ id (defaults to LAST_RFQ)", undefined, types.string)
  .setAction(async (args: TaskArguments, hre) => {
    const cfg = requireConfig();
    const rfqId = String(args.rfqid ?? cfg.LAST_RFQ);
    if (!rfqId) throw new Error("Provide --rfqid or set LAST_RFQ");

    const { ethers, fhevm } = hre;
    const notary = await getNotary(hre);
    const signer = (await ethers.getSigners())[0];

    await fhevm.initializeCLIApi();

    const s = await notary.statusOf(rfqId);
    console.log(`maker=${s.maker} taker=${s.taker}
tokenIn=${s.tokenAddressIn} tokenOut=${s.tokenAddressOut}
createdAt=${s.createdAt} expiration=${s.expirationTimestamp}
consentMask=${s.consentMask} canceled=${s.canceled} expired=${s.expired} filled=${s.filled}
fundDeposited=${s.fundDeposited}`);

    try {
      const amtIn = await userDecrypt64(fhevm, s.amountIn, await notary.getAddress(), signer);
      const amtOut = await userDecrypt64(fhevm, s.amountOut, await notary.getAddress(), signer);
      console.log(`amountIn(e64)=${amtIn.toString()} amountOut(e64)=${amtOut.toString()}`);
    } catch {
      console.log("(amountIn/Out) decrypt: not permitted for this signer");
    }

    try {
      const md = await userDecrypt64(fhevm, s.makerDeposit, await notary.getAddress(), signer);
      const td = await userDecrypt64(fhevm, s.takerDeposit, await notary.getAddress(), signer);
      console.log(`makerDeposit=${md.toString()} takerDeposit=${td.toString()}`);
    } catch {
      console.log("(maker/taker deposit) decrypt not permited or 0");
    }

    try {
      const sm = await userDecrypt64(fhevm, s.amountSentMaker, await notary.getAddress(), signer);
      const st = await userDecrypt64(fhevm, s.amountSentTaker, await notary.getAddress(), signer);
      console.log(`amountSentMaker=${sm.toString()} amountSentTaker=${st.toString()}`);
    } catch {
      console.log("(settlement amounts) decrypt not permited or 0");
    }

    console.log(`obfuscatedDeposits=${s.obfuscatedDeposits.toString()}`);
  });
