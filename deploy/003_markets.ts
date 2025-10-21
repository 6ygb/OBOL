import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, get, getOrNull, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const signer = await ethers.getSigner(deployer);

  const eur = await get("TokenEUR");
  const usd = await get("TokenUSD");
  const oracle = await get("ObolPriceOracle");

  // Direction enum in contract:
  // 0 = EURtoUSD (collateral = EUR, debt = USD)
  // 1 = USDtoEUR (collateral = USD, debt = EUR)

  // Market #1 (EUR -> USD), keep oToken defaults from tests: "oUSD", "oUSD"
  let mkt1 = await getOrNull("ConfLendMarket_EURtoUSD");
  if (!mkt1) {
    mkt1 = await deploy("ConfLendMarket_EURtoUSD", {
      from: deployer,
      log: true,
      contract: "ConfLendMarket",
      args: [
        0, // Direction.EURtoUSD
        eur.address, // collateral (EUR)
        usd.address, // debt (USD)
        "oUSD", // oToken name
        "oUSD", // oToken symbol
        oracle.address, // oracle
        signer.address, // rateRelayer
      ],
    });
    log(`ConfLendMarket_EURtoUSD deployed at ${mkt1.address}`);
  } else {
    log(`ConfLendMarket_EURtoUSD already deployed at ${mkt1.address}`);
  }

  // Market #2 (USD -> EUR), keep oToken defaults from tests: "oEUR", "oEUR"
  let mkt2 = await getOrNull("ConfLendMarket_USDtoEUR");
  if (!mkt2) {
    mkt2 = await deploy("ConfLendMarket_USDtoEUR", {
      from: deployer,
      log: true,
      contract: "ConfLendMarket",
      args: [
        1, // Direction.USDtoEUR
        usd.address, // collateral (USD)
        eur.address, // debt (EUR)
        "oEUR", // oToken name
        "oEUR", // oToken symbol
        oracle.address, // oracle
        signer.address, // rateRelayer
      ],
    });
    log(`ConfLendMarket_USDtoEUR deployed at ${mkt2.address}`);
  } else {
    log(`ConfLendMarket_USDtoEUR already deployed at ${mkt2.address}`);
  }

  // NOTE: We intentionally do NOT set rates or oracle price here
  // to keep "deployment defaults" aligned with your contract & tests.
  // (Your tests set rates & price explicitly.)
};

export default func;
func.tags = ["markets"];
func.dependencies = ["tokens", "oracle"];
