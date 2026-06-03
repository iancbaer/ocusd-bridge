const hre = require("hardhat");

async function main() {
  const [deployer, relayer, owner, user] = await hre.ethers.getSigners();

  const MockUSDT = await hre.ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();

  const Custody = await hre.ethers.getContractFactory("OctraUSDCustody");
  const custody = await Custody.deploy(await usdt.getAddress(), relayer.address, owner.address);
  await custody.waitForDeployment();

  const userMint = hre.ethers.parseUnits("1000", 6);
  await usdt.mint(user.address, userMint);

  console.log("Local bridge deployment");
  console.log(`MockUSDT: ${await usdt.getAddress()}`);
  console.log(`OctraUSDCustody: ${await custody.getAddress()}`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`owner: ${owner.address}`);
  console.log(`relayerSigner: ${relayer.address}`);
  console.log(`mockUser: ${user.address}`);
  console.log(`mockUserMockUSDT: ${userMint.toString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
