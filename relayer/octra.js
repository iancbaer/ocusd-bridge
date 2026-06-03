const axios = require("axios");
const { ethers } = require("ethers");
const nacl = require("tweetnacl");

function normalizeRpcUrl(url) {
  return url.endsWith("/rpc") ? url : `${url.replace(/\/$/, "")}/rpc`;
}

function createOctraClient(config) {
  const rpcUrl = normalizeRpcUrl(config.octraRpcUrl);
  let nextId = 1;
  const keypair = octraKeypair(config.octraPrivateKey);

  async function rpc(method, params = []) {
    const response = await axios.post(
      rpcUrl,
      { jsonrpc: "2.0", id: nextId++, method, params },
      { timeout: 30_000, headers: { "User-Agent": config.octraRpcUserAgent || "ocusd-relayer/1.0" } }
    );

    if (response.data.error) {
      throw new Error(`${method}: ${response.data.error.message || JSON.stringify(response.data.error)}`);
    }

    return response.data.result;
  }

  async function currentHeight() {
    let status;
    try {
      status = await rpc("node_status", []);
    } catch (_) {
      status = await rpc("octra_status", []);
    }
    return Number(status.height || status.block_height || status.current_height || status.epoch || 0);
  }

  async function accountNonce() {
    const balance = await rpc("octra_balance", [config.octraRelayerAddress]);
    let nonce = Number(balance.pending_nonce ?? balance.nonce ?? 0);

    try {
      const staging = await rpc("staging_view", []);
      for (const tx of staging.transactions || []) {
        if (tx.from === config.octraRelayerAddress && Number(tx.nonce) > nonce) {
          nonce = Number(tx.nonce);
        }
      }
    } catch (_) {
      // Some public nodes do not expose staging_view. The confirmed nonce is still usable.
    }

    return nonce;
  }

  async function relayerBalance() {
    const balance = await rpc("octra_balance", [config.octraRelayerAddress]);
    return String(balance.balance ?? balance.available ?? balance.amount ?? 0);
  }

  async function sendContractCall(method, params) {
    if (config.octraSubmitEndpoint) {
      const response = await axios.post(
        config.octraSubmitEndpoint,
        {
          contract: config.octraTokenContract,
          method,
          params,
          private_key: config.octraPrivateKey,
        },
        { timeout: 30_000 }
      );
      return response.data.tx_hash || response.data.hash || response.data.result?.tx_hash;
    }

    const nonce = await accountNonce();
    const tx = {
      from: config.octraRelayerAddress,
      to_: config.octraTokenContract,
      amount: "0",
      nonce: nonce + 1,
      ou: config.octraCallFee || "1000",
      timestamp: Number((Date.now() / 1000).toFixed(6)),
      op_type: "call",
      encrypted_data: method,
      message: JSON.stringify(params),
    };

    tx.signature = signOctraTx(tx, keypair.secretKey);
    tx.public_key = Buffer.from(keypair.publicKey).toString("base64");

    const result = await rpc("octra_submit", [tx]);
    return result.tx_hash || result.hash || result;
  }

  async function mint(recipient, amount, ethDepositNonce) {
    return sendContractCall("mint", [recipient, amount, ethDepositNonce]);
  }

  async function fetchBurnReceipt(txHash) {
    const result = await rpc("contract_receipt", [txHash]);
    if (!result.success) return null;

    const burnEvent = (result.events || []).find((e) => e.event === "BurnedToEth");
    if (!burnEvent) return null;

    // values = [account, ethRecipient, amount, burnNonce]
    const [userAddress, ethRecipient, amount, burnNonce] = burnEvent.values || [];
    if (!ethers.isAddress(ethRecipient)) return null;

    return {
      octraTxHash: txHash,
      blockHeight: Number(result.epoch || 0),
      userAddress: String(userAddress),
      amount: String(amount),
      burnNonce: Number(burnNonce),
      ethRecipient: String(ethRecipient),
    };
  }

  async function scanBurns(fromHeight, toHeight) {
    if (toHeight < fromHeight) return [];

    if (config.octraEventsEndpoint) {
      const response = await axios.get(config.octraEventsEndpoint, {
        params: {
          contract: config.octraTokenContract,
          event: "BurnedToEth",
          from_height: fromHeight,
          to_height: toHeight,
        },
        timeout: 30_000,
        headers: { "User-Agent": config.octraRpcUserAgent || "ocusd-relayer/1.0" },
      });
      return (response.data.events || response.data || []).map((event) => ({
        octraTxHash: event.tx_hash || event.octra_tx_hash,
        blockHeight: Number(event.block_height || event.height),
        userAddress: event.user_address || event.caller,
        amount: String(event.amount),
        burnNonce: Number(event.burn_nonce || event.burnNonce),
        ethRecipient: event.eth_recipient || event.ethRecipient || event.recipient,
      })).filter((event) => ethers.isAddress(event.ethRecipient));
    }

    // Fetch recent transactions. We always check a sliding window of the
    // most recent 500 txs rather than just the epoch range, because a burn
    // can land in an epoch that the relayer has already marked as scanned
    // (e.g. the user burns slightly before the scan pointer advances).
    // The DB UNIQUE(burn_nonce) constraint prevents double-processing.
    const txs = await rpc("octra_transactionsByAddress", [config.octraTokenContract, 500, 0]);
    const list = txs.transactions || txs.items || txs || [];

    const candidates = list.filter((tx) => {
      const height = Number(tx.epoch || tx.height || tx.block_height || 0);
      // Include everything up to toHeight; fromHeight is a lower bound to
      // avoid re-processing very old history on every poll, but we set it
      // conservatively low (allow 500-epoch lookback) to catch stragglers.
      const lookback = Math.max(0, fromHeight - 500);
      return height >= lookback && height <= toHeight && tx.encrypted_data === "burn_to_eth";
    });

    const results = [];
    for (const tx of candidates) {
      try {
        const burn = await fetchBurnReceipt(tx.hash);
        if (burn) results.push(burn);
      } catch (_) {}
    }
    return results;
  }

  return {
    rpc,
    currentHeight,
    relayerBalance,
    mint,
    scanBurns,
  };
}

function octraKeypair(privateKeyBase64) {
  const raw = Buffer.from(privateKeyBase64, "base64");
  if (raw.length >= 64) {
    return {
      secretKey: new Uint8Array(raw.subarray(0, 64)),
      publicKey: new Uint8Array(raw.subarray(32, 64)),
    };
  }
  if (raw.length >= 32) {
    return nacl.sign.keyPair.fromSeed(new Uint8Array(raw.subarray(0, 32)));
  }
  throw new Error("RELAYER_PRIVATE_KEY_OCTRA must be a base64 32-byte seed or 64-byte secret key");
}

function jsonEscape(value) {
  let out = "";
  for (const char of String(value)) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case "\"":
        out += "\\\"";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += char;
    }
  }
  return out;
}

function canonicalOctraJson(tx) {
  let out = `{"from":"${jsonEscape(tx.from)}","to_":"${jsonEscape(tx.to_)}","amount":"${jsonEscape(tx.amount)}","nonce":${tx.nonce},"ou":"${jsonEscape(tx.ou)}","timestamp":${JSON.stringify(tx.timestamp)},"op_type":"${jsonEscape(tx.op_type || "standard")}"`;
  if (tx.encrypted_data) out += `,"encrypted_data":"${jsonEscape(tx.encrypted_data)}"`;
  if (tx.message) out += `,"message":"${jsonEscape(tx.message)}"`;
  return `${out}}`;
}

function signOctraTx(tx, secretKey) {
  const message = Buffer.from(canonicalOctraJson(tx));
  return Buffer.from(nacl.sign.detached(message, secretKey)).toString("base64");
}

module.exports = {
  createOctraClient,
  canonicalOctraJson,
  signOctraTx,
  octraKeypair,
};
