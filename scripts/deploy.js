const hre = require("hardhat");

const MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

async function main() {
  const relayerSigner = process.env.RELAYER_SIGNER_ADDRESS;
  const initialOwner = process.env.INITIAL_OWNER_ADDRESS;
  const usdtAddress = process.env.USDT_ADDRESS || MAINNET_USDT;

  if (!relayerSigner) throw new Error("RELAYER_SIGNER_ADDRESS is required");
  if (!initialOwner) throw new Error("INITIAL_OWNER_ADDRESS is required");

  const Custody = await hre.ethers.getContractFactory("OctraUSDCustody");
  const custody = await Custody.deploy(usdtAddress, relayerSigner, initialOwner);
  await custody.waitForDeployment();

  console.log(`OctraUSDCustody deployed to ${await custody.getAddress()}`);
  console.log(`USDT: ${usdtAddress}`);
  console.log(`relayerSigner: ${relayerSigner}`);
  console.log(`initialOwner: ${initialOwner}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
