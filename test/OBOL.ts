import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("OBOL Tests", function () {
  before(async function () {
    this.signers = await ethers.getSigners();
    this.provider = ethers.provider;
    this.decimals = BigInt(10) ** BigInt(6);
    await fhevm.initializeCLIApi();
  });

  let log_str = "";

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

  it("Should deploy Obol price oracle", async function () {
    const oracleFactory = await ethers.getContractFactory("ObolPriceOracle", this.signers[0]);
    const oracleInstance = await oracleFactory.deploy(this.signers[0], 30 * 60);
    await oracleInstance.waitForDeployment();

    this.oracle = oracleInstance;

    log_str = "Oracle address : " + (await oracleInstance.getAddress());
    log(log_str, "deploy oracle");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await oracleInstance.getAddress()).to.be.properAddress;

    //let's say our current cammPair reserves (USD-EUR) are 100k - 90k with USD = token0
    //1111111 -> 1.11
    const fakePriceEURUSD = (BigInt(100_000) * this.decimals) / BigInt(90_000);

    const setPriceTx = await oracleInstance.setPrice(fakePriceEURUSD, 1);
    const setPriceRec = await setPriceTx.wait();
    expect(setPriceRec?.status).to.equal(1);

    const priceFromOracle = await oracleInstance.price6();

    log_str = "Fake price : " + ethers.formatUnits(priceFromOracle.toString(), 6) + " USD per 1 EUR (USD/EUR).";
    log(log_str, "deploy oracle");
  });

  it("Should deploy lending markets.", async function () {
    const Direction = {
      EURtoUSD: 0,
      USDtoEUR: 1,
    } as const;

    const usdAddr = await this.token1.getAddress();
    const eurAddr = await this.token2.getAddress();
    const oracleAddr = await this.oracle.getAddress();

    const oDebtName1 = "oUSD";
    const odebtTicker1 = "oUSD";

    const ConfLendMarket = await ethers.getContractFactory("ConfLendMarket", this.signers[0]);
    const market1 = await ConfLendMarket.deploy(
      Direction.EURtoUSD,
      eurAddr, // _collat
      usdAddr, // _debt
      oDebtName1, // _oDebtName
      odebtTicker1, // _oDebtTicker
      oracleAddr, // _oracle
      this.signers[0].address, // _rateRelayer
    );
    await market1.waitForDeployment();

    log_str = "Lending Market 1 address : " + (await market1.getAddress());
    log(log_str, "deploy markets");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await market1.getAddress()).to.be.properAddress;

    const oDebtName2 = "oEUR";
    const odebtTicker2 = "oEUR";

    const market2 = await ConfLendMarket.deploy(
      Direction.USDtoEUR,
      usdAddr, // _collat
      eurAddr, // _debt
      oDebtName2, // _oDebtName
      odebtTicker2, // _oDebtTicker
      oracleAddr, // _oracle
      this.signers[0].address, // _rateRelayer
    );
    await market2.waitForDeployment();

    log_str = "Lending Market 2 address : " + (await market2.getAddress());
    log(log_str, "deploy markets");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await market2.getAddress()).to.be.properAddress;

    const borrowAPR = 50_000; // => 5% APR
    const supplyAPR = 30_000; // => 3% APR

    const setRatesTx1 = await market1.setRates(borrowAPR, supplyAPR);
    const setRatesRec1 = await setRatesTx1.wait();
    expect(setRatesRec1?.status).to.equal(1);

    const setRatesTx2 = await market2.setRates(borrowAPR, supplyAPR);
    const setRatesRec2 = await setRatesTx2.wait();
    expect(setRatesRec2?.status).to.equal(1);

    const borrowAPR1 = await market1.borrowApr6();
    const supplyAPR1 = await market1.supplyApr6();

    const borrowAPR2 = await market2.borrowApr6();
    const supplyAPR2 = await market2.supplyApr6();

    log_str =
      "Lending Market 1 Borrow and Supply APR : " +
      ethers.formatUnits(borrowAPR1.toString(), 4) +
      "% " +
      ethers.formatUnits(supplyAPR1.toString(), 4) +
      "%";
    log(log_str, "deploy markets");

    log_str =
      "Lending Market 2 Borrow and Supply APR : " +
      ethers.formatUnits(borrowAPR2.toString(), 4) +
      "% " +
      ethers.formatUnits(supplyAPR2.toString(), 4) +
      "%";
    log(log_str, "deploy markets");

    this.market1 = market1;
    this.market2 = market2;
  });

  it("Should deposit debt asset on Obol markets", async function () {
    const token1 = this.token1; //USD
    const token2 = this.token2; //EUR
    const market1 = this.market1; //EUR Debt -> USD borrowed --> oEUR
    const market2 = this.market2; //USD Debt -> EUR borrowed --> oUSD

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const setOpTx1 = await token1.setOperator(await market1.getAddress(), targetTimestamp);
    const setOpRec1 = await setOpTx1.wait();
    expect(setOpRec1.status).to.equal(1);

    const setOpTx2 = await token2.setOperator(await market2.getAddress(), targetTimestamp);
    const setOpRec2 = await setOpTx2.wait();
    expect(setOpRec2.status).to.equal(1);

    const debtDepInp1 = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eDebtDepInp1 = await debtDepInp1.add64(BigInt(50000) * this.decimals).encrypt();

    const debtDepTx1 = await market1["depositDebtAsset(bytes32,bytes)"](
      eDebtDepInp1.handles[0],
      eDebtDepInp1.inputProof,
    );
    const debtDepRec1 = await debtDepTx1.wait();
    expect(debtDepRec1?.status).to.equal(1);

    const debtDepInp2 = fhevm.createEncryptedInput(await market2.getAddress(), this.signers[0].address);
    const eDebtDepInp2 = await debtDepInp2.add64(BigInt(50000) * this.decimals).encrypt();

    const debtDepTx2 = await market2["depositDebtAsset(bytes32,bytes)"](
      eDebtDepInp2.handles[0],
      eDebtDepInp2.inputProof,
    );
    const debtDepRec2 = await debtDepTx2.wait();
    expect(debtDepRec2?.status).to.equal(1);

    const eDebtBal1 = await market1.confidentialBalanceOf(this.signers[0]);
    const eDebtBal2 = await market2.confidentialBalanceOf(this.signers[0]);

    const debtBal1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eDebtBal1,
      await market1.getAddress(),
      this.signers[0],
    );

    const debtBal2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eDebtBal2,
      await market2.getAddress(),
      this.signers[0],
    );

    log_str = `oEUR Balance after deposit (debt asset deposited on market1) : ${ethers.formatUnits(debtBal1.toString(), 6)}`;
    log(log_str, "deposit debt assets");

    log_str = `oUSD Balance after deposit (debt asset deposited on market2) : ${ethers.formatUnits(debtBal2.toString(), 6)}`;
    log(log_str, "deposit debt assets");
  });

  it("Should deposit collat asset on Obol markets", async function () {
    const token1 = this.token1; //USD
    const token2 = this.token2; //EUR
    const market1 = this.market1; //EUR collat -> USD borrowed
    const market2 = this.market2; //USD collat -> EUR borrowed

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const setOpTx1 = await token2.setOperator(await market1.getAddress(), targetTimestamp);
    const setOpRec1 = await setOpTx1.wait();
    expect(setOpRec1.status).to.equal(1);

    const setOpTx2 = await token1.setOperator(await market2.getAddress(), targetTimestamp);
    const setOpRec2 = await setOpTx2.wait();
    expect(setOpRec2.status).to.equal(1);

    const collatDepInp1 = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eCollatDepInp1 = await collatDepInp1.add64(BigInt(10000) * this.decimals).encrypt();

    const eventPromise1 = pollSpecificEvent(market1, "marketFactorsRefreshed", "add collateral");

    const collatDepTx1 = await market1["addCollateral(bytes32,bytes)"](
      eCollatDepInp1.handles[0],
      eCollatDepInp1.inputProof,
    );
    const collatDepRec1 = await collatDepTx1.wait();
    expect(collatDepRec1?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    await eventPromise1;

    const userPos1 = await market1.pos(this.signers[0].address);
    const userA1 = userPos1[2];
    const userB1 = userPos1[3];

    log_str = `User A&B Factors on market 1 : ${userA1}, ${userB1}`;
    log(log_str, "add collateral");

    const collatDepInp2 = fhevm.createEncryptedInput(await market2.getAddress(), this.signers[0].address);
    const eCollatDepInp2 = await collatDepInp2.add64(BigInt(10000) * this.decimals).encrypt();

    const eventPromise2 = pollSpecificEvent(market2, "marketFactorsRefreshed", "add collateral");

    const collatDepTx2 = await market2["addCollateral(bytes32,bytes)"](
      eCollatDepInp2.handles[0],
      eCollatDepInp2.inputProof,
    );
    const collatDepRec2 = await collatDepTx2.wait();
    expect(collatDepRec2?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    await eventPromise2;

    const userPos2 = await market2.pos(this.signers[0].address);
    const userA2 = userPos2[2];
    const userB2 = userPos2[3];

    log_str = `User A&B Factors on market 2 : ${userA2}, ${userB2}`;
    log(log_str, "add collateral");
  });

  it("Should try to remove some collat", async function () {
    const market1 = this.market1; //EUR collat -> USD borrowed
    const market2 = this.market2; //USD collat -> EUR borrowed

    const collatRemInp1 = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eCollatRemInp1 = await collatRemInp1.add64(BigInt(910) * this.decimals).encrypt();

    const collatRemTx1 = await market1["removeCollateral(bytes32,bytes)"](
      eCollatRemInp1.handles[0],
      eCollatRemInp1.inputProof,
    );
    const collatRemRec1 = await collatRemTx1.wait();
    expect(collatRemRec1?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    const userPos1 = await market1.pos(this.signers[0].address);
    const eCollatBal1 = userPos1[0];

    const clearCollatBal1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eCollatBal1,
      await market1.getAddress(),
      this.signers[0],
    );

    log_str = `Decrypted collat position on market 1 : ${ethers.formatUnits(clearCollatBal1.toString(), 6)}`;
    log(log_str, "remove collateral");

    const collatRemInp2 = fhevm.createEncryptedInput(await market2.getAddress(), this.signers[0].address);
    const eCollatRemInp2 = await collatRemInp2.add64(BigInt(910) * this.decimals).encrypt();

    const collatRemTx2 = await market2["removeCollateral(bytes32,bytes)"](
      eCollatRemInp2.handles[0],
      eCollatRemInp2.inputProof,
    );
    const collatRemRec2 = await collatRemTx2.wait();
    expect(collatRemRec2?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    const userPos2 = await market2.pos(this.signers[0].address);
    const eCollatBal2 = userPos2[0];

    const clearCollatBal2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eCollatBal2,
      await market2.getAddress(),
      this.signers[0],
    );

    log_str = `Decrypted collat position on market 2: ${ethers.formatUnits(clearCollatBal2.toString(), 6)}`;
    log(log_str, "remove collateral");
  });

  it("Should borrow assets", async function () {
    const token1 = this.token1; //USD
    const token2 = this.token2; //EUR
    const market1 = this.market1; //EUR collat -> USD borrowed
    const market2 = this.market2; //USD collat -> EUR borrowed

    const eBalBefore1 = await token1.confidentialBalanceOf(this.signers[0]);
    const clearBalBefore1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eBalBefore1,
      await token1.getAddress(),
      this.signers[0],
    );

    //Update maxBorrow field from user field
    const maxBorrowTx1 = await market1.maxBorrow();
    const macBorrowRec1 = await maxBorrowTx1.wait();
    expect(macBorrowRec1.status).to.equal(1);

    //Retrieve and decrypt maxBorrow field
    const userMaxborrow1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      (await market1.pos(this.signers[0].address))[8],
      await market1.getAddress(),
      this.signers[0],
    );

    log(`Max borrow on market1 : ${ethers.formatUnits(userMaxborrow1, 6)} USD.`, "borrow asset");

    const borrowInp1 = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eBorrowInp1 = await borrowInp1.add64(BigInt(1000) * this.decimals).encrypt();

    const borrowTx1 = await market1["borrow(bytes32,bytes)"](eBorrowInp1.handles[0], eBorrowInp1.inputProof);
    const borrowRec1 = await borrowTx1.wait();
    expect(borrowRec1?.status).to.equal(1);

    const eBalAfter1 = await token1.confidentialBalanceOf(this.signers[0]);
    const clearBalAfter1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eBalAfter1,
      await token1.getAddress(),
      this.signers[0],
    );

    const borrowed = clearBalAfter1 - clearBalBefore1;

    log_str = `Borrowed : ${ethers.formatUnits(borrowed.toString(), 6)} USD from market 1.`;
    log(log_str, "borrow asset");

    const userPos1 = await market1.pos(this.signers[0].address);
    const eDebtBal1 = userPos1[1];

    const clearDebtBal1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eDebtBal1,
      await market1.getAddress(),
      this.signers[0],
    );

    log_str = `Decrypted debt position on market 1 : ${ethers.formatUnits(clearDebtBal1.toString(), 6)}`;
    log(log_str, "borrow asset");

    await fhevm.awaitDecryptionOracle();

    const userPosAfter = await market1.pos(this.signers[0].address);
    const userA1 = userPosAfter[2];
    const userB1 = userPosAfter[3];

    log_str = `User A&B Factors on market 1 : ${userA1}, ${userB1}`;
    log(log_str, "borrow asset");

    const hfBundle1 = await computeHealthFactor(
      this.market1,
      this.oracle,
      this.signers[0].address,
      100, // 1% hysteresis
    );

    log_str = `Market 1 HF=${hfBundle1.hfFloat}, healthy=${hfBundle1.healthy}`;
    log(log_str, "borrow asset");

    const eBalBefore2 = await token2.confidentialBalanceOf(this.signers[0]);
    const clearBalBefore2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eBalBefore2,
      await token2.getAddress(),
      this.signers[0],
    );

    //Update maxBorrow field from user field
    const maxBorrowTx2 = await market2.maxBorrow();
    const macBorrowRec2 = await maxBorrowTx2.wait();
    expect(macBorrowRec2.status).to.equal(1);

    //Retrieve and decrypt maxBorrow field
    const userMaxborrow2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      (await market2.pos(this.signers[0].address))[8],
      await market2.getAddress(),
      this.signers[0],
    );

    log(`Max borrow on market2 : ${ethers.formatUnits(userMaxborrow2, 6)} EUR.`, "borrow asset");

    const borrowInp2 = fhevm.createEncryptedInput(await market2.getAddress(), this.signers[0].address);
    const eBorrowInp2 = await borrowInp2.add64(BigInt(1000) * this.decimals).encrypt();

    const borrowTx2 = await market2["borrow(bytes32,bytes)"](eBorrowInp2.handles[0], eBorrowInp2.inputProof);
    const borrowRec2 = await borrowTx2.wait();
    expect(borrowRec2?.status).to.equal(1);

    const eBalAfter2 = await token2.confidentialBalanceOf(this.signers[0]);
    const clearBalAfter2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eBalAfter2,
      await token2.getAddress(),
      this.signers[0],
    );

    const borrowed2 = clearBalAfter2 - clearBalBefore2;

    log_str = `Borrowed : ${ethers.formatUnits(borrowed2.toString(), 6)} EUR from market 2.`;
    log(log_str, "borrow asset");

    const userPos2 = await market2.pos(this.signers[0].address);
    const eDebtBal2 = userPos2[1];

    const clearDebtBal2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eDebtBal2,
      await market2.getAddress(),
      this.signers[0],
    );

    log_str = `Decrypted debt position on market 2 : ${ethers.formatUnits(clearDebtBal2.toString(), 6)}`;
    log(log_str, "borrow asset");

    await fhevm.awaitDecryptionOracle();

    const userPosAfter2 = await market2.pos(this.signers[0].address);
    const userA2 = userPosAfter2[2];
    const userB2 = userPosAfter2[3];

    log_str = `User A&B Factors on market 2 : ${userA2}, ${userB2}`;
    log(log_str, "borrow asset");

    const hfBundle2 = await computeHealthFactor(
      this.market2,
      this.oracle,
      this.signers[0].address,
      100, // 1% hysteresis
    );

    log_str = `Market 1 HF=${hfBundle2.hfFloat}, healthy=${hfBundle2.healthy}`;
    log(log_str, "borrow asset");
  });

  it("Should retrieve active borrowers list", async function () {
    const market1 = this.market1; //EUR collat -> USD borrowed
    const market2 = this.market2; //USD collat -> EUR borrowed

    const aBorm1 = await market1.totalActiveBorrowers();
    const aBorm2 = await market2.totalActiveBorrowers();

    log_str = `Active borrowers on Market 1 : ${aBorm1}, Markent 2 : ${aBorm2}`;
    log(log_str, "retrieve active borrowers");

    const blist1 = await market1.getActiveBorrowers(0, aBorm1);
    const blist2 = await market2.getActiveBorrowers(0, aBorm2);

    log_str = `Active borrowers addresses on Market 1 : ${blist1}, Markent 2 : ${blist2}`;
    log(log_str, "retrieve active borrowers");
  });

  it("Should repay part of the debt on markets", async function () {
    const token1 = this.token1; //USD
    const token2 = this.token2; //EUR
    const market1 = this.market1; //EUR collat -> USD borrowed
    const market2 = this.market2; //USD collat -> EUR borrowed

    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const targetTimestamp = blockTimestamp + 100000000;

    const userPosBefore1 = await market1.pos(this.signers[0].address);
    const userDebtBefore1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      userPosBefore1[1],
      await market1.getAddress(),
      this.signers[0],
    );

    log_str = `Market 1 debt before repaying : ${ethers.formatUnits(userDebtBefore1.toString(), 6)} USD.`;
    log(log_str, "repay part of debt");

    const setOpTx1 = await token1.setOperator(await market1.getAddress(), targetTimestamp);
    const setOpRec1 = await setOpTx1.wait();
    expect(setOpRec1.status).to.equal(1);

    const repayInp1 = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eRepayInp1 = await repayInp1.add64(BigInt(500) * this.decimals).encrypt();

    const repayTx1 = await market1["repay(bytes32,bytes)"](eRepayInp1.handles[0], eRepayInp1.inputProof);
    const repayTxRec1 = await repayTx1.wait();
    expect(repayTxRec1?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    const userPosAfter1 = await market1.pos(this.signers[0].address);
    const userDebtAfter1 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      userPosAfter1[1],
      await market1.getAddress(),
      this.signers[0],
    );

    log_str = `Market 1 debt after repaying : ${ethers.formatUnits(userDebtAfter1.toString(), 6)} USD.`;
    log(log_str, "repay part of debt");

    const hfBundle1 = await computeHealthFactor(
      this.market1,
      this.oracle,
      this.signers[0].address,
      100, // 1% hysteresis
    );

    log_str = `Market 1 HF=${hfBundle1.hfFloat}, healthy=${hfBundle1.healthy}`;
    log(log_str, "repay part of debt");

    const userPosBefore2 = await market2.pos(this.signers[0].address);
    const userDebtBefore2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      userPosBefore2[1],
      await market2.getAddress(),
      this.signers[0],
    );

    log_str = `Market 2 debt before repaying : ${ethers.formatUnits(userDebtBefore2.toString(), 6)} EUR.`;
    log(log_str, "repay part of debt");

    const setOpTx2 = await token2.setOperator(await market2.getAddress(), targetTimestamp);
    const setOpRec2 = await setOpTx2.wait();
    expect(setOpRec2.status).to.equal(1);

    const repayInp2 = fhevm.createEncryptedInput(await market2.getAddress(), this.signers[0].address);
    const eRepayInp2 = await repayInp2.add64(BigInt(500) * this.decimals).encrypt();

    const repayTx2 = await market2["repay(bytes32,bytes)"](eRepayInp2.handles[0], eRepayInp2.inputProof);
    const repayTxRec2 = await repayTx2.wait();
    expect(repayTxRec2?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();

    const userPosAfter2 = await market2.pos(this.signers[0].address);
    const userDebtAfter2 = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      userPosAfter2[1],
      await market2.getAddress(),
      this.signers[0],
    );

    log_str = `Market 2 debt after repaying : ${ethers.formatUnits(userDebtAfter2.toString(), 6)} EUR.`;
    log(log_str, "repay part of debt");

    const hfBundle2 = await computeHealthFactor(
      this.market2,
      this.oracle,
      this.signers[0].address,
      100, // 1% hysteresis
    );

    log_str = `Market 2 HF=${hfBundle2.hfFloat}, healthy=${hfBundle2.healthy}`;
    log(log_str, "repay part of debt");
  });

  it("Should turn unhealthy after price drop and get liquidated (market1)", async function () {
    const token1 = this.token1; // USD
    const token2 = this.token2; // EUR
    const market1 = this.market1; // EUR collat -> USD debt
    const oracle = this.oracle;

    const collatRemInp = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eCollatRem = await collatRemInp.add64(BigInt(8500) * this.decimals).encrypt(); // remove 2,500 EUR

    const ev1 = pollSpecificEvent(market1, "marketFactorsRefreshed", "remove collateral (pre-drop)");
    const remTx = await market1["removeCollateral(bytes32,bytes)"](eCollatRem.handles[0], eCollatRem.inputProof);
    const remRec = await remTx.wait();
    expect(remRec?.status).to.equal(1);
    await fhevm.awaitDecryptionOracle();
    await ev1;

    const hfBeforeDrop = await computeHealthFactor(market1, oracle, this.signers[0].address, 100);
    log(`Before price drop: HF=${hfBeforeDrop.hfFloat}, healthy=${hfBeforeDrop.healthy}`, "liq scenario");

    const fakePriceDown1 = (BigInt(100_000) * this.decimals) / BigInt(120_000); // 0.83 USD / EUR
    const tx = await oracle.setPrice(fakePriceDown1, 2);
    const rc = await tx.wait();
    expect(rc?.status).to.equal(1);
    log(`Oracle moved to ${ethers.formatUnits(await oracle.price6(), 6)} USD/EUR`, "liq scenario");

    const hfAfterDrop = await computeHealthFactor(market1, oracle, this.signers[0].address, 0);
    log(`After drop #1: HF=${hfAfterDrop.hfFloat}, healthy=${hfAfterDrop.healthy}`, "liq scenario");

    const liqFlag = await market1.isLiquidatablePublic(this.signers[0].address);
    expect(liqFlag).to.equal(true);

    const block = await this.provider.getBlock("latest");
    const targetTs = block.timestamp + 100000000;
    const setOp = await token1.setOperator(await market1.getAddress(), targetTs);
    const setOpRec = await setOp.wait();
    expect(setOpRec.status).to.equal(1);

    const posBefore = await market1.pos(this.signers[0].address);
    const eDebtBefore = posBefore[1];
    const eCollatBefore = posBefore[0];
    const debtBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eDebtBefore,
      await market1.getAddress(),
      this.signers[0],
    );
    const collatBefore = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      eCollatBefore,
      await market1.getAddress(),
      this.signers[0],
    );
    log(
      `Before liq: debt=${ethers.formatUnits(debtBefore.toString(), 6)} USD, collat=${ethers.formatUnits(collatBefore.toString(), 6)} EUR`,
      "liq scenario",
    );

    const rawPrice6: bigint = await oracle.price6();
    const direction: bigint = await market1.direction();

    const price6: bigint = direction === 0n ? (1_000_000_000_000n + rawPrice6 - 1n) / rawPrice6 : rawPrice6;

    const perUnit6: bigint = await market1.liquidationSeizePerUnit6();
    const LT: bigint = await market1.LT_collat6();

    const borrowIdx: bigint = await market1.borrowIndex6();
    const userBorrowIndex6: bigint = posBefore[5];
    const userIdx: bigint = userBorrowIndex6 === 0n ? borrowIdx : userBorrowIndex6;
    const idxRatio6: bigint = (borrowIdx * 1_000_000n) / userIdx;

    const maxRepayByCollat: bigint = perUnit6 === 0n ? 0n : (collatBefore * 1_000_000n) / perUnit6;

    const plannedRepay = 1_000n * 1_000_000n;
    const licitRepayPlan = plannedRepay < debtBefore ? plannedRepay : debtBefore;

    const theoreticalSeize = (licitRepayPlan * perUnit6) / 1_000_000n;
    const finalSeizeCap = theoreticalSeize < collatBefore ? theoreticalSeize : collatBefore;

    const bonusBps = price6 === 0n ? 0n : (perUnit6 * 10_000n) / price6 - 10_000n;

    log(
      [
        `Pre-Liq Diagnostics:`,
        `\t\tprice6 (collat per 1 debt) = ${ethers.formatUnits(price6.toString(), 6)}`,
        `\t\tperUnit6 (with bonus)      = ${ethers.formatUnits(perUnit6.toString(), 6)}  (~bonus ${bonusBps} bps)`,
        `\t\tLT                          = ${ethers.formatUnits(LT.toString(), 6)}`,
        `\t\tborrowIndex6/userIdx       = ${borrowIdx}/${userIdx}  (idxRatio=${ethers.formatUnits(idxRatio6.toString(), 6)})`,
        `\t\tmaxRepayByCollat           = ${ethers.formatUnits(maxRepayByCollat.toString(), 6)} debt units`,
        `\t\tplannedRepay (clamped)     = ${ethers.formatUnits(licitRepayPlan.toString(), 6)} debt units`,
        `\t\ttheoreticalSeize           = ${ethers.formatUnits(theoreticalSeize.toString(), 6)} collat units`,
        `\t\tfinalSeize (cap by collat) = ${ethers.formatUnits(finalSeizeCap.toString(), 6)} collat units`,
      ].join("\n"),
      "liq scenario",
    );

    const liqPosList = await market1.getLiquidatableSlice(0, 10);
    log(`Liquidatable users list (from contract) : [[${liqPosList}]]`, "liq scenario");

    const liqBal1Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await token1.confidentialBalanceOf(this.signers[0].address),
      await token1.getAddress(),
      this.signers[0],
    );

    const liqBal2Before = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await token2.confidentialBalanceOf(this.signers[0].address),
      await token2.getAddress(),
      this.signers[0],
    );

    const repayInp = fhevm.createEncryptedInput(await market1.getAddress(), this.signers[0].address);
    const eRepay = await repayInp.add64(BigInt(1000) * this.decimals).encrypt();

    const ev2 = pollSpecificEvent(market1, "marketFactorsRefreshed", "liquidation refresh");
    const liqTx = await market1["liquidate(address,bytes32,bytes)"](
      this.signers[0].address,
      eRepay.handles[0],
      eRepay.inputProof,
    );
    const liqRec = await liqTx.wait();
    expect(liqRec?.status).to.equal(1);

    const claimLiqTx = await market1.claimLiquidation(this.signers[0].address);
    const claimLiqRec = await claimLiqTx.wait();
    expect(claimLiqRec?.status).to.equal(1);

    await fhevm.awaitDecryptionOracle();
    await ev2;

    // --- 5) Verify outcome: victim's debt & collateral decreased; health should improve ---
    const posAfter = await market1.pos(this.signers[0].address);
    const debtAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      posAfter[1],
      await market1.getAddress(),
      this.signers[0],
    );
    const collatAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      posAfter[0],
      await market1.getAddress(),
      this.signers[0],
    );

    log(
      `After liq: debt=${ethers.formatUnits(debtAfter.toString(), 6)} USD, collat=${ethers.formatUnits(collatAfter.toString(), 6)} EUR`,
      "liq scenario",
    );

    expect(debtAfter < debtBefore).to.equal(true);
    expect(collatAfter < collatBefore).to.equal(true);

    const hfPostLiq = await computeHealthFactor(market1, oracle, this.signers[0].address, 0);
    log(`Post-liq HF=${hfPostLiq.hfFloat}, healthy=${hfPostLiq.healthy}`, "liq scenario");

    const liqBal1After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await token1.confidentialBalanceOf(this.signers[0].address),
      await token1.getAddress(),
      this.signers[0],
    );

    const liqBal2After = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await token2.confidentialBalanceOf(this.signers[0].address),
      await token2.getAddress(),
      this.signers[0],
    );

    log(
      `Liquidator balance variation : ${ethers.formatUnits(liqBal1Before.toString(), 6)} -> ${ethers.formatUnits(liqBal1After.toString(), 6)} USD | ${ethers.formatUnits(liqBal2Before.toString(), 6)} -> ${ethers.formatUnits(liqBal2After.toString(), 6)} EUR`,
      "liq scenario",
    );
  });

  it("Lenders earn supply interest over ~1 year and redeem more underlying (oUSD & oEUR)", async function () {
    const { provider } = this;
    const lender = this.signers[0];
    const tokenUSD = this.token1; // debt token on market1
    const tokenEUR = this.token2; // debt token on market2
    const market1 = this.market1; // EUR collat -> USD debt -> oUSD
    const market2 = this.market2; // USD collat -> EUR debt -> oEUR
    const ONE_YEAR = 365 * 24 * 60 * 60;
    const dec = this.decimals;

    const fastForward = async (secs: number) => {
      await provider.send("evm_increaseTime", [secs]);
      await provider.send("evm_mine", []);
    };

    const nowBlk = await provider.getBlock("latest");
    const expiry = nowBlk.timestamp + 100000000;

    await (await tokenUSD.setOperator(await market1.getAddress(), expiry)).wait();
    await (await tokenEUR.setOperator(await market2.getAddress(), expiry)).wait();

    await (await market1.setOperator(await market1.getAddress(), expiry)).wait();
    await (await market2.setOperator(await market2.getAddress(), expiry)).wait();

    const depDebt1 = 20_000n * dec; // 20k USD into market1
    const depDebt2 = 30_000n * dec; // 30k EUR into market2

    const depInp1 = fhevm.createEncryptedInput(await market1.getAddress(), lender.address);
    const eDep1 = await depInp1.add64(depDebt1).encrypt();
    await (await market1["depositDebtAsset(bytes32,bytes)"](eDep1.handles[0], eDep1.inputProof)).wait();

    const depInp2 = fhevm.createEncryptedInput(await market2.getAddress(), lender.address);
    const eDep2 = await depInp2.add64(depDebt2).encrypt();
    await (await market2["depositDebtAsset(bytes32,bytes)"](eDep2.handles[0], eDep2.inputProof)).wait();

    const eShares1 = await market1.confidentialBalanceOf(lender);
    const eShares2 = await market2.confidentialBalanceOf(lender);
    const shares1 = await fhevm.userDecryptEuint(FhevmType.euint64, eShares1, await market1.getAddress(), lender);
    const shares2 = await fhevm.userDecryptEuint(FhevmType.euint64, eShares2, await market2.getAddress(), lender);

    {
      const collatInp = fhevm.createEncryptedInput(await market1.getAddress(), lender.address);
      const eCollat = await collatInp.add64(10_000n * dec).encrypt();
      await (await market1["addCollateral(bytes32,bytes)"](eCollat.handles[0], eCollat.inputProof)).wait();

      await fhevm.awaitDecryptionOracle();
      const brInp = fhevm.createEncryptedInput(await market1.getAddress(), lender.address);
      const eBr = await brInp.add64(2_000n * dec).encrypt(); // borrow 2k USD
      await (await market1["borrow(bytes32,bytes)"](eBr.handles[0], eBr.inputProof)).wait();
      await fhevm.awaitDecryptionOracle();
    }

    {
      const collatInp = fhevm.createEncryptedInput(await market2.getAddress(), lender.address);
      const eCollat = await collatInp.add64(10_000n * dec).encrypt();
      await (await market2["addCollateral(bytes32,bytes)"](eCollat.handles[0], eCollat.inputProof)).wait();

      await fhevm.awaitDecryptionOracle();

      const brInp = fhevm.createEncryptedInput(await market2.getAddress(), lender.address);
      const eBr = await brInp.add64(2_000n * dec).encrypt(); // borrow 2k EUR
      await (await market2["borrow(bytes32,bytes)"](eBr.handles[0], eBr.inputProof)).wait();

      await fhevm.awaitDecryptionOracle();
    }

    await fastForward(ONE_YEAR);

    //refresh price oracle
    const tx = await this.oracle.setPrice(await this.oracle.price6(), 3);
    const rc = await tx.wait();
    expect(rc?.status).to.equal(1);
    log(`Oracle moved to ${ethers.formatUnits(await this.oracle.price6(), 6)} USD/EUR`, "supply-interest");

    // Trigger accrual (updates supplyIndex6 and borrowIndex6)
    await (await market1.updateIndexes()).wait();
    await (await market2.updateIndexes()).wait();

    const supIdx1 = await market1.supplyIndex6(); // 1e6 scaled
    const supIdx2 = await market2.supplyIndex6();

    const repayAll = async (mkt: any, debtToken: any) => {
      const nowBlk = await provider.getBlock("latest");
      const expiry = nowBlk.timestamp + 100000000;

      const setOptx = await debtToken.setOperator(await mkt.getAddress(), expiry);
      await setOptx.wait();
      const OVERPAY = 10_000_000n * 1_000_000n; // 10M units in 1e6 scale
      const rInp = fhevm.createEncryptedInput(await mkt.getAddress(), lender.address);
      const eR = await rInp.add64(OVERPAY).encrypt();
      await (await mkt["repay(bytes32,bytes)"](eR.handles[0], eR.inputProof)).wait();
    };

    await repayAll(market1, tokenUSD);
    await repayAll(market2, tokenEUR);

    const redeemAllAndAssert = async (mkt: any, debtToken: any, shares: bigint, supplyIdx6: bigint, label: string) => {
      const oBalBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await mkt.confidentialBalanceOf(lender),
        await mkt.getAddress(),
        lender,
      );
      // Snapshot underlying balance before
      const eBalBefore = await debtToken.confidentialBalanceOf(lender);
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        eBalBefore,
        await debtToken.getAddress(),
        lender,
      );

      const nowBlk = await ethers.provider.getBlock("latest");
      const expiry = nowBlk.timestamp + 100000000;

      await (await mkt.setOperator(await mkt.getAddress(), expiry)).wait();

      const wInp = fhevm.createEncryptedInput(await mkt.getAddress(), lender.address);
      const eW = await wInp.add64(BigInt(69_000) * this.decimals).encrypt();
      await (await mkt["withdrawDebtAsset(bytes32,bytes)"](eW.handles[0], eW.inputProof)).wait();

      const oBalAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await mkt.confidentialBalanceOf(lender),
        await mkt.getAddress(),
        lender,
      );

      const eBalAfter = await debtToken.confidentialBalanceOf(lender);
      const balAfter = await fhevm.userDecryptEuint(FhevmType.euint64, eBalAfter, await debtToken.getAddress(), lender);

      const received = balAfter - balBefore; // underlying received from redeem

      const expected = (shares * BigInt(supplyIdx6.toString())) / 1_000_000n;
      const diff = received > expected ? received - expected : expected - received;
      log(
        `Balances debt: before = ${ethers.formatUnits(balBefore, 6)} after = ${ethers.formatUnits(balAfter, 6)} `,
        "supply-interest",
      );
      log(
        `Balances ${label}: before = ${ethers.formatUnits(oBalBefore, 6)} after = ${ethers.formatUnits(oBalAfter, 6)} `,
        "supply-interest",
      );
      log(
        `Redeem ${label}: expected=${ethers.formatUnits(expected, 6)} got=${ethers.formatUnits(received, 6)} (Δ=${diff})`,
        "supply-interest",
      );

      expect(diff > 0).to.equal(true);
    };

    await redeemAllAndAssert(market1, tokenUSD, shares1, supIdx1, "oUSD");
    await redeemAllAndAssert(market2, tokenEUR, shares2, supIdx2, "oEUR");
  });

  it("Accrues indices exactly per formula and emits Accrued", async function () {
    const { market1, provider } = this;
    const startBorrow = await market1.borrowIndex6();
    const startSupply = await market1.supplyIndex6();

    // 90 days
    await provider.send("evm_increaseTime", [90 * 24 * 60 * 60]);
    await provider.send("evm_mine", []);
    const tx = await market1.updateIndexes();
    const rc = await tx.wait();
    expect(rc?.status).to.eq(1);

    const bi = await market1.borrowIndex6();
    const si = await market1.supplyIndex6();

    const YEAR = 365n * 24n * 60n * 60n;
    const dt = 90n * 24n * 60n * 60n;
    const br = BigInt(await market1.borrowApr6()); // 1e6
    const sr = BigInt(await market1.supplyApr6()); // 1e6

    const expBorrow = BigInt(startBorrow) + (BigInt(startBorrow) * br * dt) / (1_000_000n * YEAR);
    const expSupply = BigInt(startSupply) + (BigInt(startSupply) * sr * dt) / (1_000_000n * YEAR);

    expect(BigInt(bi)).to.eq(expBorrow);
    expect(BigInt(si)).to.eq(expSupply);

    const receipt = await market1.queryFilter(market1.filters.Accrued());
    expect(receipt.length).to.be.greaterThan(0);
  });
});

const log = (message: string, scope: string) => {
  const log_str = `\t[DEBUG] (${scope}) : ${message}`;
  console.log(log_str);
};

async function computeHealthFactor(
  market: ethers.Contract,
  oracle: ethers.Contract,
  user: string,
  hystBps: number = 0,
): Promise<{ hfScaled6: bigint; hfFloat: string; thresholdScaled6: bigint; healthy: boolean }> {
  const userPos = await market.pos(user);
  const A: bigint = userPos[2];
  const B: bigint = userPos[3];
  const userBorrowIndex6: bigint = userPos[5];
  const borrowIndex6: bigint = await market.borrowIndex6();
  const LT = await market.LT_collat6();

  // price6 must be "collat per debt unit"
  const rawPrice6: bigint = await oracle.price6(); // USD/EUR (1e6)
  const direction: bigint = await market.direction();
  const price6: bigint =
    direction === 0n
      ? (1_000_000_000_000n + rawPrice6 - 1n) / rawPrice6 // EUR per USD (ceil)
      : rawPrice6; // EUR per USD already

  const userIdx: bigint = userBorrowIndex6 === 0n ? borrowIndex6 : userBorrowIndex6;
  const idxRatio6: bigint = (borrowIndex6 * 1_000_000n) / userIdx;

  // rhs is 1e6-scaled (times s); A is 1e12-scaled (times s) ⇒ A/rhs is 1e6-scaled HF
  const rhs: bigint = (((B * price6) / 1_000_000n) * idxRatio6) / 1_000_000n;

  if (rhs === 0n) {
    return {
      hfScaled6: 2n * 1_000_000n,
      hfFloat: "Infinity",
      thresholdScaled6: (LT * 10_000n) / (10_000n + BigInt(hystBps)),
      healthy: true,
    };
  }

  const hfScaled6: bigint = A / rhs; // <-- fixed (no extra * 1e6)
  const thresholdScaled6: bigint = (LT * 10_000n) / (10_000n + BigInt(hystBps));
  const healthy = hfScaled6 >= thresholdScaled6;

  return { hfScaled6, hfFloat: ethers.formatUnits(hfScaled6, 6), thresholdScaled6, healthy };
}

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
