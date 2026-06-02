# ocUSD Bridge

ocUSD is a centralized V1 bridge between Ethereum USDT and an Octra OCS-01 style token.

This repository intentionally implements a trusted-operator model:

```text
ETH -> Octra
1. User approves USDT to OctraUSDCustody.
2. User calls deposit(amount, octraRecipient).
3. OctraUSDCustody locks USDT and emits Deposited(user, amount, octraRecipient, nonce).
4. Relayer watches confirmed Ethereum deposits.
5. Relayer calls mint(octraRecipient, amount, ethDepositNonce) on Octra.
6. ocUSD emits Minted(recipient, amount, ethDepositNonce).

Octra -> ETH
1. User calls burn_to_eth(ethRecipient, amount) on Octra.
2. ocUSD emits Burned(caller, amount, burnNonce) and BurnedToEth(caller, ethRecipient, amount, burnNonce).
3. Relayer watches confirmed Octra burns.
4. Relayer signs keccak256(abi.encodePacked(recipient, amount, burnNonce, custody, chainId)).
5. Relayer calls withdraw(recipient, amount, burnNonce, signature) on Ethereum.
6. OctraUSDCustody marks the burn nonce used and releases USDT.
```

USDT and ocUSD both use 6 decimals. Amounts are raw base units throughout the contracts and relayer.

## Contracts

### Ethereum

`contracts/ethereum/OctraUSDCustody.sol`

- Immutable custody contract, no proxy.
- Uses OpenZeppelin `SafeERC20` for USDT.
- Uses `Ownable` and `Pausable`.
- Tracks `depositNonce`.
- Tracks `usedBurnNonces` for replay protection.
- Verifies Ethereum personal signatures over:

```solidity
keccak256(abi.encodePacked(recipient, amount, octraBurnNonce, address(this), block.chainid))
```

The relayer produces this with `wallet.signMessage(ethers.getBytes(hash))`; the contract verifies the `toEthSignedMessageHash(hash)` digest.

### Octra

`contracts/octra/ocUSD.re`

The public Octra docs currently describe AppliedML `.aml` programs and still use legacy `contract` naming in several RPC methods. This file is kept at the requested `.re` path but follows the AppliedML token syntax and OCS-01-style method names from Octra's current web client token template.

Before production deployment, compile it against the current Octra compiler or port the same state, methods, and events to the exact ReasonML dialect accepted by the target Octra toolchain.

Required deployed behavior:

- `mint(recipient, amount, ethDepositNonce)` callable only by `relayer_address`
- `burn(amount)` callable by holders
- `burn_to_eth(ethRecipient, amount)` callable by holders when redeeming to Ethereum
- `transfer(to, amount)`
- `balance_of(owner)`
- owner-only `rotate_relayer(new_relayer)`
- metadata name `Octra USD`, symbol `ocUSD`, decimals `6`

## Known Centralization Risks

V1 is centralized by design.

- The relayer is a single point of failure and trust.
- If the Octra relayer key is compromised, an attacker can mint unlimited ocUSD.
- If the Ethereum relayer key is compromised, an attacker can sign withdrawals and drain the USDT custody contract.
- V1 has no Merkle proof verification and no Octra light client. Trust is fully placed in the relayer operator.
- The decentralization path is to move toward Octra's production bridge architecture, including epoch Merkle roots, replay-protected messages, and proof verification like Octra's `EthereumBridge` at `0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE`.

Octra reference bridge contracts:

- wOCT ERC-20: `0x4647e1fE715c9e23959022C2416C71867F5a6E80`
- EthereumBridge: `0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE`
- OctraLightClient: `0xC01cA57dc7f7C4B6f1B6b87B85D79e5ddf0dF55d`

## Deployment

### 1. Install

```bash
npm install
npm test
```

### 2. Deploy Ethereum Custody

Set:

```bash
ETH_RPC_URL=
DEPLOYER_PRIVATE_KEY=
RELAYER_SIGNER_ADDRESS=
INITIAL_OWNER_ADDRESS=
USDT_ADDRESS=0xdAC17F958D2ee523a2206206994597C13D831ec7
```

Deploy:

```bash
npm run deploy:eth
```

Record the deployed `OctraUSDCustody` address as `ETH_CUSTODY_CONTRACT`.

### 3. Deploy ocUSD on Octra

Use the Octra web client dev tools or current Octra compiler:

1. Verify the current language target. Public docs now emphasize AppliedML `.aml`; this repo keeps `contracts/octra/ocUSD.re` at the requested path with Applied-style syntax.
2. Compile and deploy with constructor parameter `initial_relayer`.
3. Confirm `get_symbol()` returns `ocUSD`.
4. Confirm `decimals()` returns `6`.
5. Record the deployed address as `OCTRA_TOKEN_CONTRACT`.

### 4. Configure Relayer

Copy `.env.example` to `.env` and set:

```bash
ETH_RPC_URL=
ETH_CUSTODY_CONTRACT=
OCTRA_RPC_URL=
OCTRA_TOKEN_CONTRACT=
RELAYER_OCTRA_ADDRESS=
RELAYER_PRIVATE_KEY_ETH=
RELAYER_PRIVATE_KEY_OCTRA=
POLL_INTERVAL_MS=3000
CONFIRMATIONS_REQUIRED=2
OCTRA_CALL_FEE=1000
```

Private keys must only be loaded from environment variables. The relayer never logs them.

### 5. Start Relayer

```bash
npm run relayer
```

The daemon stores audit state in SQLite at `RELAYER_DB_PATH` or `relayer.sqlite`.

## Octra RPC Notes

Current public docs describe a JSON-RPC 2.0 endpoint at `POST /rpc`, with positional `params` arrays. Useful methods include:

- `node_status`
- `octra_balance(address)`
- `octra_submit(tx_json)`
- `octra_transaction(hash)`
- `octra_transactionsByAddress(address, limit?, offset?)`
- `contract_receipt(hash)`
- `contract_call(address, method, params?, caller?)`
- `octra_contractAbi(address)`
- `octra_compileAml(source)`
- `octra_compileAmlMulti(files, main)`

The docs also note that bridge signer methods are separate from normal node RPC in the web client and go through `/api/bridge/signer`.

The relayer's `relayer/octra.js` signs direct Octra call transactions using the same canonical transaction JSON shape found in the Octra web client:

- `from`
- `to_`
- `amount`
- `nonce`
- `ou`
- `timestamp`
- `op_type`
- `encrypted_data`
- `message`

`RELAYER_PRIVATE_KEY_OCTRA` must be a base64 32-byte seed or 64-byte Octra secret key, and `RELAYER_OCTRA_ADDRESS` must be the matching Octra account address.

The relayer also supports adapter endpoints:

- Direct JSON-RPC reads and `octra_submit` writes.
- Optional adapter endpoints with `OCTRA_EVENTS_ENDPOINT` and `OCTRA_SUBMIT_ENDPOINT` while Octra's stable third-party signed transaction schema is verified.

Check the current RPC docs before production deployment:

https://docs.octra.org/developer-docs/rpc-scheme

## Burn Recipient Caveat

The base requested Octra event is `Burned(caller, amount, burnNonce)`, but the Ethereum withdrawal requires an Ethereum `recipient`.

This repo adds `burn_to_eth(ethRecipient, amount)` and `BurnedToEth(caller, ethRecipient, amount, burnNonce)` so the relayer has an authenticated Ethereum recipient in the Octra event stream. If the target Octra compiler rejects string event fields, the operator must choose one of these before enabling releases:

- Extend the Octra burn flow to emit an Ethereum recipient, for example a `BurnedToEth(caller, ethRecipient, amount, burnNonce)` event.
- Maintain a verified off-chain mapping from Octra accounts to Ethereum recipient addresses and feed that through `OCTRA_EVENTS_ENDPOINT`.
- Restrict burn callers to Ethereum-style `0x` addresses, if Octra account semantics support that.

Without an authenticated Ethereum recipient, the relayer must not release USDT.

## Idempotency

- Ethereum deposits are unique by `deposit_nonce`.
- Octra burns are unique by `burn_nonce`.
- SQLite enforces uniqueness.
- Ethereum `usedBurnNonces` enforces replay protection on-chain.
- The daemon resumes from `last_eth_block_scanned` and `last_octra_height_scanned`.
- Failed txs are retried up to 3 times with exponential backoff.

## Reference Sources

- Octra RPC scheme: https://docs.octra.org/developer-docs/rpc-scheme
- Octra developer docs: https://docs.octra.org/developer-docs/
- OCS-01 test repo: https://github.com/octra-labs/ocs01-test
