const { expect } = require("chai");
const nacl = require("tweetnacl");
const { canonicalOctraJson, octraKeypair, signOctraTx } = require("../relayer/octra");

describe("Octra relayer helpers", function () {
  it("matches Octra webcli canonical transaction JSON ordering", function () {
    const tx = {
      from: "octRelayer",
      to_: "octToken",
      amount: "0",
      nonce: 7,
      ou: "1000",
      timestamp: 1710000000.125,
      op_type: "call",
      encrypted_data: "mint",
      message: "[\"octRecipient\",\"1000000\",1]",
    };

    expect(canonicalOctraJson(tx)).to.equal(
      "{\"from\":\"octRelayer\",\"to_\":\"octToken\",\"amount\":\"0\",\"nonce\":7,\"ou\":\"1000\",\"timestamp\":1710000000.125,\"op_type\":\"call\",\"encrypted_data\":\"mint\",\"message\":\"[\\\"octRecipient\\\",\\\"1000000\\\",1]\"}"
    );
  });

  it("signs with a base64 Octra seed and emits a verifiable detached signature", function () {
    const seed = Buffer.alloc(32, 1);
    const privateKey = seed.toString("base64");
    const keypair = octraKeypair(privateKey);
    const tx = {
      from: "octRelayer",
      to_: "octToken",
      amount: "0",
      nonce: 1,
      ou: "1000",
      timestamp: 1710000000,
      op_type: "call",
      encrypted_data: "mint",
      message: "[\"octRecipient\",\"1000000\",1]",
    };

    const signature = Buffer.from(signOctraTx(tx, keypair.secretKey), "base64");
    const message = Buffer.from(canonicalOctraJson(tx));

    expect(signature).to.have.length(64);
    expect(nacl.sign.detached.verify(message, signature, keypair.publicKey)).to.equal(true);
  });
});
