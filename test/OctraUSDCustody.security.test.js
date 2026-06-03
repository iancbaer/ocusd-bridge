const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("OctraUSDCustody — security hardening", function () {
  async function deployFixture() {
    const [owner, relayer, user, recipient, attacker, otherRelayer] = await ethers.getSigners();

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();

    const Custody = await ethers.getContractFactory("OctraUSDCustody");
    const custody = await Custody.deploy(await usdt.getAddress(), relayer.address, owner.address);

    // Fund the custody contract with 1000 USDT and give user 100 USDT
    await usdt.mint(await custody.getAddress(), 1_000_000_000n);
    await usdt.mint(user.address, 100_000_000n);

    return { owner, relayer, user, recipient, attacker, otherRelayer, usdt, custody };
  }

  async function signWithdrawal(signer, custody, recipient, amount, burnNonce) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [recipient, amount, burnNonce, await custody.getAddress(), chainId]
    );
    return signer.signMessage(ethers.getBytes(messageHash));
  }

  // ─── WITHDRAWAL GUARD BYPASS ATTEMPTS ───────────────────────────────────────

  it("rejects withdraw while paused", async function () {
    const { owner, relayer, recipient, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 10_000_000n, 1);
    await custody.connect(owner).pause();
    await expect(custody.withdraw(recipient.address, 10_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "EnforcedPause");
  });

  it("rejects withdraw with tampered recipient", async function () {
    const { relayer, recipient, attacker, custody } = await loadFixture(deployFixture);
    // Relayer signed for `recipient` but attacker substitutes their own address
    const sig = await signWithdrawal(relayer, custody, recipient.address, 10_000_000n, 1);
    await expect(custody.withdraw(attacker.address, 10_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
  });

  it("rejects withdraw with tampered amount", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 10_000_000n, 1);
    // Try to claim 10x what was signed
    await expect(custody.withdraw(recipient.address, 100_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
  });

  it("rejects withdraw with tampered burn nonce", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 10_000_000n, 1);
    await expect(custody.withdraw(recipient.address, 10_000_000n, 2, sig))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
  });

  it("rejects zero-address recipient", async function () {
    const { relayer, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, ethers.ZeroAddress, 10_000_000n, 1);
    await expect(custody.withdraw(ethers.ZeroAddress, 10_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidAddress");
  });

  it("rejects zero-amount withdrawal", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 0n, 1);
    await expect(custody.withdraw(recipient.address, 0n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidAmount");
  });

  it("rejects burn nonce 0 after it has been used", async function () {
    // Nonce 0 is a valid nonce (mapping returns false by default for unused nonces)
    // Confirm it can be used once and then rejected on replay
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 1_000_000n, 0);
    await custody.withdraw(recipient.address, 1_000_000n, 0, sig);
    await expect(custody.withdraw(recipient.address, 1_000_000n, 0, sig))
      .to.be.revertedWithCustomError(custody, "BurnNonceAlreadyUsed").withArgs(0);
  });

  // ─── CROSS-CONTRACT REPLAY ───────────────────────────────────────────────────

  it("rejects signature issued for a different custody contract (cross-contract replay)", async function () {
    const [, relayer2, , recipient2] = await ethers.getSigners();
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt2 = await MockUSDT.deploy();
    const Custody = await ethers.getContractFactory("OctraUSDCustody");
    const [owner2] = await ethers.getSigners();
    // Deploy a second custody contract with the same relayer
    const custody2 = await Custody.deploy(await usdt2.getAddress(), relayer2.address, owner2.address);
    await usdt2.mint(await custody2.getAddress(), 1_000_000_000n);

    const { relayer, recipient, custody } = await loadFixture(deployFixture);

    // Sign for custody2 but try to replay on custody1
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256"],
      [recipient.address, 10_000_000n, 1, await custody2.getAddress(), chainId]
    );
    const sig = await relayer.signMessage(ethers.getBytes(messageHash));

    await expect(custody.withdraw(recipient.address, 10_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
  });

  // ─── RELAYER KEY ROTATION IMPACT ─────────────────────────────────────────────

  it("invalidates signatures from old relayer after key rotation", async function () {
    const { owner, relayer, recipient, otherRelayer, custody } = await loadFixture(deployFixture);
    const sig = await signWithdrawal(relayer, custody, recipient.address, 10_000_000n, 1);

    // Rotate to a new relayer before the user can claim
    await custody.connect(owner).setRelayerSigner(otherRelayer.address);

    // The old signature is now invalid — user who burned ocUSD cannot claim
    await expect(custody.withdraw(recipient.address, 10_000_000n, 1, sig))
      .to.be.revertedWithCustomError(custody, "InvalidSignature");
    // NOTE: This is expected behavior but means in-flight burns lose their signatures on rotation.
    // The new relayer must re-issue signatures for any pending burns.
  });

  it("rejects setRelayerSigner to zero address", async function () {
    const { owner, custody } = await loadFixture(deployFixture);
    await expect(custody.connect(owner).setRelayerSigner(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(custody, "InvalidAddress");
  });

  it("non-owner cannot pause or unpause", async function () {
    const { attacker, custody } = await loadFixture(deployFixture);
    await expect(custody.connect(attacker).pause())
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount");
    await expect(custody.connect(attacker).unpause())
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount");
  });

  // ─── DEPOSIT GUARDS ──────────────────────────────────────────────────────────

  it("rejects deposit below MIN_DEPOSIT (1 USDT)", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    await usdt.connect(user).approve(await custody.getAddress(), 999_999n);
    await expect(custody.connect(user).deposit(999_999n, "oct1abc"))
      .to.be.revertedWithCustomError(custody, "BelowMinDeposit");
  });

  it("rejects zero-amount deposit", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    await usdt.connect(user).approve(await custody.getAddress(), 1_000_000n);
    await expect(custody.connect(user).deposit(0n, "oct1abc"))
      .to.be.revertedWithCustomError(custody, "BelowMinDeposit");
  });

  it("rejects empty octraRecipient string", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    await usdt.connect(user).approve(await custody.getAddress(), 1_000_000n);
    await expect(custody.connect(user).deposit(1_000_000n, ""))
      .to.be.revertedWithCustomError(custody, "InvalidAddress");
  });

  it("rejects oversized octraRecipient string (>100 bytes)", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    const longAddr = "oct" + "A".repeat(100); // 103 bytes total
    await usdt.connect(user).approve(await custody.getAddress(), 1_000_000n);
    await expect(custody.connect(user).deposit(1_000_000n, longAddr))
      .to.be.revertedWithCustomError(custody, "RecipientTooLong");
  });

  it("accepts octraRecipient exactly at max length (100 bytes)", async function () {
    const { user, usdt, custody } = await loadFixture(deployFixture);
    const maxAddr = "A".repeat(100);
    await usdt.connect(user).approve(await custody.getAddress(), 1_000_000n);
    await expect(custody.connect(user).deposit(1_000_000n, maxAddr)).to.emit(custody, "Deposited");
  });

  // ─── FUNDS INTEGRITY ─────────────────────────────────────────────────────────

  it("withdraw sends funds to recipient, not caller", async function () {
    const { relayer, recipient, attacker, usdt, custody } = await loadFixture(deployFixture);
    const amount = 10_000_000n;
    const sig = await signWithdrawal(relayer, custody, recipient.address, amount, 1);
    const beforeAttacker = await usdt.balanceOf(attacker.address);

    // Attacker submits the tx but funds still go to recipient
    await custody.connect(attacker).withdraw(recipient.address, amount, 1, sig);

    expect(await usdt.balanceOf(recipient.address)).to.equal(amount);
    expect(await usdt.balanceOf(attacker.address)).to.equal(beforeAttacker);
  });

  it("withdrawal exceeding contract balance reverts (SafeERC20)", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const contractBalance = await (await ethers.getContractFactory("MockUSDT"))
      .attach(await (await ethers.getContractFactory("OctraUSDCustody")).attach(await custody.getAddress()).USDT())
      .balanceOf(await custody.getAddress());

    const overAmount = contractBalance + 1n;
    const sig = await signWithdrawal(relayer, custody, recipient.address, overAmount, 99);
    await expect(custody.withdraw(recipient.address, overAmount, 99, sig))
      .to.be.reverted; // SafeERC20 reverts on insufficient balance
  });

  it("multiple independent withdrawals with different nonces all succeed", async function () {
    const { relayer, recipient, usdt, custody } = await loadFixture(deployFixture);
    const amount = 5_000_000n;
    for (let nonce = 1; nonce <= 5; nonce++) {
      const sig = await signWithdrawal(relayer, custody, recipient.address, amount, nonce);
      await custody.withdraw(recipient.address, amount, nonce, sig);
    }
    expect(await usdt.balanceOf(recipient.address)).to.equal(amount * 5n);
  });

  // ─── WITHDRAWAL CAP ──────────────────────────────────────────────────────────

  it("rejects withdrawal above maxWithdrawalAmount", async function () {
    const { relayer, recipient, custody } = await loadFixture(deployFixture);
    const cap = await custody.maxWithdrawalAmount();
    const overCap = cap + 1n;
    const sig = await signWithdrawal(relayer, custody, recipient.address, overCap, 1);
    await expect(custody.withdraw(recipient.address, overCap, 1, sig))
      .to.be.revertedWithCustomError(custody, "ExceedsWithdrawalCap");
  });

  it("owner can raise the withdrawal cap and a larger withdrawal then succeeds", async function () {
    const { owner, relayer, recipient, usdt, custody } = await loadFixture(deployFixture);
    const newCap = 20_000n * 1_000_000n; // 20,000 USDT
    await custody.connect(owner).setMaxWithdrawalAmount(newCap);
    expect(await custody.maxWithdrawalAmount()).to.equal(newCap);

    // Fund custody with enough for the large withdrawal
    await usdt.mint(await custody.getAddress(), 20_000n * 1_000_000n);

    const amount = 15_000n * 1_000_000n;
    const sig = await signWithdrawal(relayer, custody, recipient.address, amount, 1);
    await expect(custody.withdraw(recipient.address, amount, 1, sig))
      .to.emit(custody, "Withdrawn").withArgs(recipient.address, amount, 1);
  });

  it("non-owner cannot change maxWithdrawalAmount", async function () {
    const { attacker, custody } = await loadFixture(deployFixture);
    await expect(custody.connect(attacker).setMaxWithdrawalAmount(1n))
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount");
  });

  // ─── EMERGENCY WITHDRAWAL ────────────────────────────────────────────────────

  it("emergencyWithdraw reverts if not initiated", async function () {
    const { owner, recipient, custody } = await loadFixture(deployFixture);
    await expect(custody.connect(owner).emergencyWithdraw(recipient.address))
      .to.be.revertedWithCustomError(custody, "EmergencyNotInitiated");
  });

  it("emergencyWithdraw reverts during the 48-hour timelock", async function () {
    const { owner, recipient, custody } = await loadFixture(deployFixture);
    await custody.connect(owner).initiateEmergencyWithdraw();
    await expect(custody.connect(owner).emergencyWithdraw(recipient.address))
      .to.be.revertedWithCustomError(custody, "EmergencyTimelockNotExpired");
  });

  it("emergencyWithdraw drains contract after timelock passes", async function () {
    const { owner, recipient, usdt, custody } = await loadFixture(deployFixture);
    const { time } = require("@nomicfoundation/hardhat-network-helpers");

    await custody.connect(owner).initiateEmergencyWithdraw();
    await time.increase(48 * 3600 + 1);

    const before = await usdt.balanceOf(await custody.getAddress());
    await expect(custody.connect(owner).emergencyWithdraw(recipient.address))
      .to.emit(custody, "EmergencyWithdrawExecuted")
      .withArgs(recipient.address, before);

    expect(await usdt.balanceOf(await custody.getAddress())).to.equal(0n);
    expect(await usdt.balanceOf(recipient.address)).to.equal(before);
  });

  it("emergencyWithdraw resets unlock time (cannot replay without re-initiating)", async function () {
    const { owner, recipient, custody } = await loadFixture(deployFixture);
    const { time } = require("@nomicfoundation/hardhat-network-helpers");

    await custody.connect(owner).initiateEmergencyWithdraw();
    await time.increase(48 * 3600 + 1);
    await custody.connect(owner).emergencyWithdraw(recipient.address);

    // emergencyUnlockTime is reset to 0 — second call must re-initiate
    await expect(custody.connect(owner).emergencyWithdraw(recipient.address))
      .to.be.revertedWithCustomError(custody, "EmergencyNotInitiated");
  });

  it("non-owner cannot initiate or execute emergency withdraw", async function () {
    const { attacker, recipient, custody } = await loadFixture(deployFixture);
    await expect(custody.connect(attacker).initiateEmergencyWithdraw())
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount");
    await expect(custody.connect(attacker).emergencyWithdraw(recipient.address))
      .to.be.revertedWithCustomError(custody, "OwnableUnauthorizedAccount");
  });
});
