// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract OctraUSDCustody is Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ── Constants ──────────────────────────────────────────────────────────────
    uint256 public constant MIN_DEPOSIT = 1_000_000;        // 1 USDT (6 decimals)
    uint256 public constant MAX_RECIPIENT_LEN = 100;        // max octraRecipient bytes
    uint256 public constant EMERGENCY_DELAY = 48 hours;

    // ── Storage ────────────────────────────────────────────────────────────────
    IERC20 public immutable USDT;
    address public relayerSigner;
    uint256 public depositNonce;
    mapping(uint256 => bool) public usedBurnNonces;

    uint256 public maxWithdrawalAmount = 10_000 * 1_000_000; // 10,000 USDT; owner-configurable
    uint256 public emergencyUnlockTime;                      // 0 = not initiated

    // ── Events ─────────────────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 amount, string octraRecipient, uint256 nonce);
    event Withdrawn(address indexed recipient, uint256 amount, uint256 indexed octraBurnNonce);
    event RelayerSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event MaxWithdrawalAmountUpdated(uint256 oldMax, uint256 newMax);
    event EmergencyWithdrawInitiated(uint256 unlockTime);
    event EmergencyWithdrawExecuted(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error BurnNonceAlreadyUsed(uint256 octraBurnNonce);
    error ExceedsWithdrawalCap(uint256 amount, uint256 cap);
    error RecipientTooLong();
    error BelowMinDeposit(uint256 amount, uint256 minimum);
    error EmergencyNotInitiated();
    error EmergencyTimelockNotExpired(uint256 unlockTime);

    constructor(address usdtAddress, address relayerSigner_, address initialOwner) Ownable(initialOwner) {
        if (usdtAddress == address(0) || relayerSigner_ == address(0) || initialOwner == address(0)) {
            revert InvalidAddress();
        }
        USDT = IERC20(usdtAddress);
        relayerSigner = relayerSigner_;
        emit RelayerSignerUpdated(address(0), relayerSigner_);
    }

    // ── Deposit ────────────────────────────────────────────────────────────────

    function deposit(uint256 amount, string calldata octraRecipient) external whenNotPaused {
        if (amount < MIN_DEPOSIT) revert BelowMinDeposit(amount, MIN_DEPOSIT);
        uint256 recipLen = bytes(octraRecipient).length;
        if (recipLen == 0) revert InvalidAddress();
        if (recipLen > MAX_RECIPIENT_LEN) revert RecipientTooLong();

        uint256 nonce = ++depositNonce;
        USDT.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount, octraRecipient, nonce);
    }

    // ── Withdraw ───────────────────────────────────────────────────────────────

    function withdraw(
        address recipient,
        uint256 amount,
        uint256 octraBurnNonce,
        bytes calldata signature
    ) external whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > maxWithdrawalAmount) revert ExceedsWithdrawalCap(amount, maxWithdrawalAmount);
        if (usedBurnNonces[octraBurnNonce]) revert BurnNonceAlreadyUsed(octraBurnNonce);

        bytes32 digest = withdrawalDigest(recipient, amount, octraBurnNonce);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != relayerSigner) revert InvalidSignature();

        usedBurnNonces[octraBurnNonce] = true;
        USDT.safeTransfer(recipient, amount);

        emit Withdrawn(recipient, amount, octraBurnNonce);
    }

    // ── Owner actions ──────────────────────────────────────────────────────────

    function setRelayerSigner(address newRelayerSigner) external onlyOwner {
        if (newRelayerSigner == address(0)) revert InvalidAddress();
        address oldSigner = relayerSigner;
        relayerSigner = newRelayerSigner;
        emit RelayerSignerUpdated(oldSigner, newRelayerSigner);
    }

    function setMaxWithdrawalAmount(uint256 newMax) external onlyOwner {
        if (newMax == 0) revert InvalidAmount();
        emit MaxWithdrawalAmountUpdated(maxWithdrawalAmount, newMax);
        maxWithdrawalAmount = newMax;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ── Emergency withdrawal (2-step, 48-hour timelock) ────────────────────────

    /// Initiates the 48-hour countdown. Call this if the relayer key is permanently lost.
    function initiateEmergencyWithdraw() external onlyOwner {
        emergencyUnlockTime = block.timestamp + EMERGENCY_DELAY;
        emit EmergencyWithdrawInitiated(emergencyUnlockTime);
    }

    /// Executes after the 48-hour window has passed. Transfers all USDT to `to`.
    function emergencyWithdraw(address to) external onlyOwner {
        if (emergencyUnlockTime == 0) revert EmergencyNotInitiated();
        if (block.timestamp < emergencyUnlockTime) revert EmergencyTimelockNotExpired(emergencyUnlockTime);
        if (to == address(0)) revert InvalidAddress();

        emergencyUnlockTime = 0; // reset so it can't be reused without re-initiating
        uint256 balance = USDT.balanceOf(address(this));
        USDT.safeTransfer(to, balance);
        emit EmergencyWithdrawExecuted(to, balance);
    }

    // ── View ───────────────────────────────────────────────────────────────────

    function withdrawalDigest(
        address recipient,
        uint256 amount,
        uint256 octraBurnNonce
    ) public view returns (bytes32) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(recipient, amount, octraBurnNonce, address(this), block.chainid)
        );
        return MessageHashUtils.toEthSignedMessageHash(messageHash);
    }
}
