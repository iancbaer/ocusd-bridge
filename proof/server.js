require("dotenv").config();

const http = require("http");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { ethers } = require("ethers");
const { openDatabase } = require("../relayer/db");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const CUSTODY_ABI = [
  "function USDT() view returns (address)",
  "function paused() view returns (bool)",
  "function relayerSigner() view returns (address)",
  "function depositNonce() view returns (uint256)",
];

function normalizeRpcUrl(url) {
  return url.endsWith("/rpc") ? url : `${url.replace(/\/$/, "")}/rpc`;
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function octraView(method, params = []) {
  const rpcUrl = normalizeRpcUrl(required("OCTRA_RPC_URL"));
  const response = await axios.post(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "contract_call",
      params: [required("OCTRA_TOKEN_CONTRACT"), method, params, process.env.RELAYER_OCTRA_ADDRESS || ""],
    },
    { timeout: 15_000 }
  );
  if (response.data.error) {
    throw new Error(response.data.error.message || JSON.stringify(response.data.error));
  }
  return response.data.result;
}

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

async function proofSnapshot() {
  const provider = new ethers.JsonRpcProvider(required("ETH_RPC_URL"));
  const custodyAddress = required("ETH_CUSTODY_CONTRACT");
  const custody = new ethers.Contract(custodyAddress, CUSTODY_ABI, provider);
  const usdtAddress = process.env.USDT_ADDRESS || await custody.USDT();
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, provider);
  const store = openDatabase(process.env.RELAYER_DB_PATH || "relayer.sqlite");

  const [
    ethBlock,
    chain,
    usdtBalance,
    usdtDecimals,
    usdtSymbol,
    paused,
    relayerSigner,
    depositNonce,
  ] = await Promise.all([
    provider.getBlockNumber(),
    provider.getNetwork(),
    usdt.balanceOf(custodyAddress),
    usdt.decimals(),
    usdt.symbol().catch(() => "USDT"),
    custody.paused(),
    custody.relayerSigner(),
    custody.depositNonce(),
  ]);

  let octraTotalSupply = null;
  let octraError = null;
  try {
    octraTotalSupply = await octraView("get_total_supply", []);
  } catch (error) {
    octraError = error.message;
  }

  const db = store.db;
  const depositStats = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS amount
    FROM eth_deposits
    GROUP BY status
  `).all();
  const burnStats = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS amount
    FROM octra_burns
    GROUP BY status
  `).all();

  const minted = amountByStatus(depositStats, "minted");
  const released = amountByStatus(burnStats, "released");
  const outstandingRaw = BigInt(minted) - BigInt(released);
  const backingRaw = BigInt(usdtBalance.toString());
  const octraSupplyRaw = octraTotalSupply == null ? null : BigInt(String(octraTotalSupply.result ?? octraTotalSupply));

  return {
    generated_at: new Date().toISOString(),
    ethereum: {
      chain_id: chain.chainId.toString(),
      block_number: ethBlock,
      custody_contract: custodyAddress,
      usdt_address: usdtAddress,
      usdt_symbol: usdtSymbol,
      usdt_decimals: Number(usdtDecimals),
      custody_usdt_balance_raw: usdtBalance.toString(),
      custody_usdt_balance: ethers.formatUnits(usdtBalance, usdtDecimals),
      paused,
      relayer_signer: relayerSigner,
      deposit_nonce: depositNonce.toString(),
    },
    octra: {
      rpc_url: process.env.OCTRA_RPC_URL,
      token_contract: process.env.OCTRA_TOKEN_CONTRACT,
      total_supply_raw: octraSupplyRaw == null ? null : octraSupplyRaw.toString(),
      total_supply: octraSupplyRaw == null ? null : formatRaw(octraSupplyRaw, Number(usdtDecimals)),
      error: octraError,
    },
    relayer: {
      db_path: process.env.RELAYER_DB_PATH || "relayer.sqlite",
      last_eth_block_scanned: store.getState("last_eth_block_scanned", null),
      last_octra_height_scanned: store.getState("last_octra_height_scanned", null),
      eth_deposits_by_status: depositStats,
      octra_burns_by_status: burnStats,
      outstanding_deposits_raw: outstandingRaw.toString(),
      outstanding_deposits: formatRaw(outstandingRaw, Number(usdtDecimals)),
    },
    invariant: {
      custody_covers_relayer_accounting: backingRaw >= outstandingRaw,
      custody_covers_octra_supply: octraSupplyRaw == null ? null : backingRaw >= octraSupplyRaw,
      relayer_accounting_matches_octra_supply: octraSupplyRaw == null ? null : outstandingRaw === octraSupplyRaw,
    },
  };
}

function amountByStatus(rows, status) {
  const row = rows.find((item) => item.status === status);
  return row ? String(row.amount) : "0";
}

function formatRaw(value, decimals) {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${ethers.formatUnits(abs, decimals)}`;
}

function serveStatic(req, res) {
  const publicDir = path.join(__dirname, "public");
  const pathname = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return text(res, 403, "forbidden");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return text(res, 404, "not found");
  const ext = path.extname(filePath);
  const contentType = ext === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  text(res, 200, fs.readFileSync(filePath), contentType);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/proof")) {
      return json(res, 200, await proofSnapshot());
    }
    if (req.url.startsWith("/healthz")) {
      return json(res, 200, { ok: true, generated_at: new Date().toISOString() });
    }
    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

const port = Number(process.env.PROOF_PORT || 8080);
server.listen(port, () => {
  console.log(`ocUSD proof page listening on http://127.0.0.1:${port}`);
});
