import { task, types } from "hardhat/config";
import type { TaskArguments, HardhatRuntimeEnvironment } from "hardhat/types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ConfLendMarket } from "../types";
import { FhevmType, HardhatFhevmRuntimeEnvironment } from "@fhevm/hardhat-plugin";
import fs from "fs";
import path from "path";

type ObolConfig = {
  ORACLE_ADDRESS?: string;
  TOKEN_USD?: string;
  TOKEN_EUR?: string;
  MARKET_EURtoUSD?: string;
  MARKET_USDtoEUR?: string;
  RATE_RELAYER?: string;
  OPERATOR_DEADLINE_SECS?: number;
};

const OBOL_JSON_PATH = path.resolve(__dirname, "..", "OBOL.json");
const scalingFactor = (d: number) => BigInt(10) ** BigInt(d);
const nullHandle = "0x0000000000000000000000000000000000000000000000000000000000000000";

function readCfg(): ObolConfig {
  if (!fs.existsSync(OBOL_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OBOL_JSON_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse OBOL.json: ${(e as Error).message}`);
  }
}
function writeCfg(patch: Partial<ObolConfig>) {
  const cur = readCfg();
  fs.writeFileSync(OBOL_JSON_PATH, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n", "utf8");
}
function requireCfg(): ObolConfig {
  if (!fs.existsSync(OBOL_JSON_PATH)) {
    console.warn(`Could not find OBOL.json. Run 'npx hardhat obol:deploy' first.`);
    process.exit(1);
  }
  return readCfg();
}

function waitForLiquidationClaimed(
  market: ConfLendMarket,
  timeoutMs = 180_000,
): Promise<{ user: string; liquidator: string; blockNumber: bigint; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = market.getEvent("LiquidationClaimed"); // TypedContractEvent

    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (user: string, liquidator: string, blockNumber: bigint, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] LiquidationClaimed user=${user} liquidator=${liquidator} block=${blockNumber.toString()}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ user, liquidator, blockNumber, txHash: event?.log?.transactionHash });
    };

    void market.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for LiquidationClaimed after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

function waitForLiquidationQueued(
  market: ConfLendMarket,
  timeoutMs = 180_000,
): Promise<{ user: string; liquidator: string; blockNumber: bigint; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = market.getEvent("LiquidationQueued"); // TypedContractEvent

    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (user: string, liquidator: string, blockNumber: bigint, event: any) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] LiquidationQueued user=${user} liquidator=${liquidator} block=${blockNumber.toString()}\n` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ user, liquidator, blockNumber, txHash: event?.log?.transactionHash });
    };

    void market.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for LiquidationQueued after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

//marketFactorsRefreshed(user, requestID, block.number, pos[user].A, pos[user].B);
function waitForFactorResfresh(
  market: ConfLendMarket,
  timeoutMs = 180_000,
): Promise<{ user: string; requestID: bigint; blockNumber: bigint; userA: bigint; userB: bigint; txHash?: string }> {
  return new Promise((resolve, reject) => {
    const ev = market.getEvent("marketFactorsRefreshed"); // TypedContractEvent

    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onEvent = (
      user: string,
      requestID: bigint,
      blockNumber: bigint,
      userA: bigint,
      userB: bigint,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: any,
    ) => {
      if (timer) clearTimeout(timer);
      console.log(
        `[EVENT] marketFactorsRefreshed user=${user} requestID=${requestID} block=${blockNumber.toString()}\n` +
          `userA=${userA} userB=${userB}` +
          `tx=${event?.log?.transactionHash ?? "?"}`,
      );
      resolve({ user, requestID, blockNumber, userA, userB, txHash: event?.log?.transactionHash });
    };

    void market.once(ev, onEvent).catch((err: unknown) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for marketFactorsRefreshed after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
}

async function getToken(hre: HardhatRuntimeEnvironment, addr: string, signer?: HardhatEthersSigner) {
  const s = signer ?? (await hre.ethers.getSigners())[0];
  return hre.ethers.getContractAt("ConfidentialToken", addr, s);
}
async function getOracle(hre: HardhatRuntimeEnvironment, addr?: string) {
  const cfg = requireCfg();
  const use = addr ?? cfg.ORACLE_ADDRESS;
  if (!use) throw new Error("ORACLE_ADDRESS missing. Run obol:deploy or set in OBOL.json");
  const signer = (await hre.ethers.getSigners())[0];
  return hre.ethers.getContractAt("ObolPriceOracle", use, signer);
}
async function getMarket(hre: HardhatRuntimeEnvironment, which: "EURtoUSD" | "USDtoEUR") {
  const cfg = requireCfg();
  const name = which === "EURtoUSD" ? "ConfLendMarket_EURtoUSD" : "ConfLendMarket_USDtoEUR";
  const address = which === "EURtoUSD" ? cfg.MARKET_EURtoUSD : cfg.MARKET_USDtoEUR;
  const signer = (await hre.ethers.getSigners())[0];
  if (address) return hre.ethers.getContractAt("ConfLendMarket", address, signer);
  const dep = await hre.deployments.getOrNull(name);
  if (!dep) throw new Error(`${name} not deployed and not in OBOL.json`);
  return hre.ethers.getContractAt("ConfLendMarket", dep.address, signer);
}
async function userDecrypt64(
  fhevm: HardhatFhevmRuntimeEnvironment,
  handle: string,
  contractAddr: string,
  signer: HardhatEthersSigner,
) {
  if (handle == nullHandle) {
    return BigInt(0);
  } else {
    const clearVal = await fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddr, signer);
    return clearVal;
  }
}
async function enc64For(hre: HardhatRuntimeEnvironment, ctrAddr: string, user: string, amt: bigint) {
  const { fhevm } = hre;
  await fhevm.initializeCLIApi();
  const input = fhevm.createEncryptedInput(ctrAddr, user);
  input.add64(amt);
  return input.encrypt();
}

task("obol:deploy", "Deploy tokens + oracle + markets via fixtures and save to OBOL.json")
  .addFlag("reset", "Force redeploy of underlying hardhat-deploy scripts")
  .addOptionalParam("relayer", "Rate relayer address (defaults to deployer)", undefined, types.string)
  .addOptionalParam("tokenusd", "Pre-existing USD token address.", undefined, types.string)
  .addOptionalParam("tokeneur", "Pre-existing EUR token address.", undefined, types.string)
  .addOptionalParam("oracle", "Pre-existing oracle address", undefined, types.string)
  .setAction(async function (_args: TaskArguments, hre) {
    const { ethers, deployments, getNamedAccounts, network, run } = hre;
    const { get, save, getArtifact, log } = deployments;
    const { deployer } = await getNamedAccounts();
    const signer = await ethers.getSigner(deployer);

    const rateRelayer = _args.relayer ? ethers.getAddress(String(_args.relayer)) : signer.address;
    const providedUsd = _args.tokenusd ? ethers.getAddress(String(_args.tokenusd)) : undefined;
    const providedEur = _args.tokeneur ? ethers.getAddress(String(_args.tokeneur)) : undefined;
    const providedOracle = _args.oracle ? ethers.getAddress(String(_args.oracle)) : undefined;
    const useProvidedTokens = Boolean(providedUsd && providedEur);

    console.log("Deploying ConfLend ...");
    console.log(`Network: ${network.name}`);
    console.log(`Deployer: ${deployer}`);
    console.log(`Rate relayer: ${rateRelayer}`);
    if (useProvidedTokens) {
      console.log(`Using provided token addresses -> USD: ${providedUsd}, EUR: ${providedEur}`);
    }
    if (providedOracle) {
      console.log(`Using provided oracle address -> ${providedOracle}`);
    }
    if (_args.reset) console.log("RESET enabled: underlying deploy scripts will redeploy.");

    process.env.RATE_RELAYER = rateRelayer;
    if (providedOracle) {
      process.env.OBOL_ORACLE = providedOracle;
    }

    if (useProvidedTokens) {
      // Register the provided addresses with hardhat-deploy so downstream deploys can "get" them.
      let tokenAbi;
      try {
        tokenAbi = await getArtifact("ConfidentialToken");
      } catch {
        tokenAbi = await getArtifact("IERC7984");
      }

      await save("TokenUSD", { address: providedUsd!, abi: tokenAbi.abi });
      await save("TokenEUR", { address: providedEur!, abi: tokenAbi.abi });
    } else {
      await run("deploy", { tags: "tokens", reset: _args.reset });
    }

    if (providedOracle) {
      const oracleAbi = (await getArtifact("ObolPriceOracle")).abi;
      await save("ObolPriceOracle", { address: providedOracle, abi: oracleAbi });
    } else {
      await run("deploy", { tags: "oracle", reset: _args.reset });
    }
    await run("deploy", { tags: "markets", reset: _args.reset });

    // grab deployments
    const usd = await get("TokenUSD"); // ConfidentialToken("Us Dollar","USD")
    const eur = await get("TokenEUR"); // ConfidentialToken("EURO","EUR")
    const oracle = await get("ObolPriceOracle");
    const mkt1 = await get("ConfLendMarket_EURtoUSD"); // collateral EUR, debt USD -> oUSD
    const mkt2 = await get("ConfLendMarket_USDtoEUR"); // collateral USD, debt EUR -> oEUR

    console.log(`TokenUSD: ${usd.address}`);
    console.log(`TokenEUR: ${eur.address}`);
    console.log(`Oracle  : ${oracle.address}`);
    console.log(`Market EUR->USD: ${mkt1.address}`);
    console.log(`Market USD->EUR: ${mkt2.address}`);

    const art = await getArtifact("ConfLendMarket");
    await save("ConfLendMarket", { address: mkt1.address, abi: art.abi });
    await save("ConfLendMarket_2", { address: mkt2.address, abi: art.abi });

    writeCfg({
      ORACLE_ADDRESS: oracle.address,
      TOKEN_USD: usd.address,
      TOKEN_EUR: eur.address,
      MARKET_EURtoUSD: mkt1.address,
      MARKET_USDtoEUR: mkt2.address,
      RATE_RELAYER: rateRelayer,
      OPERATOR_DEADLINE_SECS: 24 * 60 * 60,
    });
    log("Saved to OBOL.json");
  });

task("obol:deploy_oracle", "Deploy oracle independently")
  .addOptionalParam("relayer", "Price relayer address", undefined, types.string)
  .setAction(async (_args, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();

    const priceRelayer = _args.relayer ? ethers.getAddress(String(_args.relayer)) : signer.address;
    const oracleFactory = await ethers.getContractFactory("ObolPriceOracle", signer);
    const oracleInstance = await oracleFactory.deploy(priceRelayer, 30 * 60);
    await oracleInstance.waitForDeployment();
    const oracleAddress = await oracleInstance.getAddress();
    console.log("Oracle address :", oracleAddress);

    writeCfg({
      ORACLE_ADDRESS: oracleAddress,
    });
    console.log("Saved to OBOL.json");
  });

task("obol:get_price_relayer", "Gets the oracle price relayer").setAction(async (_args, hre) => {
  const oracle = await getOracle(hre, _args.oracle ? String(_args.oracle) : undefined);

  const priceRelayer = await oracle.relayer();
  console.log("Oracle price relayer address :", priceRelayer);
});

task("obol:get_oracle_address", "Gets the oracle address from markets").setAction(async (_args, hre) => {
  const m1 = await getMarket(hre, "EURtoUSD");
  const m2 = await getMarket(hre, "USDtoEUR");

  const oracleM1 = await m1.oracleAddress();
  const oracleM2 = await m2.oracleAddress();
  console.log(
    `Oracle address on market 1 (EURtoUSD) : ${oracleM1}\nOracle address on market 2 (EURtoUSD) : ${oracleM2}`,
  );
});

task("obol:set_defaults", "Patch OBOL.json defaults")
  .addOptionalParam("usd", "Token USD address", undefined, types.string)
  .addOptionalParam("eur", "Token EUR address", undefined, types.string)
  .addOptionalParam("oracle", "Oracle address", undefined, types.string)
  .addOptionalParam("m1", "Market EUR->USD address", undefined, types.string)
  .addOptionalParam("m2", "Market USD->EUR address", undefined, types.string)
  .addOptionalParam("relayer", "Rate relayer address", undefined, types.string)
  .addOptionalParam("deadline", "Operator deadline seconds", undefined, types.int)
  .setAction(async (args) => {
    const patch: Partial<ObolConfig> = {};
    if (args.usd) patch.TOKEN_USD = args.usd;
    if (args.eur) patch.TOKEN_EUR = args.eur;
    if (args.oracle) patch.ORACLE_ADDRESS = args.oracle;
    if (args.m1) patch.MARKET_EURtoUSD = args.m1;
    if (args.m2) patch.MARKET_USDtoEUR = args.m2;
    if (args.relayer) patch.RATE_RELAYER = args.relayer;
    if (args.deadline !== undefined) patch.OPERATOR_DEADLINE_SECS = Number(args.deadline);
    writeCfg(patch);
    console.log(`Updated OBOL.json with: ${JSON.stringify(patch, null, 2)}`);
  });

task("obol:airdrop", "Claim 1000 token airdrop on USD & EUR").setAction(async (_args, hre) => {
  const cfg = requireCfg();
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  if (!cfg.TOKEN_USD || !cfg.TOKEN_EUR) throw new Error("Tokens missing in OBOL.json");

  const tUSD = await getToken(hre, cfg.TOKEN_USD, signer);
  const tEUR = await getToken(hre, cfg.TOKEN_EUR, signer);

  console.log(`Claiming airdrop as ${signer.address}`);
  const txA = await tUSD.airDrop();
  const rcA = await txA.wait();
  if (!rcA?.status) throw new Error("airdrop USD failed");
  console.log(`USD airdrop tx=${rcA.hash}`);

  const txB = await tEUR.airDrop();
  const rcB = await txB.wait();
  if (!rcB?.status) throw new Error("airdrop EUR failed");
  console.log(`EUR airdrop tx=${rcB.hash}`);
});

task("obol:get_balances", "Decrypt balances of USD/EUR + oUSD/oEUR").setAction(async (args, hre) => {
  const cfg = requireCfg();
  const { ethers, fhevm } = hre;
  const [signer] = await ethers.getSigners();

  if (!cfg.TOKEN_USD || !cfg.TOKEN_EUR || !cfg.MARKET_EURtoUSD || !cfg.MARKET_USDtoEUR)
    throw new Error("Missing addresses in OBOL.json");

  await fhevm.initializeCLIApi();

  const usd = await getToken(hre, cfg.TOKEN_USD, signer);
  const eur = await getToken(hre, cfg.TOKEN_EUR, signer);
  const m1 = await getMarket(hre, "EURtoUSD");
  const m2 = await getMarket(hre, "USDtoEUR");

  const eUsd = await usd.confidentialBalanceOf(signer.address);
  const eEur = await eur.confidentialBalanceOf(signer.address);
  const clearUsd = await userDecrypt64(fhevm, eUsd, await usd.getAddress(), signer);
  const clearEur = await userDecrypt64(fhevm, eEur, await eur.getAddress(), signer);

  const eShares1 = await m1.confidentialBalanceOf(signer);
  const eShares2 = await m2.confidentialBalanceOf(signer);
  const sh1 = await userDecrypt64(fhevm, eShares1, await m1.getAddress(), signer);
  const sh2 = await userDecrypt64(fhevm, eShares2, await m2.getAddress(), signer);

  const div = Number(scalingFactor(6));
  console.log(`USD=${Number(clearUsd) / div} | EUR=${Number(clearEur) / div}`);
  console.log(`oUSD=${Number(sh1) / div} | oEUR=${Number(sh2) / div}`);
});

task("obol:set_operator", "Set spender (market/oracle/escrow) as operator on a confidential token for the caller")
  .addParam("token", "Token address", undefined, types.string)
  .addParam("spender", "Operator address", undefined, types.string)
  .addOptionalParam("seconds", "Validity window (default OBOL.json or 86400)", undefined, types.int)
  .setAction(async (args, hre) => {
    const cfg = readCfg();
    const { ethers } = hre;
    const tokenAddr = ethers.getAddress(String(args.token));
    const spenderAddr = ethers.getAddress(String(args.spender));
    const secs = Number(args.seconds ?? cfg.OPERATOR_DEADLINE_SECS ?? 86400);

    const signer = (await ethers.getSigners())[0];
    const token = await getToken(hre, tokenAddr, signer);
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("failed to fetch latest block");
    const deadline = latest.timestamp + secs;

    if (!(await token.isOperator(signer.address, spenderAddr))) {
      const tx = await token.setOperator(spenderAddr, deadline);
      const rc = await tx.wait();
      if (!rc?.status) throw new Error("setOperator failed");
      console.log(`Operator set: ${spenderAddr}, deadline=${deadline}`);
    } else {
      console.log(`Operator already set for ${spenderAddr}`);
    }
  });

task("obol:set_price", "Set oracle price (1e6) and source id")
  .addParam("price6", "Price (1e6 scaled)", undefined, types.string)
  .setAction(async (args, hre) => {
    const oracle = await getOracle(hre, args.oracle ? String(args.oracle) : undefined);
    const price6 = BigInt(args.price6);
    const epoch = Math.floor(Date.now() / 1000); // epoch in seconds
    const tx = await oracle.setPrice(price6, epoch);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("setPrice failed");
    console.log(`Oracle price set to ${price6} (epoch=${epoch}) tx=${rc.hash}`);
  });

task("obol:get_price", "Gets the last price from oracle").setAction(async (args, hre) => {
  const oracle = await getOracle(hre, args.oracle ? String(args.oracle) : undefined);
  const price6 = await oracle.price6();
  const timestamp = await oracle.epoch();
  const date = new Date(Number(timestamp) * 1000); // *1000 to put it back in milliseconds
  console.log(`Oracle price ${hre.ethers.formatUnits(price6, 6)} USD, last update on ${date.toLocaleString()}`);
});

task("obol:set_rates", "Set borrow/supply APR (per year, 1e6) on both markets")
  .addParam("borrow", "Borrow APR (1e6)", undefined, types.int)
  .addParam("supply", "Supply APR (1e6)", undefined, types.int)
  .setAction(async (args, hre) => {
    const { borrow, supply } = args as { borrow: number; supply: number };
    const m1 = await getMarket(hre, "EURtoUSD");
    const m2 = await getMarket(hre, "USDtoEUR");

    let tx = await m1.setRates(borrow, supply);
    let rc = await tx.wait();
    if (!rc?.status) throw new Error("setRates m1 failed");
    console.log(`m1 rates set -> borrow=${borrow} supply=${supply} tx=${rc.hash}`);

    tx = await m2.setRates(borrow, supply);
    rc = await tx.wait();
    if (!rc?.status) throw new Error("setRates m2 failed");
    console.log(`m2 rates set -> borrow=${borrow} supply=${supply} tx=${rc.hash}`);
  });

task("obol:get_rates", "Gets the borrow/supply rates from markets").setAction(async (args, hre) => {
  const m1 = await getMarket(hre, "EURtoUSD");
  const m2 = await getMarket(hre, "USDtoEUR");

  //those APRs have 6 decimals, to get % we can format with 4
  const m1Borrow = hre.ethers.formatUnits(await m1.borrowApr6(), 4);
  const m1Supply = hre.ethers.formatUnits(await m1.supplyApr6(), 4);

  const m2Borrow = hre.ethers.formatUnits(await m2.borrowApr6(), 4);
  const m2Supply = hre.ethers.formatUnits(await m2.supplyApr6(), 4);

  console.log(`Market 1 (EURtoUSD - ${await m1.getAddress()}) rates : \nborrow = ${m1Borrow}%, supply = ${m1Supply}%`);
  console.log(`Market 2 (USDtoEUR - ${await m2.getAddress()}) rates : \nborrow = ${m2Borrow}%, supply = ${m2Supply}%`);
});

task("obol:add_collat", "Add collateral on a market")
  .addParam("market", "Which market: EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("amount", "Human units amount", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    // set operator on collateral token for market
    const collatAddr: string = await market.collatTokenAddress();
    const tok = await getToken(hre, collatAddr, signer);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + (readCfg().OPERATOR_DEADLINE_SECS ?? 86400);
    if (!(await tok.isOperator(signer.address, await market.getAddress()))) {
      await (await tok.setOperator(await market.getAddress(), deadline)).wait();
    }

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const tx = await market["addCollateral(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("addCollateral failed");
    console.log(`addCollateral ok tx=${rc.hash}`);

    await waitForFactorResfresh(market);

    console.log("Market factors refreshed, done.");
  });

task("obol:remove_collat", "Remove collateral (clamped by safety)")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("amount", "Human units", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const tx = await market["removeCollateral(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("removeCollateral failed");
    console.log(`removeCollateral ok tx=${rc.hash}`);

    await waitForFactorResfresh(market);

    console.log("Market factors refreshed, done.");
  });

task("obol:deposit_debt", "Deposit the market's debt asset and mint oTokens (shares)")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("amount", "Human units to deposit", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    // need operator on the DEBT token
    const debtAddr: string = await market.debtTokenAddress();
    const debt = await getToken(hre, debtAddr, signer);
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + (readCfg().OPERATOR_DEADLINE_SECS ?? 86400);
    if (!(await debt.isOperator(signer.address, await market.getAddress()))) {
      await (await debt.setOperator(await market.getAddress(), deadline)).wait();
    }

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const tx = await market["depositDebtAsset(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("depositDebtAsset failed");
    console.log(`depositDebtAsset ok tx=${rc.hash}`);
  });

task("obol:withdraw_debt", "Redeem oTokens (shares) for underlying, up to liquidity")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("shares", "Shares to redeem (human units)", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const shares = BigInt(args.shares) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    // need operator on the oToken (market token) for the market contract itself
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + (readCfg().OPERATOR_DEADLINE_SECS ?? 86400);
    if (!(await market.isOperator(signer.address, await market.getAddress()))) {
      await (await market.setOperator(await market.getAddress(), deadline)).wait();
    }

    const e = await enc64For(hre, await market.getAddress(), signer.address, shares);
    const tx = await market["withdrawDebtAsset(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("withdrawDebtAsset failed");
    console.log(`withdrawDebtAsset ok tx=${rc.hash}`);
  });

task("obol:borrow", "Borrow from a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("amount", "Human units", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const tx = await market["borrow(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("borrow failed");
    console.log(`borrow ok tx=${rc.hash}`);

    await waitForFactorResfresh(market);
    console.log("Market factors refreshed, done.");
  });

task("obol:max_borrow", "Compute and decrypt your max borrow on a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers, fhevm } = hre;
    const cfg = requireCfg();
    if (!cfg.TOKEN_USD || !cfg.TOKEN_EUR) throw new Error("Missing addresses in OBOL.json");
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    const debtTokenInterface =
      which === "EURtoUSD" ? await getToken(hre, cfg.TOKEN_USD, signer) : await getToken(hre, cfg.TOKEN_EUR, signer);

    const debtSymbol = await debtTokenInterface.symbol();

    const tx = await market.maxBorrow();
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("maxBorrow() call failed");

    await fhevm.initializeCLIApi();
    const userPos = await market.pos(signer.address);
    const eMax = userPos[8];
    const clear = await userDecrypt64(fhevm, eMax, await market.getAddress(), signer);
    console.log(`maxBorrow = ${ethers.formatUnits(clear.toString(), 6)} ${debtSymbol}`);
  });

task("obol:repay", "Repay debt")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("amount", "Human units", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();

    const debtAddr: string = await market.debtTokenAddress();
    const debtTok = await getToken(hre, debtAddr, signer);

    // market must be operator on debt token to pull repayment
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + (readCfg().OPERATOR_DEADLINE_SECS ?? 86400);
    if (!(await debtTok.isOperator(signer.address, await market.getAddress()))) {
      await (await debtTok.setOperator(await market.getAddress(), deadline)).wait();
    }

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const tx = await market["repay(bytes32,bytes)"](e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("repay failed");
    console.log(`repay ok tx=${rc.hash}`);

    await waitForFactorResfresh(market);

    console.log("Market factors refreshed, done.");
  });

task("obol:liquidate", "Liquidate a target user on a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("victim", "Target user address", undefined, types.string)
  .addParam("amount", "Repay (human units)", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const amt = BigInt(args.amount) * scalingFactor(6);
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();
    const victim = ethers.getAddress(String(args.victim));

    const debtAddr: string = await market.debtTokenAddress();
    const debtTok = await getToken(hre, debtAddr, signer);
    // operator on debt token to pull repay from liquidator
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest!.timestamp + (readCfg().OPERATOR_DEADLINE_SECS ?? 86400);
    if (!(await debtTok.isOperator(signer.address, await market.getAddress()))) {
      await (await debtTok.setOperator(await market.getAddress(), deadline)).wait();
    }

    const e = await enc64For(hre, await market.getAddress(), signer.address, amt);
    const ev = waitForLiquidationQueued(market);
    const tx = await market["liquidate(address,bytes32,bytes)"](victim, e.handles[0], e.inputProof);
    const rc = await tx.wait();
    if (!rc?.status) throw new Error("liquidate failed");
    console.log("Liquidate status :", rc.status);
    await ev;
    console.log(`liquidation queued tx=${rc.hash}`);
  });

task("obol:claim_liquidation", "Claim queued liquidation on a market.")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addParam("victim", "Target user address", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers, fhevm } = hre;
    const cfg = requireCfg();
    if (!cfg.TOKEN_USD || !cfg.TOKEN_EUR) throw new Error("Missing addresses in OBOL.json");
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();
    const victim = ethers.getAddress(String(args.victim));
    await fhevm.initializeCLIApi();

    const collatInterface =
      which === "EURtoUSD" ? await getToken(hre, cfg.TOKEN_EUR, signer) : await getToken(hre, cfg.TOKEN_USD, signer);

    const collatSymbol = await collatInterface.symbol();

    const eBalBefore = await collatInterface.confidentialBalanceOf(signer.address);
    const clearBalBefore = hre.ethers.formatUnits(
      await userDecrypt64(fhevm, eBalBefore, await collatInterface.getAddress(), signer),
      6,
    );

    const claimTx = await market.claimLiquidation(victim);
    const ev = waitForLiquidationClaimed(market);
    const cr = await claimTx.wait();
    if (!cr?.status) throw new Error("claimLiquidation failed");
    await ev;
    console.log(`claimed seized collateral tx=${cr.hash}`);

    const eBalAfter = await collatInterface.confidentialBalanceOf(signer.address);
    const clearBalAfter = hre.ethers.formatUnits(
      await userDecrypt64(fhevm, eBalAfter, await collatInterface.getAddress(), signer),
      6,
    );

    console.log(
      `${collatSymbol} balance before : ${clearBalBefore}\n${collatSymbol} balance after : ${clearBalAfter}\n${collatSymbol} Seized : ${Number(clearBalAfter) - Number(clearBalBefore)}`,
    );
  });

task("obol:pos", "Dump & decrypt your UserPos")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers, fhevm } = hre;
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const mkt = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();
    await fhevm.initializeCLIApi();

    const p = await mkt.pos(signer.address);
    const eCollat = p[0];
    const eDebt = p[1];
    const eMaxBorrow = p[8];

    let collat = "N/A",
      debt = "N/A",
      maxBorrow = "N/A";
    try {
      const c = await userDecrypt64(fhevm, eCollat, await mkt.getAddress(), signer);
      const d = await userDecrypt64(fhevm, eDebt, await mkt.getAddress(), signer);
      maxBorrow = hre.ethers.formatUnits(await userDecrypt64(fhevm, eMaxBorrow, await mkt.getAddress(), signer), 6);
      collat = hre.ethers.formatUnits(c, 6);
      debt = hre.ethers.formatUnits(d, 6);
    } catch {
      //
    }

    console.log(
      JSON.stringify(
        {
          eCollat_handle: eCollat,
          eDebt_handle: eDebt,
          A: p[2].toString(),
          B: p[3].toString(),
          posEpoch: Number(p[4]),
          userBorrowIndex6: p[5].toString(),
          secret_set: !!p[6],
          updatePending: p[7],
          maxBorrow_handle: eMaxBorrow,
          decrypted: { collat, debt, maxBorrow },
        },
        null,
        2,
      ),
    );
  });

task("obol:hf", "Compute public health factor and liquidatability for caller on a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const market = await getMarket(hre, which);
    const [signer] = await hre.ethers.getSigners();

    const p = await market.pos(signer.address);
    const A: bigint = p[2]; // already s * collat * LT (public)
    const B: bigint = p[3]; // s * debt (public)
    const userBorrowIndex6: bigint = p[5];
    const borrowIndex6: bigint = await market.borrowIndex6();
    const LT: bigint = await market.LT_collat6(); // 1e6
    const HYST_BPS: bigint = await market.HYST_BPS(); // bps (1e4)
    const direction: bigint = await market.direction();

    const oracle = await hre.ethers.getContractAt("ObolPriceOracle", await market.oracle(), signer);
    const rawPrice6: bigint = await oracle.price6(); // USD/EUR (1e6)

    // effective price: collat per 1 debt (1e6)
    const price6: bigint =
      direction === 0n
        ? (1_000_000_000_000n + rawPrice6 - 1n) / rawPrice6 // ceil(1e12 / raw)
        : rawPrice6;

    const userIdx: bigint = userBorrowIndex6 === 0n ? borrowIndex6 : userBorrowIndex6;
    const idxRatio6: bigint = (borrowIndex6 * 1_000_000n) / userIdx; // 1e6

    // rhs is 1e6-scaled (B * price * idxRatio / 1e12)
    const rhs: bigint = (((B * price6) / 1_000_000n) * idxRatio6) / 1_000_000n;

    // Raw HF used by your current print (A already has LT in it)
    const hfScaled6: bigint = rhs === 0n ? 2_000_000n : A / rhs; // 1e6-scaled

    // Threshold actually used on-chain: LT * (1 + HYST_BPS/1e4)
    const threshold6: bigint = (LT * (10_000n + HYST_BPS)) / 10_000n; // 1e6-scaled

    // “Normalized” HF (divide out LT) so 1.0 means threshold at HYST=0
    const hfNormalized6: bigint = LT === 0n ? hfScaled6 : (hfScaled6 * 1_000_000n) / LT;

    const liquidatable = A < (rhs * LT * (10_000n + HYST_BPS)) / 10_000n;

    const f = hre.ethers.formatUnits;
    console.log(
      [
        `HF_raw          = ${f(hfScaled6, 6)}  (compared to threshold ${f(threshold6, 6)})`,
        `HF_normalized   = ${f(hfNormalized6, 6)}  (vs 1.0 if HYST=0)`,
        `LT              = ${f(LT, 6)}  | HYST = ${HYST_BPS} bps`,
        `price_eff       = ${f(price6, 6)} collat per 1 debt`,
        `liquidatable    = ${liquidatable}`,
      ].join("\n"),
    );
  });

task("obol:is_liq", "Check isLiquidatablePublic(user)")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addOptionalParam("user", "User address (defaults to caller)", undefined, types.string)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const mkt = await getMarket(hre, which);
    const [signer] = await ethers.getSigners();
    const who = args.user ? ethers.getAddress(String(args.user)) : signer.address;
    const flag = await mkt.isLiquidatablePublic(who);
    console.log(`isLiquidatablePublic(${who}) = ${flag}`);
  });

task("obol:seize_rate", "Show liquidation seize rate (collat per 1 repaid debt, 1e6) + bonus bps")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const mkt = await getMarket(hre, which);
    const [signer] = await hre.ethers.getSigners();
    const oracle = await hre.ethers.getContractAt("ObolPriceOracle", await mkt.oracle(), signer);

    const perUnit6: bigint = await mkt.liquidationSeizePerUnit6();
    const raw = await oracle.price6();
    const dir: bigint = await mkt.direction();
    const price6: bigint = dir === 0n ? (1_000_000_000_000n + BigInt(raw) - 1n) / BigInt(raw) : BigInt(raw);
    const bonusBps = price6 === 0n ? 0n : (BigInt(perUnit6) * 10_000n) / price6 - 10_000n;

    console.log(`seizePerUnit6=${perUnit6}  (~${hre.ethers.formatUnits(perUnit6, 6)})  bonus≈${bonusBps} bps`);
  });

task("obol:price_effective", "Show market's effective price (collat per 1 debt, 1e6)")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const mkt = await getMarket(hre, which);
    const [signer] = await hre.ethers.getSigners();
    const oracle = await hre.ethers.getContractAt("ObolPriceOracle", await mkt.oracle(), signer);
    const raw = await oracle.price6();
    const dir: bigint = await mkt.direction();
    const price6: bigint = dir === 0n ? (1_000_000_000_000n + BigInt(raw) - 1n) / BigInt(raw) : BigInt(raw);
    console.log(`effectivePrice6 = ${price6}  (~${hre.ethers.formatUnits(price6, 6)} collat per 1 debt)`);
  });

task("obol:update_indexes", "Accrue indices on both markets").setAction(async (_args, hre) => {
  const m1 = await getMarket(hre, "EURtoUSD");
  const m2 = await getMarket(hre, "USDtoEUR");
  let tx = await m1.updateIndexes();
  let rc = await tx.wait();
  if (!rc?.status) throw new Error("updateIndexes m1 failed");
  tx = await m2.updateIndexes();
  rc = await tx.wait();
  if (!rc?.status) throw new Error("updateIndexes m2 failed");
  console.log("Indexes accrued on both markets.");
});

task("obol:active_count", "Show number of active borrowers on a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const mkt = await getMarket(hre, which);
    const n: bigint = await mkt.totalActiveBorrowers();
    console.log(`Active borrowers on ${which} (${await mkt.getAddress()}): ${n.toString()}`);
  });

task("obol:active_list", "List a page of active borrowers (addresses) on a market")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addOptionalParam("offset", "Start index (default 0)", 0, types.int)
  .addOptionalParam("limit", "Max results (default 50)", 50, types.int)
  .addFlag("json", "Print JSON instead of lines")
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 50);
    const mkt = await getMarket(hre, which);

    const total: bigint = await mkt.totalActiveBorrowers();
    const list: string[] = await mkt.getActiveBorrowers(offset, limit);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            market: which,
            marketAddress: await mkt.getAddress(),
            total: total.toString(),
            offset,
            limit: list.length,
            borrowers: list,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `Active borrowers on ${which} (${await mkt.getAddress()}) total=${total.toString()} | showing ${list.length} from offset=${offset}`,
    );
    list.forEach((addr, i) => console.log(`${offset + i}: ${addr}`));
  });

task("obol:liquidatable", "Get a page of active borrowers and whether each is liquidatable")
  .addParam("market", "EURtoUSD | USDtoEUR", undefined, types.string)
  .addOptionalParam("offset", "Start index (default 0)", 0, types.int)
  .addOptionalParam("limit", "Max results (default 50)", 50, types.int)
  .addFlag("onlytrue", "Only print addresses currently liquidatable")
  .addFlag("json", "Print JSON instead of lines")
  .setAction(async (args, hre) => {
    const which = String(args.market) as "EURtoUSD" | "USDtoEUR";
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 50);
    const mkt = await getMarket(hre, which);

    const total: bigint = await mkt.totalActiveBorrowers();
    const [addrs, flags]: [string[], boolean[]] = await mkt.getLiquidatableSlice(offset, limit);

    if (args.json) {
      const rows = addrs.map((a, i) => ({ address: a, liquidatable: flags[i] }));
      console.log(
        JSON.stringify(
          {
            market: which,
            marketAddress: await mkt.getAddress(),
            total: total.toString(),
            offset,
            limit: addrs.length,
            results: args.onlytrue ? rows.filter((r) => r.liquidatable) : rows,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `Liquidatable slice on ${which} (${await mkt.getAddress()}) total=${total.toString()} | showing ${addrs.length} from offset=${offset}`,
    );
    for (let i = 0; i < addrs.length; i++) {
      if (args.onlytrue && !flags[i]) continue;
      console.log(`${offset + i}: ${addrs[i]}  | liquidatable=${flags[i]}`);
    }
  });
