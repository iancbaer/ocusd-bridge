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
      { timeout: 30_000 }
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

  function parseBurnEvent(tx) {
    const receipt = tx.receipt || tx.result || tx;
    const logs = receipt.events || receipt.logs || [];

    for (const log of logs) {
      const name = log.event || log.name || log.method;
      if (name !== "Burned" && name !== "BurnedToEth") continue;

      const args = log.args || log.params || {};
      const isBurnedToEth = name === "BurnedToEth";
      const userAddress = args.caller || args.user || args[0];
      const ethRecipient = args.ethRecipient || args.eth_recipient || args.recipient || (isBurnedToEth ? args[1] : undefined);
      const amount = String(args.amount || (isBurnedToEth ? args[2] : args[1]));
      const burnNonce = Number(args.burnNonce || args.burn_nonce || (isBurnedToEth ? args[3] : args[2]));

      if (!ethers.isAddress(ethRecipient)) {
        throw new Error(
          `burn ${burnNonce} has no Ethereum recipient; add an Octra event field or mapping before releasing`
        );
      }

      return {
        octraTxHash: tx.hash || tx.tx_hash || receipt.tx_hash,
        blockHeight: Number(tx.height || tx.block_height || receipt.height || receipt.block_height || 0),
        userAddress,
        amount,
        burnNonce,
        ethRecipient,
      };
    }

    return null;
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

    const txs = await rpc("octra_transactionsByAddress", [config.octraTokenContract, 100, 0]);
    const list = txs.transactions || txs.items || txs || [];

    return list
      .filter((tx) => {
        const height = Number(tx.height || tx.block_height || 0);
        return height >= fromHeight && height <= toHeight;
      })
      .map(parseBurnEvent)
      .filter(Boolean);
  }

  return {
    rpc,
    currentHeight,
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
