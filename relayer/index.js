require("dotenv").config();

const { openDatabase } = require("./db");
const { createEthClient } = require("./eth");
const { createOctraClient } = require("./octra");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, message, details) {
  const suffix = details ? ` ${typeof details === "string" ? details : JSON.stringify(details)}` : "";
  console[level](`[${new Date().toISOString()}] ${message}${suffix}`);
}

function requireEnv(name, env = process.env) {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
}

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(2 ** i * 1000);
    }
  }
  throw lastError;
}

function configFromEnv(env = process.env) {
  return {
    ethRpcUrl: requireEnv("ETH_RPC_URL", env),
    custodyContract: requireEnv("ETH_CUSTODY_CONTRACT", env),
    octraRpcUrl: requireEnv("OCTRA_RPC_URL", env),
    octraTokenContract: requireEnv("OCTRA_TOKEN_CONTRACT", env),
    octraRelayerAddress: requireEnv("RELAYER_OCTRA_ADDRESS", env),
    ethPrivateKey: requireEnv("RELAYER_PRIVATE_KEY_ETH", env),
    octraPrivateKey: requireEnv("RELAYER_PRIVATE_KEY_OCTRA", env),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 3000),
    confirmationsRequired: Number(env.CONFIRMATIONS_REQUIRED || 2),
    octraCallFee: env.OCTRA_CALL_FEE || "1000",
    octraEventsEndpoint: env.OCTRA_EVENTS_ENDPOINT,
    octraSubmitEndpoint: env.OCTRA_SUBMIT_ENDPOINT,
    octraRpcUserAgent: env.OCTRA_RPC_USER_AGENT || "ocusd-relayer/1.0",
    userSubmittedWithdrawals: env.USER_SUBMITTED_WITHDRAWALS === "1",
    bridgeFeeBps: Number(env.BRIDGE_FEE_BPS || 10),
    minOctraRelayerBalanceOu: env.MIN_OCTRA_RELAYER_BALANCE_OU || "0",
  };
}

function netAfterBridgeFee(amount, bridgeFeeBps) {
  if (!Number.isInteger(bridgeFeeBps) || bridgeFeeBps < 0 || bridgeFeeBps > 10_000) {
    throw new Error("BRIDGE_FEE_BPS must be an integer between 0 and 10000");
  }

  const gross = BigInt(amount);
  const fee = (gross * BigInt(bridgeFeeBps)) / 10_000n;
  return {
    gross: gross.toString(),
    fee: fee.toString(),
    net: (gross - fee).toString(),
  };
}

async function hasOctraMintReserve(config, octra) {
  const minimum = BigInt(config.minOctraRelayerBalanceOu || "0");
  if (minimum <= 0n) return true;

  const balance = BigInt(await octra.relayerBalance());
  const nextCallCost = BigInt(config.octraCallFee || "0");
  return balance >= minimum + nextCallCost;
}

function createRelayer(config = configFromEnv(), store = openDatabase()) {
  const eth = createEthClient(config);
  const octra = createOctraClient(config);
  return { config, store, eth, octra };
}

async function scanEthereumDepositsOnce(context) {
  const { config, store, eth, octra } = context;
  const latestEthBlock = await eth.getCurrentBlock();
  const confirmedEthBlock = latestEthBlock - config.confirmationsRequired;
  const lastEthBlock = Number(store.getState("last_eth_block_scanned", confirmedEthBlock - 1));

  if (confirmedEthBlock > lastEthBlock) {
    const deposits = await eth.scanDeposits(lastEthBlock + 1, confirmedEthBlock);
    for (const deposit of deposits) store.upsertEthDeposit(deposit);
    store.setState("last_eth_block_scanned", confirmedEthBlock);
  }

  const minted = [];
  for (const deposit of store.pendingEthDeposits()) {
    try {
      if (!(await hasOctraMintReserve(config, octra))) {
        log("error", "octra relayer reserve is below mint threshold; leaving deposits pending", {
          deposit_nonce: deposit.deposit_nonce,
          min_balance_ou: config.minOctraRelayerBalanceOu,
          call_fee_ou: config.octraCallFee,
        });
        break;
      }

      const mintAmount = netAfterBridgeFee(deposit.amount, config.bridgeFeeBps);
      const txHash = await withRetry(() =>
        octra.mint(deposit.octra_recipient, mintAmount.net, deposit.deposit_nonce)
      );
      store.markEthDepositMinted(deposit.id, String(txHash));
      minted.push({ deposit, txHash: String(txHash), mintAmount });
      log("log", "minted ocUSD", {
        deposit_nonce: deposit.deposit_nonce,
        gross_amount: mintAmount.gross,
        fee_amount: mintAmount.fee,
        net_amount: mintAmount.net,
        tx_hash: txHash,
      });
    } catch (error) {
      store.markEthDepositFailed(deposit.id, error.message || error);
      log("error", "failed to mint ocUSD", { deposit_nonce: deposit.deposit_nonce, error: error.message });
    }
  }

  return minted;
}

async function scanOctraBurnsOnce(context) {
  const { store, eth, octra } = context;
  const latestOctraHeight = await octra.currentHeight();
  const lastOctraHeight = Number(store.getState("last_octra_height_scanned", latestOctraHeight - 1));

  if (latestOctraHeight > lastOctraHeight) {
    const burns = await octra.scanBurns(lastOctraHeight + 1, latestOctraHeight);
    for (const burn of burns) store.upsertOctraBurn(burn);
    store.setState("last_octra_height_scanned", latestOctraHeight);
  }

  const released = [];
  for (const burn of store.pendingOctraBurns()) {
    try {
      const releaseAmount = netAfterBridgeFee(burn.amount, context.config.bridgeFeeBps);
      const netBurn = { ...burn, amount: releaseAmount.net };
      if (context.config.userSubmittedWithdrawals) {
        const signature = await eth.signWithdrawal(burn.eth_recipient, releaseAmount.net, burn.burn_nonce);
        store.markOctraBurnSigned(burn.id, signature);
        released.push({ burn, signature, releaseAmount });
        log("log", "signed USDT withdrawal", {
          burn_nonce: burn.burn_nonce,
          eth_recipient: burn.eth_recipient,
          gross_amount: releaseAmount.gross,
          fee_amount: releaseAmount.fee,
          net_amount: releaseAmount.net,
        });
        continue;
      }
      const receipt = await withRetry(() => eth.releaseWithdrawal(netBurn));
      store.markOctraBurnReleased(burn.id, receipt.hash);
      released.push({ burn, txHash: receipt.hash, releaseAmount });
      log("log", "released USDT", {
        burn_nonce: burn.burn_nonce,
        gross_amount: releaseAmount.gross,
        fee_amount: releaseAmount.fee,
        net_amount: releaseAmount.net,
        tx_hash: receipt.hash,
      });
    } catch (error) {
      store.markOctraBurnFailed(burn.id, error.message || error);
      log("error", "failed to release USDT", { burn_nonce: burn.burn_nonce, error: error.message });
    }
  }

  return released;
}

async function runOnce(context) {
  const minted = await scanEthereumDepositsOnce(context);
  const released = await scanOctraBurnsOnce(context);
  return { minted, released };
}

async function main() {
  const context = createRelayer();
  // On startup, reset any deposits/burns stuck in 'processing' from a previous crash
  const db = context.store.db;
  db.prepare("UPDATE eth_deposits SET status='pending' WHERE status='processing'").run();
  db.prepare("UPDATE octra_burns SET status='pending' WHERE status='processing'").run();
  // In auto-submit mode, re-queue signed-but-not-released burns so the relayer submits them
  if (!context.config.userSubmittedWithdrawals) {
    db.prepare("UPDATE octra_burns SET status='pending', attempts=0 WHERE status='signed' AND eth_release_tx IS NULL").run();
  }

  log("log", "ocUSD relayer started");

  while (true) {
    try {
      await runOnce(context);
    } catch (error) {
      log("error", "relayer loop error", error.message || error);
    }

    await sleep(context.config.pollIntervalMs);
  }
}

process.on("unhandledRejection", (error) => log("error", "unhandled rejection", error.message || error));
process.on("uncaughtException", (error) => log("error", "uncaught exception", error.message || error));

if (require.main === module) {
  main().catch((error) => {
    log("error", "startup failed", error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  configFromEnv,
  createRelayer,
  scanEthereumDepositsOnce,
  scanOctraBurnsOnce,
  netAfterBridgeFee,
  hasOctraMintReserve,
  runOnce,
};
