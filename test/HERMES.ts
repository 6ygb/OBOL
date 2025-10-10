import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("HERMES Tests", function () {
  before(async function () {
    this.signers = await ethers.getSigners();
    this.provider = ethers.provider;
    this.decimals = BigInt(10) ** BigInt(6);
    await fhevm.initializeCLIApi();
  });

  let log_str = "";
  const typesMaker = {
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
  const typesTaker = {
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

  it("Should deploy 2 Tokens.", async function () {
    const TokenFactory = await ethers.getContractFactory("ConfidentialToken", this.signers[0]);
    const tokenContract1 = await TokenFactory.deploy("Us Dollar", "USD");
    await tokenContract1.waitForDeployment();
    const tokenContract2 = await TokenFactory.deploy("EURO", "EUR");
    await tokenContract2.waitForDeployment();
    this.token1 = tokenContract1;
    this.token2 = tokenContract2;

    log_str = "Token 1 contract address : " + (await tokenContract1.getAddress());
    log(log_str, "deploy test tokens");

    log_str = "Token 2 contract address : " + (await tokenContract2.getAddress());
    log(log_str, "deploy test tokens");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await tokenContract1.getAddress()).to.be.properAddress;
    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await tokenContract2.getAddress()).to.be.properAddress;
  });

  it("Should deploy HERMES Notary and OTC escrow contract.", async function () {
    const notaryFactory = await ethers.getContractFactory("HermesNotary", this.signers[0]);
    const notaryContract = await notaryFactory.deploy();
    this.notary = notaryContract;
    const notaryAddress = await notaryContract.getAddress();

    log_str = "Hermes notary contract address : " + notaryAddress;
    log(log_str, "deploy hermes notary & escrow contract");

    const escrowFactory = await ethers.getContractFactory("HermesOtcEscrow", this.signers[0]);
    const escrowContract = await escrowFactory.deploy(notaryAddress);
    this.escrow = escrowContract;

    await notaryContract.setEscrow(await escrowContract.getAddress());

    log_str = "Hermes escrow contract address : " + (await escrowContract.getAddress());
    log(log_str, "deploy hermes notary & escrow contract");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await escrowContract.getAddress()).to.be.properAddress;

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(notaryAddress).to.be.properAddress;
  });

  it("Should create a RFQ", async function () {
    const escrowContract = this.escrow;
    const token1 = this.token1;
    const token2 = this.token2;

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const createRFQInput = fhevm.createEncryptedInput(await escrowContract.getAddress(), this.signers[0].address);
    const encryptedCreateRFQInput = await createRFQInput
      .add64(BigInt(10_000) * this.decimals)
      .add64(BigInt(12_000) * this.decimals)
      .encrypt();

    const eventPromise = pollSpecificEvent(escrowContract, "RFQCreated", "create RFQ");

    const createRFQTx = await escrowContract["createRFQ(address,address,address,bytes32,bytes32,uint256,bytes)"](
      this.signers[0],
      await token1.getAddress(),
      await token2.getAddress(),
      encryptedCreateRFQInput.handles[0],
      encryptedCreateRFQInput.handles[1],
      targetTimestamp,
      encryptedCreateRFQInput.inputProof,
    );
    const createRFQReceipt = await createRFQTx.wait();
    expect(createRFQReceipt.status).to.equal(1);

    const eventResults = await eventPromise;
    const rfqID = eventResults[2];

    log_str = "Created RFQ ID : " + rfqID;
    log(log_str, "create RFQ");
    this.rfqID = rfqID;

    const rfqObject = await escrowContract.rfqs(rfqID);
    printRFQ(rfqObject, rfqID, "create RFQ");
  });

  it("Should make both parties agree on the current quote.", async function () {
    const escrowContract = this.escrow;
    const rfqID = this.rfqID;
    const token1 = this.token1;
    const token2 = this.token2;

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const setOperatorTx1 = await token1.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt1 = await setOperatorTx1.wait();
    expect(setOperatorReceipt1.status).to.equal(1);

    const setOperatorTx2 = await token2.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt2 = await setOperatorTx2.wait();
    expect(setOperatorReceipt2.status).to.equal(1);

    const rfq = await escrowContract.rfqs(rfqID);

    const domain = {
      name: "Hermes-OTC",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrowContract.getAddress(),
    };

    /**
    address maker;
    address taker;
    address tokenAddressIn;
    address tokenAddressOut;
    euint64 tokenAmountIn;
    euint64 tokenAmountOut;
    uint256 createdAt;
    uint256 expirationTimestamp;
    bool expired;
    bool canceled;
    bool filled;
    bool fundDeposited;
   */

    const maker: string = rfq[0];
    const taker: string = rfq[1];
    const tokenAddressIn: string = rfq[2];
    const tokenAddressOut: string = rfq[3];
    const ctAmountIn: string = rfq[4];
    const ctAmountOut: string = rfq[5];
    const creationTs = rfq[6];
    const expirationTs = rfq[7];

    const value = {
      rfqId: rfqID,
      maker: maker,
      taker: taker,
      tokenAddressIn: tokenAddressIn,
      tokenAddressOut: tokenAddressOut,
      amountIn: ctAmountIn,
      amountOut: ctAmountOut,
      createdAt: creationTs,
      expirationTimestamp: expirationTs,
    };

    const makerSig = await this.signers[0].signTypedData(domain, typesMaker, value);
    const takerSig = await this.signers[0].signTypedData(domain, typesTaker, value);

    log_str = "Maker sig : " + makerSig;
    log(log_str, "agree on quote");
    log_str = "Taker sig : " + takerSig;
    log(log_str, "agree on quote");

    const makerAgreeTx = await escrowContract.makerAgree(rfqID, makerSig);
    const makerAgreeReceipt = await makerAgreeTx.wait();
    expect(makerAgreeReceipt.status).to.equal(1);

    const takerAgreeTx = await escrowContract.takerAgree(rfqID, takerSig);
    const takerAgreeReceipt = await takerAgreeTx.wait();
    expect(takerAgreeReceipt.status).to.equal(1);

    //consent mask is a 2 bit variable. 01 = maker agreed, 10 = taker agreed, 11 = both agreed.
    //If consent mask is 3, the quote is validated and signed by both parties.
    const consentMask = await escrowContract.checkAgreementStatus(rfqID);
    log_str = "Consent mask : " + consentMask;
    log(log_str, "agree on quote");
    expect(consentMask).to.equal(3);
  });

  it("Should generate proof of deposit", async function () {
    const escrowContract = this.escrow;
    const rfqID = this.rfqID;

    const generatePodTx = await escrowContract.generatePoD(rfqID);
    const eventPromise = pollSpecificEvent(escrowContract, "ProofOfDeposit", "generate proof of deposit");

    const generatePodReceipt = await generatePodTx.wait();
    expect(generatePodReceipt.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();
    await eventPromise;

    const rfqObject = await escrowContract.rfqs(rfqID);
    printRFQ(rfqObject, rfqID, "generate proof of deposit");
  });

  it("Should settle the OTC trade", async function () {
    const escrowContract = this.escrow;
    const rfqID = this.rfqID;
    const token1 = this.token1;
    const token2 = this.token2;

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn before : " + clearBalance1Before;
    log(log_str, "OTC settlement");

    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut before : " + clearBalance2Before;
    log(log_str, "OTC settlement");

    const eventPromise = pollSpecificEvent(escrowContract, "OrderFulfilled", "OTC settlement");
    const settleTx = await escrowContract.settle(rfqID);

    const settleReceipt = await settleTx.wait();
    expect(settleReceipt.status).to.equal(1);

    await eventPromise;

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn before : " + clearBalance1After;
    log(log_str, "OTC settlement");

    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut before : " + clearBalance2After;
    log(log_str, "OTC settlement");

    const rfqObject = await escrowContract.rfqs(rfqID);
    printRFQ(rfqObject, rfqID, "OTC settlement");
  });

  it("Should retrieve settled otc trade info from notary contract", async function () {
    const rfqID = this.rfqID;
    const notaryContract = this.notary;

    const notaryStatusObject = await notaryContract.statusOf(rfqID);
    printNotaryStatus(notaryStatusObject, rfqID, "Notary info");

    const clearAmountIn = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[10],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Amount In : " + clearAmountIn;
    log(log_str, "Notary info");

    const clearAmountOut = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[11],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Amount Out : " + clearAmountOut;
    log(log_str, "Notary info");

    const clearMakerDeposit = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[12],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Maker Deposit : " + clearMakerDeposit;
    log(log_str, "Notary info");

    const clearTakerDeposit = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[13],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Taker deposit: " + clearTakerDeposit;
    log(log_str, "Notary info");

    const clearSentMaker = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[14],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Amount sent to Maker: " + clearSentMaker;
    log(log_str, "Notary info");

    const clearSentTaker = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      notaryStatusObject[15],
      await notaryContract.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Amount sent to Taker: " + clearSentTaker;
    log(log_str, "Notary info");
  });

  it("Should test rfq expiration", async function () {
    const escrowContract = this.escrow;
    const token1 = this.token1;
    const token2 = this.token2;

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 10;

    const createRFQInput = fhevm.createEncryptedInput(await escrowContract.getAddress(), this.signers[0].address);
    const encryptedCreateRFQInput = await createRFQInput
      .add64(BigInt(10_000) * this.decimals)
      .add64(BigInt(12_000) * this.decimals)
      .encrypt();

    const eventPromise = pollSpecificEvent(escrowContract, "RFQCreated", "create RFQ");

    const createRFQTx = await escrowContract["createRFQ(address,address,address,bytes32,bytes32,uint256,bytes)"](
      this.signers[0],
      await token1.getAddress(),
      await token2.getAddress(),
      encryptedCreateRFQInput.handles[0],
      encryptedCreateRFQInput.handles[1],
      targetTimestamp,
      encryptedCreateRFQInput.inputProof,
    );
    const createRFQReceipt = await createRFQTx.wait();
    expect(createRFQReceipt.status).to.equal(1);

    const eventResults = await eventPromise;
    const rfqID = eventResults[2];

    log_str = "Created RFQ ID : " + rfqID;
    log(log_str, "test expiration");
    this.rfqID = rfqID;

    const rfqObject = await escrowContract.rfqs(rfqID);
    printRFQ(rfqObject, rfqID, "test expiration");

    const domain = {
      name: "Hermes-OTC",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrowContract.getAddress(),
    };
    const setOperatorTx1 = await token1.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt1 = await setOperatorTx1.wait();
    expect(setOperatorReceipt1.status).to.equal(1);

    const rfq = await escrowContract.rfqs(rfqID);

    const maker: string = rfq[0];
    const taker: string = rfq[1];
    const tokenAddressIn: string = rfq[2];
    const tokenAddressOut: string = rfq[3];
    const ctAmountIn: string = rfq[4];
    const ctAmountOut: string = rfq[5];
    const creationTs = rfq[6];
    const expirationTs = rfq[7];

    const value = {
      rfqId: rfqID,
      maker: maker,
      taker: taker,
      tokenAddressIn: tokenAddressIn,
      tokenAddressOut: tokenAddressOut,
      amountIn: ctAmountIn,
      amountOut: ctAmountOut,
      createdAt: creationTs,
      expirationTimestamp: expirationTs,
    };

    const makerSig = await this.signers[0].signTypedData(domain, typesMaker, value);

    log_str = "Maker sig : " + makerSig;
    log(log_str, "test expiration");
    const eventPromise2 = pollSpecificEvent(escrowContract, "OrderExpired", "test expiration");
    await escrowContract.makerAgree(rfqID, makerSig);
    await eventPromise2;
  });

  it("Should test refund in case of canceling", async function () {
    const escrowContract = this.escrow;
    const token1 = this.token1;
    const token2 = this.token2;

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const createRFQInput = fhevm.createEncryptedInput(await escrowContract.getAddress(), this.signers[0].address);
    const encryptedCreateRFQInput = await createRFQInput
      .add64(BigInt(7_000) * this.decimals)
      .add64(BigInt(9_000) * this.decimals)
      .encrypt();

    const eventPromise = pollSpecificEvent(escrowContract, "RFQCreated", "create RFQ");

    const createRFQTx = await escrowContract["createRFQ(address,address,address,bytes32,bytes32,uint256,bytes)"](
      this.signers[0],
      await token1.getAddress(),
      await token2.getAddress(),
      encryptedCreateRFQInput.handles[0],
      encryptedCreateRFQInput.handles[1],
      targetTimestamp,
      encryptedCreateRFQInput.inputProof,
    );
    const createRFQReceipt = await createRFQTx.wait();
    expect(createRFQReceipt.status).to.equal(1);

    const eventResults = await eventPromise;
    const rfqID = eventResults[2];

    log_str = "Created RFQ ID : " + rfqID;
    log(log_str, "cancel/refund");

    const setOperatorTx1 = await token1.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt1 = await setOperatorTx1.wait();
    expect(setOperatorReceipt1.status).to.equal(1);

    const setOperatorTx2 = await token2.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt2 = await setOperatorTx2.wait();
    expect(setOperatorReceipt2.status).to.equal(1);

    const rfq = await escrowContract.rfqs(rfqID);

    const domain = {
      name: "Hermes-OTC",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrowContract.getAddress(),
    };

    const maker: string = rfq[0];
    const taker: string = rfq[1];
    const tokenAddressIn: string = rfq[2];
    const tokenAddressOut: string = rfq[3];
    const ctAmountIn: string = rfq[4];
    const ctAmountOut: string = rfq[5];
    const creationTs = rfq[6];
    const expirationTs = rfq[7];

    const value = {
      rfqId: rfqID,
      maker: maker,
      taker: taker,
      tokenAddressIn: tokenAddressIn,
      tokenAddressOut: tokenAddressOut,
      amountIn: ctAmountIn,
      amountOut: ctAmountOut,
      createdAt: creationTs,
      expirationTimestamp: expirationTs,
    };

    const makerSig = await this.signers[0].signTypedData(domain, typesMaker, value);
    const takerSig = await this.signers[0].signTypedData(domain, typesTaker, value);

    log_str = "Maker sig : " + makerSig;
    log(log_str, "cancel/refund");
    log_str = "Taker sig : " + takerSig;
    log(log_str, "cancel/refund");

    const makerAgreeTx = await escrowContract.makerAgree(rfqID, makerSig);
    const makerAgreeReceipt = await makerAgreeTx.wait();
    expect(makerAgreeReceipt.status).to.equal(1);

    const takerAgreeTx = await escrowContract.takerAgree(rfqID, takerSig);
    const takerAgreeReceipt = await takerAgreeTx.wait();
    expect(takerAgreeReceipt.status).to.equal(1);

    //consent mask is a 2 bit variable. 01 = maker agreed, 10 = taker agreed, 11 = both agreed.
    //If consent mask is 3, the quote is validated and signed by both parties.
    const consentMask = await escrowContract.checkAgreementStatus(rfqID);
    log_str = "Consent mask : " + consentMask;
    log(log_str, "cancel/refund");
    expect(consentMask).to.equal(3);

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn before refund : " + clearBalance1Before;
    log(log_str, "cancel/refund");

    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut before refund : " + clearBalance2Before;
    log(log_str, "cancel/refund");

    const cancelTx = await escrowContract.cancelRFQ(rfqID);
    const cancelReceipt = await cancelTx.wait();
    expect(cancelReceipt.status).to.equal(1);

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn after refund : " + clearBalance1After;
    log(log_str, "cancel/refund");

    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut after refund : " + clearBalance2After;
    log(log_str, "cancel/refund");
  });

  it("Should test refund in case of failing proof of deposit", async function () {
    const escrowContract = this.escrow;
    const token1 = this.token1;
    const token2 = this.token2;

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const createRFQInput = fhevm.createEncryptedInput(await escrowContract.getAddress(), this.signers[0].address);
    const encryptedCreateRFQInput = await createRFQInput
      .add64(BigInt(7_000) * this.decimals)
      .add64(BigInt(9_000) * this.decimals)
      .encrypt();

    const eventPromise = pollSpecificEvent(escrowContract, "RFQCreated", "create RFQ");

    const createRFQTx = await escrowContract["createRFQ(address,address,address,bytes32,bytes32,uint256,bytes)"](
      this.signers[0],
      await token1.getAddress(),
      await token2.getAddress(),
      encryptedCreateRFQInput.handles[0],
      encryptedCreateRFQInput.handles[1],
      targetTimestamp,
      encryptedCreateRFQInput.inputProof,
    );
    const createRFQReceipt = await createRFQTx.wait();
    expect(createRFQReceipt.status).to.equal(1);

    const eventResults = await eventPromise;
    const rfqID = eventResults[2];

    log_str = "Created RFQ ID : " + rfqID;
    log(log_str, "fail pod/refund");

    const setOperatorTx1 = await token1.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt1 = await setOperatorTx1.wait();
    expect(setOperatorReceipt1.status).to.equal(1);

    const setOperatorTx2 = await token2.setOperator(await escrowContract.getAddress(), targetTimestamp);
    const setOperatorReceipt2 = await setOperatorTx2.wait();
    expect(setOperatorReceipt2.status).to.equal(1);

    const transferInput = fhevm.createEncryptedInput(await token2.getAddress(), this.signers[0].address);
    const encryptedTransferInput = await transferInput.add64(BigInt(100_000) * this.decimals).encrypt();

    const transferTx = await token2["confidentialTransfer(address,bytes32,bytes)"](
      this.signers[1].address,
      encryptedTransferInput.handles[0],
      encryptedTransferInput.inputProof,
    );
    const transferReceipt = await transferTx.wait();
    expect(transferReceipt.status).to.equal(1);

    const rfq = await escrowContract.rfqs(rfqID);

    const domain = {
      name: "Hermes-OTC",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrowContract.getAddress(),
    };

    const maker: string = rfq[0];
    const taker: string = rfq[1];
    const tokenAddressIn: string = rfq[2];
    const tokenAddressOut: string = rfq[3];
    const ctAmountIn: string = rfq[4];
    const ctAmountOut: string = rfq[5];
    const creationTs = rfq[6];
    const expirationTs = rfq[7];

    const value = {
      rfqId: rfqID,
      maker: maker,
      taker: taker,
      tokenAddressIn: tokenAddressIn,
      tokenAddressOut: tokenAddressOut,
      amountIn: ctAmountIn,
      amountOut: ctAmountOut,
      createdAt: creationTs,
      expirationTimestamp: expirationTs,
    };

    const makerSig = await this.signers[0].signTypedData(domain, typesMaker, value);
    const takerSig = await this.signers[0].signTypedData(domain, typesTaker, value);

    log_str = "Maker sig : " + makerSig;
    log(log_str, "fail pod/refund");
    log_str = "Taker sig : " + takerSig;
    log(log_str, "fail pod/refund");

    const makerAgreeTx = await escrowContract.makerAgree(rfqID, makerSig);
    const makerAgreeReceipt = await makerAgreeTx.wait();
    expect(makerAgreeReceipt.status).to.equal(1);

    const takerAgreeTx = await escrowContract.takerAgree(rfqID, takerSig);
    const takerAgreeReceipt = await takerAgreeTx.wait();
    expect(takerAgreeReceipt.status).to.equal(1);

    //consent mask is a 2 bit variable. 01 = maker agreed, 10 = taker agreed, 11 = both agreed.
    //If consent mask is 3, the quote is validated and signed by both parties.
    const consentMask = await escrowContract.checkAgreementStatus(rfqID);
    log_str = "Consent mask : " + consentMask;
    log(log_str, "fail pod/refund");
    expect(consentMask).to.equal(3);

    const encryptedBalance1Before = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2Before = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1Before,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn before refund : " + clearBalance1Before;
    log(log_str, "fail pod/refund");

    const clearBalance2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2Before,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut before refund : " + clearBalance2Before;
    log(log_str, "fail pod/refund");

    const generatePodTx = await escrowContract.generatePoD(rfqID);
    const eventPromise2 = pollSpecificEvent(escrowContract, "OrderCanceled", "fail pod/refund");

    const generatePodReceipt = await generatePodTx.wait();
    expect(generatePodReceipt.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();
    await eventPromise2;

    const encryptedBalance1After = await token1.confidentialBalanceOf(this.signers[0].address);
    const encryptedBalance2After = await token2.confidentialBalanceOf(this.signers[0].address);

    const clearBalance1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance1After,
      await token1.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenIn after refund : " + clearBalance1After;
    log(log_str, "fail pod/refund");

    const clearBalance2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance2After,
      await token2.getAddress(),
      this.signers[0],
    );

    log_str = "Balance tokenOut after refund : " + clearBalance2After;
    log(log_str, "fail pod/refund");
  });
});

const printNotaryStatus = (notaryStatusObject: any, rfqID: string, scope: string) => {
  /*
    address maker;
    address taker;
    address tokenAddressIn;
    address tokenAddressOut;
    uint64 createdAt;
    uint256 expirationTimestamp;
    uint8 consentMask;
    bool canceled;
    bool expired;
    bool filled;
    euint64 amountIn;
    euint64 amountOut;
    euint64 makerDeposit;
    euint64 takerDeposit;
    euint64 amountSentMaker;
    euint64 amountSentTaker;
    bytes32 makerSigHash;
    bytes32 takerSigHash;
    bool fundDeposited;
    uint128 obfuscatedDeposits;
  */

  let display_str = `\t ------- [NOTARY ENTRY] ------- : \n`;

  display_str += "\t\t Id: " + rfqID + "\n";
  display_str += "\t\t Maker: " + notaryStatusObject[0] + "\n";
  display_str += "\t\t Taker: " + notaryStatusObject[1] + "\n";
  display_str += "\t\t Token In address: " + notaryStatusObject[2] + "\n";
  display_str += "\t\t Token Out address: " + notaryStatusObject[3] + "\n";
  display_str += "\t\t Creation timestamp: " + notaryStatusObject[4] + "\n";
  display_str += "\t\t Expiration timestamp: " + notaryStatusObject[5] + "\n";
  display_str += "\t\t Consent mask: " + notaryStatusObject[6] + "\n";
  display_str += "\t\t Is Canceled: " + notaryStatusObject[7] + "\n";
  display_str += "\t\t Is expired : " + notaryStatusObject[8] + "\n";
  display_str += "\t\t Is filled: " + notaryStatusObject[9] + "\n";
  display_str += "\t\t Encrypted Amount In handle: " + notaryStatusObject[10] + "\n";
  display_str += "\t\t Encrypted Amount Out handle: " + notaryStatusObject[11] + "\n";
  display_str += "\t\t Encrypted deposit In handle: " + notaryStatusObject[12] + "\n";
  display_str += "\t\t Encrypted deposit Out handle: " + notaryStatusObject[13] + "\n";
  display_str += "\t\t Encrypted Amount sent to maker handle: " + notaryStatusObject[14] + "\n";
  display_str += "\t\t Encrypted Amount sent to taker handle: " + notaryStatusObject[15] + "\n";
  display_str += "\t\t Maker signature hash: " + notaryStatusObject[16] + "\n";
  display_str += "\t\t Taker signature hash: " + notaryStatusObject[17] + "\n";
  display_str += "\t\t Are fund deposited: " + notaryStatusObject[18] + "\n";
  display_str += "\t\t Obfuscated deposit amount: " + notaryStatusObject[19] + "\n";

  log(display_str, scope);
};

const printRFQ = (rfqObject: any, rfqID: string, scope: string) => {
  /**
    address maker;
    address taker;
    address tokenAddressIn;
    address tokenAddressOut;
    euint64 tokenAmountIn;
    euint64 tokenAmountOut;
    uint256 createdAt;
    uint256 expirationTimestamp;
    bool expired;
    bool canceled;
    bool filled;
    bool fundDeposited;
   */
  let display_str = `\t ------- [RFQ] ------- : \n`;

  display_str += "\t\t Id: " + rfqID + "\n";
  display_str += "\t\t Maker: " + rfqObject[0] + "\n";
  display_str += "\t\t Taker: " + rfqObject[1] + "\n";
  display_str += "\t\t Token In address: " + rfqObject[2] + "\n";
  display_str += "\t\t Token Out address: " + rfqObject[3] + "\n";
  display_str += "\t\t Encrypted Amount In handle: " + rfqObject[4] + "\n";
  display_str += "\t\t Encrypted Amount Out handle: " + rfqObject[5] + "\n";
  display_str += "\t\t Creation timestamp: " + rfqObject[6] + "\n";
  display_str += "\t\t Expiration timestamp: " + rfqObject[7] + "\n";
  display_str += "\t\t Is expired : " + rfqObject[8] + "\n";
  display_str += "\t\t Is Canceled: " + rfqObject[9] + "\n";
  display_str += "\t\t Is filled: " + rfqObject[10] + "\n";
  display_str += "\t\t Are fund deposited: " + rfqObject[11] + "\n";

  log(display_str, scope);
};

const log = (message: string, scope: string) => {
  const log_str = `\t[DEBUG] (${scope}) : ${message}`;
  console.log(log_str);
};

/**
 * Polls for a specific event emitted by the contract, returning true if the event is emitted, otherwise false.
 * @param contract The ethers.js Contract instance.
 * @param eventName The name of the event to listen for.
 * @param pollInterval The interval in milliseconds to poll for new events.
 * @returns A Promise that resolves to true if the event was emitted, otherwise false.
 */
async function pollSpecificEvent(
  contract: ethers.Contract,
  eventName: string,
  scope: string,
  pollInterval: number = 5000,
): Promise<any> {
  let lastBlockNumber = await ethers.provider.getBlockNumber(); // Start from the latest block
  let log_str = "";

  return new Promise<any[]>((resolve) => {
    // Set a timeout to stop the polling after 40 seconds
    const timeout = setTimeout(() => {
      log_str = `Timeout: Event '${eventName}' was not emitted within 180 seconds`;
      log(log_str, scope);
      clearInterval(pollingInterval); // Stop polling
      resolve(null); // Resolve with null since the event was not emitted in the given time
    }, 40000);

    // Set an interval to poll for the specific event
    const pollingInterval = setInterval(async () => {
      try {
        const currentBlockNumber = await ethers.provider.getBlockNumber();

        if (currentBlockNumber > lastBlockNumber) {
          // Fetch all events emitted since the last polled block
          const logs = await ethers.provider.getLogs({
            address: contract.target,
            fromBlock: lastBlockNumber + 1, // Start from the block after the last checked one
            toBlock: currentBlockNumber,
          });

          const param_names = [];
          const param_values = [];

          // Iterate over logs and filter for the specified event
          for (const log_entry of logs) {
            const parsedLog = contract.interface.parseLog(log_entry);
            if (parsedLog && parsedLog.name === eventName) {
              parsedLog.fragment.inputs.forEach((value, index) => {
                param_names.push(value.name);
              });

              parsedLog.args.forEach((value, index) => {
                param_values.push(value);
              });

              let display_str = `Event triggered: ${parsedLog.name} \n`;

              for (let i = 0; i < param_names.length; i++) {
                if (param_names[i] != "") {
                  display_str += "\t\t" + param_names[i] + " = " + param_values[i] + "\n";
                }
              }

              log(display_str, scope);

              // Resolve the promise with the parameter values
              clearTimeout(timeout); // Clear the timeout
              clearInterval(pollingInterval); // Stop polling
              resolve(param_values); // Resolve with the parameter values
              return;
            }
          }

          // Update the last block number
          lastBlockNumber = currentBlockNumber;
        }
      } catch (error) {
        console.error("Error polling events:", error);
        clearTimeout(timeout); // Clear the timeout in case of error
        clearInterval(pollingInterval); // Stop polling in case of error
        resolve(null); // Resolve with null in case of an error
      }
    }, pollInterval);
  });
}
