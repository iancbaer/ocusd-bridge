/*
  ocUSD Octra token contract.

  Important deployment note:
  The current public Octra developer docs and web client use AppliedML (.aml)
  syntax for programs, while this repository keeps the requested ocUSD.re path.
  This source follows the AppliedML token template shipped in Octra's webcli
  (`static/templates/token/main.aml`) and the OCS-01 style methods visible
  there. Before mainnet deployment, compile this with the current Octra compiler
  or port the same state/method/event semantics to the exact ReasonML dialect
  accepted by the target Octra toolchain.

  USDT has 6 decimals; ocUSD intentionally uses 6 decimals as well.
*/

import IOCS01 from "interfaces/IOCS01.aml"

contract ocUSD implements IOCS01 {
  state {
    name: string
    symbol: string
    total_supply: int
    decimals: int
    owner: address
    relayer_address: address
    burn_nonce: int
    balances: map[address]int
    grants: map[address]map[address]int
  }

  event Transfer(from: address, to: address, amount: int)
  event Grant(owner: address, spender: address, amount: int)
  event Minted(recipient: address, amount: int, ethDepositNonce: int)
  event Burned(caller: address, amount: int, burnNonce: int)
  event BurnedToEth(caller: address, ethRecipient: string, amount: int, burnNonce: int)
  event RelayerRotated(oldRelayer: address, newRelayer: address)

  constructor(initial_relayer: address) {
    assert_address(initial_relayer)
    self.name = "Octra USD"
    self.symbol = "ocUSD"
    self.total_supply = 0
    self.decimals = 6
    self.owner = origin
    self.relayer_address = initial_relayer
    self.burn_nonce = 0
  }

  view fn decimals(): int { return self.decimals }
  view fn balance_of(addr: address): int { return self.balances[addr] }
  view fn allowance(owner: address, spender: address): int { return self.grants[owner][spender] }
  view fn get_name(): string { return self.name }
  view fn get_symbol(): string { return self.symbol }
  view fn get_total_supply(): int { return self.total_supply }
  view fn get_relayer_address(): address { return self.relayer_address }
  view fn get_burn_nonce(): int { return self.burn_nonce }

  fn mint(recipient: address, amount: int, ethDepositNonce: int): bool {
    require(caller == self.relayer_address, "not relayer")
    assert_address(recipient)
    require(amount > 0, "amount must be positive")

    self.total_supply = self.total_supply + amount
    self.balances[recipient] = self.balances[recipient] + amount

    emit Transfer(self_addr, recipient, amount)
    emit Minted(recipient, amount, ethDepositNonce)
    return true
  }

  fn burn(amount: int): bool {
    require(amount > 0, "amount must be positive")
    let bal = self.balances[caller]
    require(bal >= amount, "insufficient balance")

    self.balances[caller] = bal - amount
    self.total_supply = self.total_supply - amount
    self.burn_nonce = self.burn_nonce + 1

    emit Transfer(caller, self_addr, amount)
    emit Burned(caller, amount, self.burn_nonce)
    return true
  }

  fn burn_to_eth(ethRecipient: string, amount: int): bool {
    require(len(ethRecipient) == 42, "invalid eth recipient")
    require(starts_with(ethRecipient, "0x"), "invalid eth recipient")
    require(amount > 0, "amount must be positive")
    let bal = self.balances[caller]
    require(bal >= amount, "insufficient balance")

    self.balances[caller] = bal - amount
    self.total_supply = self.total_supply - amount
    self.burn_nonce = self.burn_nonce + 1

    emit Transfer(caller, self_addr, amount)
    emit Burned(caller, amount, self.burn_nonce)
    emit BurnedToEth(caller, ethRecipient, amount, self.burn_nonce)
    return true
  }

  fn transfer(to: address, amount: int): bool {
    assert_address(to)
    require(amount > 0, "amount must be positive")
    let bal = self.balances[caller]
    require(bal >= amount, "insufficient balance")

    self.balances[caller] = bal - amount
    self.balances[to] = self.balances[to] + amount

    emit Transfer(caller, to, amount)
    return true
  }

  fn grant(spender: address, amount: int): bool {
    assert_address(spender)
    require(amount >= 0, "amount negative")
    self.grants[caller][spender] = amount
    emit Grant(caller, spender, amount)
    return true
  }

  fn pull(from: address, to: address, amount: int): bool {
    assert_address(from)
    assert_address(to)
    require(amount > 0, "amount must be positive")

    let allowed = self.grants[from][caller]
    require(allowed >= amount, "not allowed")
    let bal = self.balances[from]
    require(bal >= amount, "insufficient balance")

    self.balances[from] = bal - amount
    self.balances[to] = self.balances[to] + amount
    self.grants[from][caller] = allowed - amount

    emit Transfer(from, to, amount)
    return true
  }

  fn rotate_relayer(new_relayer: address): bool {
    require(caller == self.owner, "not owner")
    assert_address(new_relayer)

    let old = self.relayer_address
    self.relayer_address = new_relayer

    emit RelayerRotated(old, new_relayer)
    return true
  }
}
