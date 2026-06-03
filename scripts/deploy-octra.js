require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { octraKeypair, signOctraTx } = require("../relayer/octra");

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

function rpcUrl() {
  const url = required("OCTRA_RPC_URL");
  return url.endsWith("/rpc") ? url : `${url.replace(/\/$/, "")}/rpc`;
}

let nextId = 1;
async function rpc(method, params = []) {
  const response = await axios.post(
    rpcUrl(),
    { jsonrpc: "2.0", id: nextId++, method, params },
    { timeout: 30_000 }
  );
  if (response.data.error) {
    throw new Error(`${method}: ${response.data.error.message || JSON.stringify(response.data.error)}`);
  }
  return response.data.result;
}

async function compileOcUSD() {
  const main = fs.readFileSync(path.join(__dirname, "../contracts/octra/main.aml"), "utf8");
  const iface = fs.readFileSync(path.join(__dirname, "../contracts/octra/interfaces/IOCS01.aml"), "utf8");
  const result = await rpc("octra_compileAmlMulti", [
    {
      files: [
        { path: "interfaces/IOCS01.aml", source: iface },
        { path: "main.aml", source: main },
      ],
      main: "main.aml",
    },
  ]);
  return { bytecode: result.bytecode, abi: result.abi, size: result.size, instructions: result.instructions };
}

async function accountNonce(address) {
  let balance;
  try {
    balance = await rpc("octra_balance", [address]);
  } catch (error) {
    if (process.env.DRY_RUN === "1" && String(error.message || error).includes("sender not found")) {
      return 0;
    }
    throw error;
  }
  return Number(balance.pending_nonce ?? balance.nonce ?? 0);
}

async function main() {
  const deployer = required("RELAYER_OCTRA_ADDRESS");
  const relayer = process.env.OCTRA_INITIAL_RELAYER || deployer;
  const keypair = octraKeypair(required("RELAYER_PRIVATE_KEY_OCTRA"));
  const compiled = await compileOcUSD();
  const nonce = (await accountNonce(deployer)) + 1;
  const addressInfo = await rpc("octra_computeContractAddress", [compiled.bytecode, deployer, nonce]);
  const contractAddress = addressInfo.address;

  const tx = {
    from: deployer,
    to_: contractAddress,
    amount: "0",
    nonce,
    ou: process.env.OCTRA_DEPLOY_OU || "50000000",
    timestamp: Number((Date.now() / 1000).toFixed(6)),
    op_type: "deploy",
    encrypted_data: compiled.bytecode,
    message: JSON.stringify([relayer]),
  };
  tx.signature = signOctraTx(tx, keypair.secretKey);
  tx.public_key = Buffer.from(keypair.publicKey).toString("base64");

  if (process.env.DRY_RUN === "1") {
    console.log(JSON.stringify({
      dry_run: true,
      contract_address: contractAddress,
      deployer,
      relayer,
      nonce,
      ou: tx.ou,
      size: compiled.size,
      instructions: compiled.instructions,
      abi: compiled.abi ? JSON.parse(compiled.abi) : null,
    }, null, 2));
    return;
  }

  const result = await rpc("octra_submit", [tx]);
  console.log(JSON.stringify({ contract_address: contractAddress, deployer, relayer, nonce, result }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
