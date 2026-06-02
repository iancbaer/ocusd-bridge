const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { openDatabase } = require("../relayer/db");

describe("Relayer accounting integration", function () {
  async function deployFixture() {
    const [owner, relayer, user, recipient] = await ethers.getSigners();
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();
    const Custody = await ethers.getContractFactory("OctraUSDCustody");
    const custody = await Custody.deploy(await usdt.getAddress(), relayer.address, owner.address);
    await usdt.mint(user.address, 100_000_000n);
    return { owner, relayer, user, recipient, usdt, custody };
  }

  async function signWithdrawal(signer, custody, recipient, amount, burnNonce) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [recipient, amount, burnNonce, await custody.getAddress(), chainId]
    );
    return signer.signMessage(ethers.getBytes(messageHash));
  }

  it("tracks a deposit, simulated Octra mint, simulated burn, and USDT release exactly once", async function () {
    const { relayer, user, recipient, usdt, custody } = await loadFixture(deployFixture);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocusd-relayer-"));
    const store = openDatabase(path.join(dir, "relayer.sqlite"));
    const amount = 12_345_678n;

    await usdt.connect(user).approve(await custody.getAddress(), amount);
    const depositTx = await custody.connect(user).deposit(amount, "octRecipient");
    const depositReceipt = await depositTx.wait();
    const depositLog = depositReceipt.logs
      .map((log) => {
        try {
          return custody.interface.parseLog(log);
        } catch (_) {
          return null;
        }
      })
      .find((log) => log && log.name === "Deposited");

    const depositEvent = {
      txHash: depositTx.hash,
      blockNumber: depositReceipt.blockNumber,
      userAddress: user.address,
      amount: depositLog.args.amount.toString(),
      octraRecipient: depositLog.args.octraRecipient,
      depositNonce: Number(depositLog.args.nonce),
    };

    store.upsertEthDeposit(depositEvent);
    store.upsertEthDeposit(depositEvent);
    expect(store.pendingEthDeposits()).to.have.length(1);

    const deposit = store.pendingEthDeposits()[0];
    store.markEthDepositMinted(deposit.id, "octraMintTx1");
    expect(store.pendingEthDeposits()).to.have.length(0);

    const burnEvent = {
      octraTxHash: "octraBurnTx1",
      blockHeight: 100,
      userAddress: "octRecipient",
      amount: amount.toString(),
      burnNonce: 1,
      ethRecipient: recipient.address,
    };
    store.upsertOctraBurn(burnEvent);
    store.upsertOctraBurn(burnEvent);
    expect(store.pendingOctraBurns()).to.have.length(1);

    const burn = store.pendingOctraBurns()[0];
    const signature = await signWithdrawal(relayer, custody, burn.eth_recipient, burn.amount, burn.burn_nonce);
    await custody.withdraw(burn.eth_recipient, burn.amount, burn.burn_nonce, signature);
    store.markOctraBurnReleased(burn.id, "ethReleaseTx1");

    expect(await usdt.balanceOf(await custody.getAddress())).to.equal(0n);
    expect(await usdt.balanceOf(recipient.address)).to.equal(amount);
    expect(await custody.usedBurnNonces(1)).to.equal(true);
    expect(store.pendingOctraBurns()).to.have.length(0);
  });
});
