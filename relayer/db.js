const Database = require("better-sqlite3");

function openDatabase(filename = process.env.RELAYER_DB_PATH || "relayer.sqlite") {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS eth_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      user_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      octra_recipient TEXT NOT NULL,
      deposit_nonce INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      octra_mint_tx TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(deposit_nonce),
      UNIQUE(tx_hash, deposit_nonce)
    );

    CREATE TABLE IF NOT EXISTS octra_burns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      octra_tx_hash TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      user_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      burn_nonce INTEGER NOT NULL,
      eth_recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      eth_release_tx TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(burn_nonce),
      UNIQUE(octra_tx_hash, burn_nonce)
    );

    CREATE TABLE IF NOT EXISTS relayer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return {
    db,

    getState(key, fallbackValue = null) {
      const row = db.prepare("SELECT value FROM relayer_state WHERE key = ?").get(key);
      return row ? row.value : fallbackValue;
    },

    setState(key, value) {
      db.prepare(`
        INSERT INTO relayer_state (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    },

    upsertEthDeposit(event) {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT OR IGNORE INTO eth_deposits
          (tx_hash, block_number, user_address, amount, octra_recipient, deposit_nonce, created_at, updated_at)
        VALUES
          (@txHash, @blockNumber, @userAddress, @amount, @octraRecipient, @depositNonce, @now, @now)
      `).run({ ...event, now });
    },

    pendingEthDeposits(limit = 25) {
      return db.prepare(`
        SELECT * FROM eth_deposits
        WHERE status IN ('pending', 'failed') AND attempts < 3
        ORDER BY block_number ASC, deposit_nonce ASC
        LIMIT ?
      `).all(limit);
    },

    markEthDepositMinted(id, octraMintTx) {
      db.prepare(`
        UPDATE eth_deposits
        SET status = 'minted', octra_mint_tx = ?, updated_at = ?
        WHERE id = ?
      `).run(octraMintTx, Math.floor(Date.now() / 1000), id);
    },

    markEthDepositFailed(id, error) {
      db.prepare(`
        UPDATE eth_deposits
        SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(String(error).slice(0, 1000), Math.floor(Date.now() / 1000), id);
    },

    upsertOctraBurn(event) {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT OR IGNORE INTO octra_burns
          (octra_tx_hash, block_height, user_address, amount, burn_nonce, eth_recipient, created_at, updated_at)
        VALUES
          (@octraTxHash, @blockHeight, @userAddress, @amount, @burnNonce, @ethRecipient, @now, @now)
      `).run({ ...event, now });
    },

    pendingOctraBurns(limit = 25) {
      return db.prepare(`
        SELECT * FROM octra_burns
        WHERE status IN ('pending', 'failed') AND attempts < 3
        ORDER BY block_height ASC, burn_nonce ASC
        LIMIT ?
      `).all(limit);
    },

    markOctraBurnReleased(id, ethReleaseTx) {
      db.prepare(`
        UPDATE octra_burns
        SET status = 'released', eth_release_tx = ?, updated_at = ?
        WHERE id = ?
      `).run(ethReleaseTx, Math.floor(Date.now() / 1000), id);
    },

    markOctraBurnFailed(id, error) {
      db.prepare(`
        UPDATE octra_burns
        SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(String(error).slice(0, 1000), Math.floor(Date.now() / 1000), id);
    },
  };
}

module.exports = { openDatabase };
