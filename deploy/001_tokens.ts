import type { DeployFunction } from "hardhat-deploy/types";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, getOrNull, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // Keep EXACT defaults used in your tests
  // TokenUSD  = "Us Dollar", "USD"
  // TokenEUR  = "EURO", "EUR"
  let usd = await getOrNull("TokenUSD");
  if (!usd) {
    usd = await deploy("TokenUSD", {
      from: deployer,
      log: true,
      contract: "ConfidentialToken",
      args: ["Us Dollar", "USD"],
    });
    log(`TokenUSD deployed at ${usd.address}`);
  } else {
    log(`TokenUSD already deployed at ${usd.address}`);
  }

  let eur = await getOrNull("TokenEUR");
  if (!eur) {
    eur = await deploy("TokenEUR", {
      from: deployer,
      log: true,
      contract: "ConfidentialToken",
      args: ["EURO", "EUR"],
    });
    log(`TokenEUR deployed at ${eur.address}`);
  } else {
    log(`TokenEUR already deployed at ${eur.address}`);
  }
};

export default func;
func.tags = ["tokens"];
