// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IMusdSavingsRate} from "../../src/interfaces/IMusdSavingsRate.sol";

/// @notice Mezo's MUSD Savings Rate vault (sMUSD) as deployed (MUSDSavingsRate behind a proxy, IdleStrategy): 1:1
/// deposits and withdrawals, yield pushed in by anyone through `receiveProtocolYield` and spread over the sMUSD
/// supply with a global index, `withdraw` paying the caller's yield along with its MUSD.
/// @dev Test hooks: `queueProtocolYield` makes the next deposit or withdrawal push yield first, as the real vault
/// does when its PCV distributes during those calls; `freezeWithdrawals` / `freezeDeposits` make them revert, as an
/// illiquid strategy or a broken upgrade would.
contract MockSavingsRate is ERC20, IMusdSavingsRate {
    IERC20 public immutable musdToken;

    uint256 public yieldIndex;
    mapping(address => uint256) public supplyYieldIndex;
    mapping(address => uint256) public claimableYield;
    uint256 public pendingYield;

    uint256 public queuedYield;
    bool public withdrawalsFrozen;
    bool public depositsFrozen;

    error ZeroAmount();
    error InsufficientBalance();
    error AmountTooSmall();
    error StrategyIlliquid();
    error DepositsFrozen();

    constructor(IERC20 musd_) ERC20("MUSD Savings Rate", "sMUSD") {
        musdToken = musd_;
    }

    function yieldToken() external view returns (address) {
        return address(musdToken);
    }

    function balanceOf(address account) public view override(ERC20, IMusdSavingsRate) returns (uint256) {
        return super.balanceOf(account);
    }

    function totalSupply() public view override(ERC20, IMusdSavingsRate) returns (uint256) {
        return super.totalSupply();
    }

    function deposit(uint256 amount) external {
        if (depositsFrozen) revert DepositsFrozen();
        if (amount == 0) revert ZeroAmount();
        _distributeQueued();
        musdToken.transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf(msg.sender) < amount) revert InsufficientBalance();
        if (withdrawalsFrozen) revert StrategyIlliquid();
        _distributeQueued();
        _claimYield(msg.sender);
        _burn(msg.sender, amount);
        musdToken.transfer(msg.sender, amount);
    }

    function claimYield() external returns (uint256) {
        return _claimYield(msg.sender);
    }

    /// @notice Pulls `amount` MUSD from the caller and spreads it over the sMUSD supply.
    function receiveProtocolYield(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        musdToken.transferFrom(msg.sender, address(this), amount);
        _receiveYield(amount);
    }

    /* Test hooks */

    /// @notice Yield (MUSD already sent to this contract) that the next deposit or withdrawal distributes first.
    function queueProtocolYield(uint256 amount) external {
        queuedYield += amount;
    }

    function freezeWithdrawals(bool frozen) external {
        withdrawalsFrozen = frozen;
    }

    function freezeDeposits(bool frozen) external {
        depositsFrozen = frozen;
    }

    /* Internals */

    function _distributeQueued() internal {
        uint256 amount = queuedYield;
        if (amount == 0) return;
        queuedYield = 0;
        _receiveYield(amount);
    }

    function _claimYield(address account) internal returns (uint256 amount) {
        _updateYieldFor(account);
        amount = claimableYield[account];
        if (amount != 0) {
            claimableYield[account] = 0;
            musdToken.transfer(account, amount);
        }
    }

    function _receiveYield(uint256 amount) internal {
        uint256 supply = totalSupply();
        if (supply == 0) {
            pendingYield += amount;
            return;
        }
        uint256 ratio = (amount + pendingYield) * 1e18 / supply;
        pendingYield = 0;
        if (ratio == 0) revert AmountTooSmall();
        yieldIndex += ratio;
    }

    function _updateYieldFor(address account) internal {
        uint256 supplied = balanceOf(account);
        uint256 index = yieldIndex;
        if (supplied != 0) {
            uint256 delta = index - supplyYieldIndex[account];
            if (delta != 0) claimableYield[account] += supplied * delta / 1e18;
        }
        supplyYieldIndex[account] = index;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != to) {
            _updateYieldFor(from);
            _updateYieldFor(to);
        }
        super._update(from, to, value);
    }
}
