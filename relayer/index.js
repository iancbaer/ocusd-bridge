require("dotenv").config();

const { openDatabase } = require("./db");
const { createEthClient } = require("./eth");
const { createOctraClient } = require("./octra");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(level, message, details) {
  const suffix = details ? ` ${typeof details === "string" ? details : JSON.stringify(details)}` : "";
  console[level](`[${new Date().toISOString()}] ${message}${suffix}`);
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
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

async function main() {
  const config = {
    ethRpcUrl: requireEnv("ETH_RPC_URL"),
    custodyContract: requireEnv("ETH_CUSTODY_CONTRACT"),
    octraRpcUrl: requireEnv("OCTRA_RPC_URL"),
    octraTokenContract: requireEnv("OCTRA_TOKEN_CONTRACT"),
    octraRelayerAddress: requireEnv("RELAYER_OCTRA_ADDRESS"),
    ethPrivateKey: requireEnv("RELAYER_PRIVATE_KEY_ETH"),
    octraPrivateKey: requireEnv("RELAYER_PRIVATE_KEY_OCTRA"),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3000),
    confirmationsRequired: Number(process.env.CONFIRMATIONS_REQUIRED || 2),
    octraCallFee: process.env.OCTRA_CALL_FEE || "1000",
    octraEventsEndpoint: process.env.OCTRA_EVENTS_ENDPOINT,
    octraSubmitEndpoint: process.env.OCTRA_SUBMIT_ENDPOINT,
  };

  const store = openDatabase();
  const eth = createEthClient(config);
  const octra = createOctraClient(config);

  log("log", "ocUSD relayer started");

  while (true) {
    try {
      const latestEthBlock = await eth.getCurrentBlock();
      const confirmedEthBlock = latestEthBlock - config.confirmationsRequired;
      const lastEthBlock = Number(store.getState("last_eth_block_scanned", confirmedEthBlock - 1));

      if (confirmedEthBlock > lastEthBlock) {
        const deposits = await eth.scanDeposits(lastEthBlock + 1, confirmedEthBlock);
        for (const deposit of deposits) store.upsertEthDeposit(deposit);
        store.setState("last_eth_block_scanned", confirmedEthBlock);
      }

      for (const deposit of store.pendingEthDeposits()) {
        try {
          const txHash = await withRetry(() =>
            octra.mint(deposit.octra_recipient, deposit.amount, deposit.deposit_nonce)
          );
          store.markEthDepositMinted(deposit.id, String(txHash));
          log("log", "minted ocUSD", { deposit_nonce: deposit.deposit_nonce, tx_hash: txHash });
        } catch (error) {
          store.markEthDepositFailed(deposit.id, error.message || error);
          log("error", "failed to mint ocUSD", { deposit_nonce: deposit.deposit_nonce, error: error.message });
        }
      }

      const latestOctraHeight = await octra.currentHeight();
      const lastOctraHeight = Number(store.getState("last_octra_height_scanned", latestOctraHeight - 1));

      if (latestOctraHeight > lastOctraHeight) {
        const burns = await octra.scanBurns(lastOctraHeight + 1, latestOctraHeight);
        for (const burn of burns) store.upsertOctraBurn(burn);
        store.setState("last_octra_height_scanned", latestOctraHeight);
      }

      for (const burn of store.pendingOctraBurns()) {
        try {
          const receipt = await withRetry(() => eth.releaseWithdrawal(burn));
          store.markOctraBurnReleased(burn.id, receipt.hash);
          log("log", "released USDT", { burn_nonce: burn.burn_nonce, tx_hash: receipt.hash });
        } catch (error) {
          store.markOctraBurnFailed(burn.id, error.message || error);
          log("error", "failed to release USDT", { burn_nonce: burn.burn_nonce, error: error.message });
        }
      }
    } catch (error) {
      log("error", "relayer loop error", error.message || error);
    }

    await sleep(config.pollIntervalMs);
  }
}

process.on("unhandledRejection", (error) => log("error", "unhandled rejection", error.message || error));
process.on("uncaughtException", (error) => log("error", "uncaught exception", error.message || error));

main().catch((error) => {
  log("error", "startup failed", error.message || error);
  process.exitCode = 1;
});
