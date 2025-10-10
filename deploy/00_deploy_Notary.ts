import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;

  const notary = await deploy("HermesNotary", {
    from: deployer,
    log: true,
    // autoMine speeds up local dev chains; harmless elsewhere
    autoMine: true,
  });

  log(`HermesNotary: ${notary.address}`);
};

export default func;
func.id = "00_deploy_hermes_notary";
func.tags = ["notary", "HermesNotary"];