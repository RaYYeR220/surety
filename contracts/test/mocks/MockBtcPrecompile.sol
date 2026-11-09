// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Mezo's BTC precompile for forge tests, where the precompile does not exist. On Mezo, BTC is the native
/// coin and the precompile at 0x7b7C…0000 is its ERC-20 view: one balance, `balanceOf(a) == a.balance` (checked on
/// Mezo testnet with `eth_getBalance` against `balanceOf`), with `approve`, `transferFrom` and `permit`. veBTC locks
/// it by pulling with `transferFrom`.
/// @dev Modelled here: balances are native balances; `transfer` / `transferFrom` move native BTC with `vm.deal`, so
/// they run no code at the recipient (like the precompile's bank transfer) and a plain value transfer and an ERC-20
/// transfer show up in the same balance. Allowances are ordinary ERC-20 allowances. Not modelled: `permit`,
/// `totalSupply`. Deploy it with `etch()` so it sits at the real address.
contract MockBtcPrecompile {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PRECOMPILE = 0x7b7C000000000000000000000000000000000000;

    string public constant name = "BTC";
    string public constant symbol = "BTC";
    uint8 public constant decimals = 18;

    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    /// @notice Puts this mock's code at the precompile address and returns that address.
    function etch() external returns (address) {
        VM.etch(PRECOMPILE, address(this).code);
        return PRECOMPILE;
    }

    function balanceOf(address account) external view returns (uint256) {
        return account.balance;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        if (from.balance < value) revert InsufficientBalance();
        VM.deal(from, from.balance - value);
        VM.deal(to, to.balance + value);
        emit Transfer(from, to, value);
    }
}
