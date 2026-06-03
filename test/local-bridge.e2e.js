const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../relayer/db");
const { createRelayer, netAfterBridgeFee, runOnce, scanEthereumDepositsOnce, scanOctraBurnsOnce } = require("../relayer");
const { createMockOctraAdapter } = require("./mock-octra-adapter");

describe("local bridge loop", function () {
  let adapter;

  afterEach(async function () {
    if (adapter) {
      await adapter.stop();
      adapter = null;
    }
  });

  async function deployLocalBridge() {
    const [owner, user, ethRecipient] = await ethers.getSigners();
    const relayerWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    await owner.sendTransaction({
      to: relayerWallet.address,
      value: ethers.parseEther("1"),
    });

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();

    const Custody = await ethers.getContractFactory("OctraUSDCustody");
    const custody = await Custody.deploy(await usdt.getAddress(), relayerWallet.address, owner.address);

    await usdt.mint(user.address, ethers.parseUnits("1000", 6));

    return { owner, user, ethRecipient, relayerWallet, usdt, custody };
  }

  function testDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocusd-local-e2e-"));
    return openDatabase(path.join(dir, "relayer.sqlite"));
  }

  it("locks MockUSDT, mints through the mock Octra adapter, burns, releases, and rejects replays", async function () {
    const { user, ethRecipient, relayerWallet, usdt, custody } = await deployLocalBridge();
    adapter = createMockOctraAdapter();
    const adapterUrl = await adapter.start();
    const store = testDb();
    const amount = ethers.parseUnits("25", 6);
    const mintAmount = netAfterBridgeFee(amount.toString(), 10);
    const releaseAmount = netAfterBridgeFee(mintAmount.net, 10);
    const octraRecipient = "octLocalRecipient";

    const context = createRelayer(
      {
        ethProvider: ethers.provider,
        ethWallet: relayerWallet,
        ethRpcUrl: "hardhat-in-process",
        custodyContract: await custody.getAddress(),
        octraRpcUrl: adapterUrl,
        octraTokenContract: "octraLocalToken",
        octraRelayerAddress: "octraRelayer",
        ethPrivateKey: relayerWallet.privateKey,
        octraPrivateKey: Buffer.alloc(32, 1).toString("base64"),
        confirmationsRequired: 0,
        octraSubmitEndpoint: `${adapterUrl}/submit`,
        octraEventsEndpoint: `${adapterUrl}/events`,
        bridgeFeeBps: 10,
        minOctraRelayerBalanceOu: "1000",
      },
      store
    );

    await usdt.connect(user).approve(await custody.getAddress(), amount);
    await custody.connect(user).deposit(amount, octraRecipient);

    const minted = await scanEthereumDepositsOnce(context);
    expect(minted).to.have.length(1);

    const mintCalls = adapter.mintCalls();
    expect(mintCalls).to.have.length(1);
    expect(mintCalls[0]).to.include({
      contract: "octraLocalToken",
      method: "mint",
    });
    expect(mintCalls[0].params).to.deep.equal([octraRecipient, mintAmount.net, 1]);

    const secondMintPass = await scanEthereumDepositsOnce(context);
    expect(secondMintPass).to.have.length(0);
    expect(adapter.mintCalls()).to.have.length(1);

    adapter.injectBurn({
      user_address: octraRecipient,
      amount: mintAmount.net,
      burn_nonce: 1,
      eth_recipient: ethRecipient.address,
    });

    const beforeRelease = await usdt.balanceOf(ethRecipient.address);
    const released = await scanOctraBurnsOnce(context);
    expect(released).to.have.length(1);
    expect(await usdt.balanceOf(ethRecipient.address)).to.equal(beforeRelease + BigInt(releaseAmount.net));
    expect(await custody.usedBurnNonces(1)).to.equal(true);

    const secondReleasePass = await scanOctraBurnsOnce(context);
    expect(secondReleasePass).to.have.length(0);
    expect(await usdt.balanceOf(ethRecipient.address)).to.equal(beforeRelease + BigInt(releaseAmount.net));

    adapter.injectBurn({
      tx_hash: "mock-burn-replay",
      user_address: octraRecipient,
      amount: mintAmount.net,
      burn_nonce: 1,
      eth_recipient: ethRecipient.address,
    });

    const replayReleasePass = await scanOctraBurnsOnce(context);
    expect(replayReleasePass).to.have.length(0);
    expect(await usdt.balanceOf(ethRecipient.address)).to.equal(beforeRelease + BigInt(releaseAmount.net));

    const fullLoopNoop = await runOnce(context);
    expect(fullLoopNoop.minted).to.have.length(0);
    expect(fullLoopNoop.released).to.have.length(0);

    store.db.close();
  });

  it("leaves deposits pending when the Octra relayer reserve is too low", async function () {
    const { user, relayerWallet, usdt, custody } = await deployLocalBridge();
    adapter = createMockOctraAdapter();
    adapter.state.relayerBalance = "999";
    const adapterUrl = await adapter.start();
    const store = testDb();
    const amount = ethers.parseUnits("10", 6);

    const context = createRelayer(
      {
        ethProvider: ethers.provider,
        ethWallet: relayerWallet,
        ethRpcUrl: "hardhat-in-process",
        custodyContract: await custody.getAddress(),
        octraRpcUrl: adapterUrl,
        octraTokenContract: "octraLocalToken",
        octraRelayerAddress: "octraRelayer",
        ethPrivateKey: relayerWallet.privateKey,
        octraPrivateKey: Buffer.alloc(32, 1).toString("base64"),
        confirmationsRequired: 0,
        octraCallFee: "1000",
        octraSubmitEndpoint: `${adapterUrl}/submit`,
        octraEventsEndpoint: `${adapterUrl}/events`,
        bridgeFeeBps: 10,
        minOctraRelayerBalanceOu: "1000",
      },
      store
    );

    await usdt.connect(user).approve(await custody.getAddress(), amount);
    await custody.connect(user).deposit(amount, "octLocalRecipient");

    const minted = await scanEthereumDepositsOnce(context);
    expect(minted).to.have.length(0);
    expect(adapter.mintCalls()).to.have.length(0);
    expect(store.pendingEthDeposits()).to.have.length(1);

    store.db.close();
  });
});
