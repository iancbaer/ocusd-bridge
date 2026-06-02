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

    IERC20 public immutable USDT;
    address public relayerSigner;
    uint256 public depositNonce;
    mapping(uint256 => bool) public usedBurnNonces;

    event Deposited(address indexed user, uint256 amount, string octraRecipient, uint256 nonce);
    event Withdrawn(address indexed recipient, uint256 amount, uint256 indexed octraBurnNonce);
    event RelayerSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event BridgePaused(address indexed account);
    event BridgeUnpaused(address indexed account);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error BurnNonceAlreadyUsed(uint256 octraBurnNonce);

    constructor(address usdtAddress, address relayerSigner_, address initialOwner) Ownable(initialOwner) {
        if (usdtAddress == address(0) || relayerSigner_ == address(0) || initialOwner == address(0)) {
            revert InvalidAddress();
        }

        USDT = IERC20(usdtAddress);
        relayerSigner = relayerSigner_;

        emit RelayerSignerUpdated(address(0), relayerSigner_);
    }

    function deposit(uint256 amount, string calldata octraRecipient) external whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (bytes(octraRecipient).length == 0) revert InvalidAddress();

        uint256 nonce = ++depositNonce;
        USDT.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount, octraRecipient, nonce);
    }

    function withdraw(
        address recipient,
        uint256 amount,
        uint256 octraBurnNonce,
        bytes calldata signature
    ) external whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (usedBurnNonces[octraBurnNonce]) revert BurnNonceAlreadyUsed(octraBurnNonce);

        bytes32 digest = withdrawalDigest(recipient, amount, octraBurnNonce);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != relayerSigner) revert InvalidSignature();

        usedBurnNonces[octraBurnNonce] = true;
        USDT.safeTransfer(recipient, amount);

        emit Withdrawn(recipient, amount, octraBurnNonce);
    }

    function setRelayerSigner(address newRelayerSigner) external onlyOwner {
        if (newRelayerSigner == address(0)) revert InvalidAddress();

        address oldSigner = relayerSigner;
        relayerSigner = newRelayerSigner;

        emit RelayerSignerUpdated(oldSigner, newRelayerSigner);
    }

    function pause() external onlyOwner {
        _pause();
        emit BridgePaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit BridgeUnpaused(msg.sender);
    }

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
