import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, log, read, execute } = hre.deployments;

  // Get the already-deployed Notary
  const notary = await get("HermesNotary");

  // Deploy Escrow, passing the notary address to the constructor
  const escrow = await deploy("HermesOtcEscrow", {
    from: deployer,
    args: [notary.address],
    log: true,
    autoMine: true,
  });

  log(`HermesOtcEscrow: ${escrow.address}`);

  const currentEscrow: string = await read("HermesNotary", "escrow");
  console.log("Current escrow :", currentEscrow);
  if (currentEscrow.toLowerCase() !== escrow.address.toLowerCase()) {
    await execute("HermesNotary", { from: deployer, log: true }, "setEscrow", escrow.address);
    const afterEscrow: string = await read("HermesNotary", "escrow");
    log(`HermesNotary.escrow updated: ${afterEscrow}`);
  } else {
    log("HermesNotary.escrow already set; skipping setEscrow");
  }
};

export default func;
func.id = "01_deploy_hermes_escrow";
func.tags = ["escrow", "HermesOtcEscrow"];
func.dependencies = ["00_deploy_hermes_notary"];
