const { ethers } = require("ethers");

const CUSTODY_ABI = [
  "event Deposited(address indexed user,uint256 amount,string octraRecipient,uint256 nonce)",
  "function withdraw(address recipient,uint256 amount,uint256 octraBurnNonce,bytes signature)",
  "function usedBurnNonces(uint256) view returns (bool)",
];

function createEthClient(config) {
  const provider = config.ethProvider || new ethers.JsonRpcProvider(config.ethRpcUrl);
  const wallet = config.ethWallet || new ethers.Wallet(config.ethPrivateKey, provider);
  const custody = new ethers.Contract(config.custodyContract, CUSTODY_ABI, wallet);

  async function getCurrentBlock() {
    return provider.getBlockNumber();
  }

  async function scanDeposits(fromBlock, toBlock) {
    if (toBlock < fromBlock) return [];

    const filter = custody.filters.Deposited();
    const logs = await custody.queryFilter(filter, fromBlock, toBlock);

    return logs.map((log) => ({
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      userAddress: log.args.user,
      amount: log.args.amount.toString(),
      octraRecipient: log.args.octraRecipient,
      depositNonce: Number(log.args.nonce),
    }));
  }

  async function signWithdrawal(recipient, amount, burnNonce) {
    const { chainId } = await provider.getNetwork();
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [recipient, amount, burnNonce, config.custodyContract, chainId]
    );

    return wallet.signMessage(ethers.getBytes(messageHash));
  }

  async function releaseWithdrawal(burn) {
    const alreadyUsed = await custody.usedBurnNonces(burn.burn_nonce);
    if (alreadyUsed) {
      return { hash: "already-used" };
    }

    const signature = await signWithdrawal(burn.eth_recipient, burn.amount, burn.burn_nonce);
    const tx = await custody.withdraw(burn.eth_recipient, burn.amount, burn.burn_nonce, signature);
    const receipt = await tx.wait(config.confirmationsRequired);
    return { hash: receipt.hash };
  }

  return {
    provider,
    wallet,
    custody,
    getCurrentBlock,
    scanDeposits,
    signWithdrawal,
    releaseWithdrawal,
  };
}

module.exports = { createEthClient };
