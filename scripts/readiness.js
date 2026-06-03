require("dotenv").config();

const { ethers } = require("ethers");
const hre = require("hardhat");
const axios = require("axios");

const MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

async function ethUsd() {
  try {
    const response = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot", { timeout: 5000 });
    return Number(response.data.data.amount);
  } catch (_) {
    return null;
  }
}

async function octraRpcStatus(url) {
  if (!url) return { ok: false, error: "OCTRA_RPC_URL missing" };
  try {
    const rpcUrl = url.endsWith("/rpc") ? url : `${url.replace(/\/$/, "")}/rpc`;
    const response = await axios.post(
      rpcUrl,
      { jsonrpc: "2.0", id: 1, method: "node_status", params: [] },
      { timeout: 10000 }
    );
    if (response.data.error) return { ok: false, error: response.data.error.message || JSON.stringify(response.data.error) };
    return { ok: true, result: response.data.result };
  } catch (error) {
    return { ok: false, error: error.response ? `HTTP ${error.response.status}` : error.message };
  }
}

async function main() {
  const ethRpcUrl = process.env.ETH_RPC_URL;
  if (!ethRpcUrl) throw new Error("ETH_RPC_URL is required");

  const provider = new ethers.JsonRpcProvider(ethRpcUrl);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY);
  const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY_ETH);
  const owner = process.env.INITIAL_OWNER_ADDRESS;
  const usdt = process.env.USDT_ADDRESS || MAINNET_USDT;

  await hre.run("compile", { quiet: true });

  const Custody = await hre.ethers.getContractFactory("OctraUSDCustody");
  const deployTx = await Custody.getDeployTransaction(usdt, relayer.address, owner);
  const [feeData, deployGas, deployerBalance, relayerBalance, ownerBalance, price] = await Promise.all([
    provider.getFeeData(),
    provider.estimateGas({ ...deployTx, from: deployer.address }),
    provider.getBalance(deployer.address),
    provider.getBalance(relayer.address),
    provider.getBalance(owner),
    ethUsd(),
  ]);

  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
  const maxFee = feeData.maxFeePerGas || gasPrice;
  const deployCost = deployGas * gasPrice;
  const conservativeDeployCost = deployGas * maxFee;
  const relayerWarmup = 200000n * maxFee;

  const formatUsd = (eth) => {
    if (!price) return "n/a";
    return `$${(Number(ethers.formatEther(eth)) * price).toFixed(2)}`;
  };

  const custodyCode =
    process.env.ETH_CUSTODY_CONTRACT && ethers.isAddress(process.env.ETH_CUSTODY_CONTRACT)
      ? await provider.getCode(process.env.ETH_CUSTODY_CONTRACT)
      : "0x";
  const octra = await octraRpcStatus(process.env.OCTRA_RPC_URL);

  const report = {
    ethereum: {
      rpc_url: ethRpcUrl,
      deployer: {
        address: deployer.address,
        balance_eth: ethers.formatEther(deployerBalance),
        recommended_min_eth: "0.002",
      },
      relayer: {
        address: relayer.address,
        balance_eth: ethers.formatEther(relayerBalance),
        recommended_min_eth: "0.002",
      },
      owner: {
        address: owner,
        balance_eth: ethers.formatEther(ownerBalance),
        recommended_min_eth: "0",
      },
      usdt,
      custody_contract: process.env.ETH_CUSTODY_CONTRACT || "",
      custody_contract_has_code: custodyCode !== "0x",
      gas: {
        deploy_gas: deployGas.toString(),
        gas_price_gwei: ethers.formatUnits(gasPrice, "gwei"),
        max_fee_gwei: ethers.formatUnits(maxFee, "gwei"),
        deploy_cost_eth: ethers.formatEther(deployCost),
        deploy_cost_usd: formatUsd(deployCost),
        conservative_deploy_cost_eth: ethers.formatEther(conservativeDeployCost),
        conservative_deploy_cost_usd: formatUsd(conservativeDeployCost),
        relayer_warmup_200k_gas_eth: ethers.formatEther(relayerWarmup),
        relayer_warmup_200k_gas_usd: formatUsd(relayerWarmup),
      },
    },
    octra: {
      rpc_url: process.env.OCTRA_RPC_URL || "",
      rpc_ok: octra.ok,
      rpc_error: octra.ok ? null : octra.error,
      token_contract: process.env.OCTRA_TOKEN_CONTRACT || "",
      relayer_address: process.env.RELAYER_OCTRA_ADDRESS || "",
      deploy_ou_default: "50000000",
      call_ou_default: process.env.OCTRA_CALL_FEE || "1000",
    },
    ready: {
      can_deploy_eth_custody_now: deployerBalance >= conservativeDeployCost,
      can_run_eth_relayer_warmup_now: relayerBalance >= relayerWarmup,
      has_octra_token_address: Boolean(process.env.OCTRA_TOKEN_CONTRACT),
      octra_rpc_ok: octra.ok,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
