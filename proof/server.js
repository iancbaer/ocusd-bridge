require("dotenv").config();

const http = require("http");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { ethers } = require("ethers");
const { openDatabase } = require("../relayer/db");
const { netAfterBridgeFee } = require("../relayer");

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

const WITHDRAW_ABI = [
  "function withdraw(address recipient,uint256 amount,uint256 octraBurnNonce,bytes signature)",
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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function corsJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(),
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

function publicDeposit(row) {
  if (!row) return null;
  return {
    tx_hash: row.tx_hash,
    block_number: row.block_number,
    user_address: row.user_address,
    amount: row.amount,
    octra_recipient: row.octra_recipient,
    deposit_nonce: row.deposit_nonce,
    status: row.status,
    octra_mint_tx: row.octra_mint_tx,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

function publicBurn(row) {
  if (!row) return null;
  return {
    octra_tx_hash: row.octra_tx_hash,
    block_height: row.block_height,
    user_address: row.user_address,
    amount: row.amount,
    burn_nonce: row.burn_nonce,
    eth_recipient: row.eth_recipient,
    status: row.status,
    has_signature: Boolean(row.eth_release_signature),
    eth_release_tx: row.eth_release_tx,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

function lookupByEth(ethAddress) {
  const store = openDatabase(process.env.RELAYER_DB_PATH || "relayer.sqlite");
  const address = ethAddress.toLowerCase();
  const deposits = store.db.prepare(`
    SELECT * FROM eth_deposits
    WHERE lower(user_address) = ?
    ORDER BY block_number DESC, deposit_nonce DESC
    LIMIT 25
  `).all(address).map(publicDeposit);
  const burns = store.db.prepare(`
    SELECT * FROM octra_burns
    WHERE lower(eth_recipient) = ?
    ORDER BY block_height DESC, burn_nonce DESC
    LIMIT 25
  `).all(address).map(publicBurn);
  return { eth_address: ethAddress, deposits, burns };
}

async function withdrawalSignature(burnNonce) {
  const store = openDatabase(process.env.RELAYER_DB_PATH || "relayer.sqlite");
  const burn = store.getOctraBurnByNonce(burnNonce);
  if (!burn) {
    const error = new Error("burn not found or not indexed yet");
    error.status = 404;
    throw error;
  }
  if (!ethers.isAddress(burn.eth_recipient)) {
    const error = new Error("burn has invalid Ethereum recipient");
    error.status = 422;
    throw error;
  }

  let signature = burn.eth_release_signature;
  const releaseAmount = netAfterBridgeFee(burn.amount, Number(process.env.BRIDGE_FEE_BPS || 10));
  if (!signature) {
    const provider = new ethers.JsonRpcProvider(required("ETH_RPC_URL"));
    const wallet = new ethers.Wallet(required("RELAYER_PRIVATE_KEY_ETH"), provider);
    const chain = await provider.getNetwork();
    const digest = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [burn.eth_recipient, releaseAmount.net, burn.burn_nonce, required("ETH_CUSTODY_CONTRACT"), chain.chainId]
    );
    signature = await wallet.signMessage(ethers.getBytes(digest));
    store.markOctraBurnSigned(burn.id, signature);
  }

  return {
    custody_contract: required("ETH_CUSTODY_CONTRACT"),
    withdraw_abi: WITHDRAW_ABI,
    recipient: burn.eth_recipient,
    amount: releaseAmount.net,
    gross_amount: releaseAmount.gross,
    fee_amount: releaseAmount.fee,
    burn_nonce: burn.burn_nonce,
    signature,
    burn: publicBurn({ ...burn, amount: releaseAmount.net, eth_release_signature: signature, status: "signed" }),
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
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.url.startsWith("/api/proof")) {
      return corsJson(res, 200, await proofSnapshot());
    }
    if (url.pathname === "/lookup") {
      const eth = url.searchParams.get("eth");
      if (!eth || !ethers.isAddress(eth)) return corsJson(res, 400, { error: "valid eth query param required" });
      return corsJson(res, 200, lookupByEth(eth));
    }
    if (url.pathname === "/withdraw-signature") {
      const burnNonce = url.searchParams.get("burn_nonce");
      if (!burnNonce) return corsJson(res, 400, { error: "burn_nonce query param required" });
      return corsJson(res, 200, await withdrawalSignature(burnNonce));
    }
    if (req.url.startsWith("/healthz")) {
      return corsJson(res, 200, { ok: true, generated_at: new Date().toISOString() });
    }
    return serveStatic(req, res);
  } catch (error) {
    return corsJson(res, error.status || 500, { error: error.message });
  }
});

const port = Number(process.env.PROOF_PORT || 8080);
server.listen(port, () => {
  console.log(`ocUSD proof page listening on http://127.0.0.1:${port}`);
});
