const http = require("http");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        return resolve(JSON.parse(body));
      } catch (error) {
        return reject(error);
      }
    });
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function createMockOctraAdapter() {
  const state = {
    height: 0,
    nextMintId: 1,
    nextBurnNonce: 1,
    relayerBalance: "1000000000",
    mints: [],
    burns: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    try {
      if (req.method === "POST" && url.pathname === "/rpc") {
        const body = await readJson(req);
        if (body.method === "node_status" || body.method === "octra_status") {
          return writeJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { height: state.height } });
        }
        if (body.method === "octra_balance") {
          return writeJson(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { balance: state.relayerBalance, nonce: 0 },
          });
        }
        return writeJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `unsupported method ${body.method}` },
        });
      }

      if (req.method === "POST" && url.pathname === "/submit") {
        const body = await readJson(req);
        const mint = {
          id: state.nextMintId,
          tx_hash: `mock-mint-${state.nextMintId}`,
          contract: body.contract,
          method: body.method,
          params: body.params,
        };
        state.nextMintId += 1;
        state.mints.push(mint);
        return writeJson(res, 200, { tx_hash: mint.tx_hash });
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const fromHeight = Number(url.searchParams.get("from_height") || 0);
        const toHeight = Number(url.searchParams.get("to_height") || state.height);
        const events = state.burns.filter((burn) => burn.block_height >= fromHeight && burn.block_height <= toHeight);
        return writeJson(res, 200, { events });
      }

      if (req.method === "GET" && url.pathname === "/mints") {
        return writeJson(res, 200, { mints: state.mints });
      }

      if (req.method === "POST" && url.pathname === "/burns") {
        const body = await readJson(req);
        state.height += 1;
        const burnNonce = Number(body.burn_nonce || body.burnNonce || state.nextBurnNonce);
        state.nextBurnNonce = Math.max(state.nextBurnNonce, burnNonce + 1);
        const burn = {
          tx_hash: body.tx_hash || `mock-burn-${burnNonce}`,
          block_height: state.height,
          user_address: body.user_address || body.caller || "octRecipient",
          amount: String(body.amount),
          burn_nonce: burnNonce,
          eth_recipient: body.eth_recipient || body.ethRecipient || body.recipient,
        };
        state.burns.push(burn);
        return writeJson(res, 200, burn);
      }

      return writeJson(res, 404, { error: "not found" });
    } catch (error) {
      return writeJson(res, 500, { error: error.message });
    }
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    injectBurn(event) {
      state.height += 1;
      const burnNonce = Number(event.burn_nonce || event.burnNonce || state.nextBurnNonce);
      state.nextBurnNonce = Math.max(state.nextBurnNonce, burnNonce + 1);
      const burn = {
        tx_hash: event.tx_hash || `mock-burn-${burnNonce}`,
        block_height: state.height,
        user_address: event.user_address || event.caller || "octRecipient",
        amount: String(event.amount),
        burn_nonce: burnNonce,
        eth_recipient: event.eth_recipient || event.ethRecipient || event.recipient,
      };
      state.burns.push(burn);
      return burn;
    },
    mintCalls() {
      return [...state.mints];
    },
    burnEvents() {
      return [...state.burns];
    },
  };
}

module.exports = { createMockOctraAdapter };
