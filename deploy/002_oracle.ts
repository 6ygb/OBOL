import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

const FRESH_WINDOW = 30 * 60; // 30 minutes, same as your tests

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, getOrNull, log } = deployments;
  const { deployer } = await getNamedAccounts();
  const deployerAddr = (await ethers.getSigner(deployer)).address;

  // Keep default values used in tests: ObolPriceOracle(deployer, 30*60)
  let oracle = await getOrNull("ObolPriceOracle");
  if (!oracle) {
    oracle = await deploy("ObolPriceOracle", {
      from: deployer,
      log: true,
      contract: "ObolPriceOracle",
      args: [deployerAddr, FRESH_WINDOW],
    });
    log(`ObolPriceOracle deployed at ${oracle.address}`);
  } else {
    log(`ObolPriceOracle already deployed at ${oracle.address}`);
  }
};

export default func;
func.tags = ["oracle"];
func.dependencies = ["tokens"];
