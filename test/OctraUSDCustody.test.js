const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("OctraUSDCustody", function () {
  async function deployFixture() {
    const [owner, relayer, user, recipient, otherRelayer] = await ethers.getSigners();

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();

    const Custody = await ethers.getContractFactory("OctraUSDCustody");
    const custody = await Custody.deploy(await usdt.getAddress(), relayer.address, owner.address);

    await usdt.mint(user.address, 1_000_000_000n);
    await usdt.mint(await custody.getAddress(), 1_000_000_000n);

    return { owner, relayer, user, recipient, otherRelayer, usdt, custody };
  }

  async function signWithdrawal(signer, custody, recipient, amount, burnNonce) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [recipient, amount, burnNonce, await custody.getAddress(), chainId]
    );

    return signer.signMessage(ethers.getBytes(messageHash));
  }

  it("emits Deposited and pulls USDT", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    const amount = 25_000_000n;

    await usdt.connect(user).approve(await custody.getAddress(), amount);

    await expect(custody.connect(user).deposit(amount, "octRecipient"))
      .to.emit(custody, "Deposited")
      .withArgs(user.address, amount, "octRecipient", 1);

    expect(await usdt.balanceOf(await custody.getAddress())).to.equal(1_000_000_000n + amount);
  });

  it("increments deposit nonce across deposits", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    const amount = 1_000_000n;

    await usdt.connect(user).approve(await custody.getAddress(), amount * 2n);

    await expect(custody.connect(user).deposit(amount, "octA"))
      .to.emit(custody, "Deposited")
      .withArgs(user.address, amount, "octA", 1);
    await expect(custody.connect(user).deposit(amount, "octB"))
      .to.emit(custody, "Deposited")
      .withArgs(user.address, amount, "octB", 2);

    expect(await custody.depositNonce()).to.equal(2);
  });

  it("withdraws with a valid relayer signature", async function () {
    const { relayer, recipient, usdt, custody } = await loadFixture(deployFixture);
    const amount = 10_000_000n;
    const burnNonce = 42;
    const signature = await signWithdrawal(relayer, custody, recipient.address, amount, burnNonce);

    await expect(custody.withdraw(recipient.address, amount, burnNonce, signature))
      .to.emit(custody, "Withdrawn")
      .withArgs(recipient.address, amount, burnNonce);

    expect(await usdt.balanceOf(recipient.address)).to.equal(amount);
    expect(await custody.usedBurnNonces(burnNonce)).to.equal(true);
  });

  it("rejects replayed burn nonces", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const amount = 10_000_000n;
    const burnNonce = 42;
    const signature = await signWithdrawal(relayer, custody, recipient.address, amount, burnNonce);

    await custody.withdraw(recipient.address, amount, burnNonce, signature);

    await expect(custody.withdraw(recipient.address, amount, burnNonce, signature))
      .to.be.revertedWithCustomError(custody, "BurnNonceAlreadyUsed")
      .withArgs(burnNonce);
  });

  it("rejects invalid signatures", async function () {
    const { otherRelayer, recipient, custody } = await loadFixture(deployFixture);
    const amount = 10_000_000n;
    const burnNonce = 42;
    const signature = await signWithdrawal(otherRelayer, custody, recipient.address, amount, burnNonce);

    await expect(custody.withdraw(recipient.address, amount, burnNonce, signature))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
  });

  it("rejects deposits while paused", async function () {
    const { owner, user, usdt, custody } = await loadFixture(deployFixture);
    const amount = 1_000_000n;

    await usdt.connect(user).approve(await custody.getAddress(), amount);
    await custody.connect(owner).pause();

    await expect(custody.connect(user).deposit(amount, "octRecipient"))
      .to.be.revertedWithCustomError(custody, "EnforcedPause");
  });

  it("allows only the owner to rotate relayerSigner", async function () {
    const { owner, user, otherRelayer, custody } = await loadFixture(deployFixture);

    await expect(custody.connect(user).setRelayerSigner(otherRelayer.address))
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount")
      .withArgs(user.address);

    await expect(custody.connect(owner).setRelayerSigner(otherRelayer.address))
      .to.emit(custody, "RelayerSignerUpdated");

    expect(await custody.relayerSigner()).to.equal(otherRelayer.address);
  });
});
