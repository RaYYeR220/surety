// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {IMusdSavingsRate} from "./interfaces/IMusdSavingsRate.sol";
import {ISavingsAdapter} from "./interfaces/ISavingsAdapter.sol";
import {LineIds} from "./libraries/LineIds.sol";

/// @title SavingsAdapter
/// @notice VaultV2 adapter that parks the Surety vault's idle MUSD in Mezo's MUSD Savings Rate vault (sMUSD). The
/// VoteAllocator makes it the vault's liquidity adapter, so deposits land in sMUSD and withdrawals pull from it; it
/// is never a credit line and never voted on.
/// @dev
/// - sMUSD is not ERC-4626: `deposit` mints and `withdraw` burns sMUSD 1:1 against MUSD, and yield is paid separately
///   in MUSD through a global index. `withdraw` also pays the holder all of its claimable yield. There are no fees,
///   pauses, cooldowns or rounding on principal; the yield share rounds down, exactly as `claimableYield` here.
/// - Position = MUSD held + sMUSD held + yield claimable now. `realAssets` reports it (zero while the vault has no
///   allocation here, as VaultV2 expects of adapters) and every allocate / deallocate returns the change that brings
///   the vault's allocation to it, after the MUSD the vault is about to pull on a deallocation.
/// - Deallocation pays from MUSD held first, then claims yield, then withdraws principal; it withdraws exactly what
///   is missing net of the yield the withdrawal pays, so no yield is left idle in the adapter. If sMUSD cannot pay
///   (its strategy cannot return principal, or the request exceeds the position) the call reverts: VaultV2 then
///   reverts the move, and nothing is booked that did not happen. A deposit or withdrawal that does not move sMUSD
///   1:1 also reverts.
/// - `realAssets` never reverts, as VaultV2 requires: if sMUSD's views revert (a broken upgrade of the proxy), it
///   reports the MUSD held plus the sMUSD balance at the adapter's last deposit or withdrawal, without yield.
/// - `interestEarnedTotal` counts the yield sMUSD paid the adapter plus what is claimable, independently of the
///   capital moved in or out, so the VoteAllocator never reads savings yield from `realAssets`, which deposits,
///   withdrawals and VaultV2's permissionless `forceDeallocate` all move.
/// - Trust: sMUSD is an upgradeable proxy administered by Mezo, and its owner can switch its strategy; both can make
///   withdrawals revert. The VoteAllocator's owner can then stop parking (the vault's liquidity adapter is unset, so
///   deposits and withdrawals use idle MUSD only).
contract SavingsAdapter is ISavingsAdapter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // Every state-changing entry point is nonReentrant and calls only sMUSD and VaultV2 views; the Harvested event
    // reports what those calls did. Yield is measured from MUSD balance deltas rather than from `claimYield`'s return
    // value, so the yield `withdraw` pays is counted the same way. The moves themselves are logged by VaultV2's
    // Allocate and Deallocate events.
    // forge-lint: disable-start(reentrancy-events, unused-return, missing-events-arithmetic)

    uint256 internal constant WAD = 1e18;

    /// @inheritdoc ISavingsAdapter
    address public immutable parentVault;
    /// @notice The vault asset (MUSD).
    IERC20 public immutable musd;
    /// @inheritdoc ISavingsAdapter
    IMusdSavingsRate public immutable savings;
    /// @inheritdoc ISavingsAdapter
    bytes32 public immutable adapterId;

    /// @notice sMUSD held after the adapter's last deposit or withdrawal; `realAssets` falls back to it only if
    /// sMUSD's views revert.
    uint256 public principal;
    /// @notice Cumulative MUSD yield sMUSD has paid the adapter.
    uint256 public yieldClaimed;

    /// @param yield MUSD yield claimed.
    /// @param deposited MUSD deposited back into sMUSD (the yield and any other MUSD the adapter held).
    event Harvested(uint256 yield, uint256 deposited);

    error ZeroAddress();
    error AssetMismatch();
    error NotVault();
    error InvalidData();
    /// @notice sMUSD did not pay what the deallocation needs: `available` is what the adapter could pay.
    error InsufficientLiquidity(uint256 requested, uint256 available);
    /// @notice A deposit or withdrawal did not move the adapter's sMUSD balance 1:1.
    error SavingsMismatch();

    /// @param parentVault_ The Surety VaultV2 (asset MUSD).
    /// @param savings_ Mezo's sMUSD vault; its yield token must be the vault asset.
    constructor(address parentVault_, IMusdSavingsRate savings_) {
        if (parentVault_ == address(0) || address(savings_) == address(0)) revert ZeroAddress();
        address asset = IVaultV2(parentVault_).asset();
        if (savings_.yieldToken() != asset) revert AssetMismatch();
        parentVault = parentVault_;
        musd = IERC20(asset);
        savings = savings_;
        adapterId = LineIds.adapterId(address(this));
        IERC20(asset).forceApprove(parentVault_, type(uint256).max);
    }

    /* VaultV2 adapter */

    /// @notice Deposits every MUSD the adapter holds (the `assets` VaultV2 just sent, plus any yield or leftover)
    /// into sMUSD and reports the new position.
    function allocate(bytes memory data, uint256, bytes4, address)
        external
        nonReentrant
        returns (bytes32[] memory, int256)
    {
        _checkCaller(data);
        _depositHeld();
        return (ids(), _syncAllocation(0));
    }

    /// @notice Makes `assets` MUSD available for VaultV2 to pull: MUSD held first, then yield, then principal.
    /// Reverts if sMUSD cannot pay it.
    function deallocate(bytes memory data, uint256 assets, bytes4, address)
        external
        nonReentrant
        returns (bytes32[] memory, int256)
    {
        _checkCaller(data);
        uint256 held = musd.balanceOf(address(this));
        if (assets > held) _release(assets, assets - held);
        return (ids(), _syncAllocation(assets));
    }

    /// @inheritdoc ISavingsAdapter
    function harvest() external nonReentrant returns (uint256 yield) {
        yield = _claim();
        uint256 held = musd.balanceOf(address(this));
        _depositHeld();
        emit Harvested(yield, held);
    }

    /// @notice VaultV2 cap ids: this adapter only.
    function ids() public view returns (bytes32[] memory ids_) {
        ids_ = new bytes32[](1);
        ids_[0] = adapterId;
    }

    /* Views */

    /// @notice Position as VaultV2 values it; zero while the vault has no allocation here. Never reverts.
    function realAssets() external view returns (uint256) {
        if (IVaultV2(parentVault).allocation(adapterId) == 0) return 0;
        try this.position() returns (uint256 assets) {
            return assets;
        } catch {
            return musd.balanceOf(address(this)) + principal;
        }
    }

    /// @notice MUSD held, plus sMUSD held, plus yield claimable now. Reverts if sMUSD's views do.
    function position() public view returns (uint256) {
        uint256 staked = savings.balanceOf(address(this));
        return musd.balanceOf(address(this)) + staked + _claimable(staked);
    }

    /// @notice Yield sMUSD would pay the adapter on a claim now (before any yield the claim itself brings in).
    function claimableYield() external view returns (uint256) {
        return _claimable(savings.balanceOf(address(this)));
    }

    /// @inheritdoc ISavingsAdapter
    function interestEarnedTotal() external view returns (uint256) {
        return yieldClaimed + _claimable(savings.balanceOf(address(this)));
    }

    /* Internals */

    function _checkCaller(bytes memory data) internal view {
        if (msg.sender != parentVault) revert NotVault();
        if (data.length != 0) revert InvalidData();
    }

    /// @dev Brings the MUSD held up to `assets`, `missing` short: claims yield if that covers it, else withdraws the
    /// principal that, with the yield the withdrawal pays, covers it. Yield can only grow inside the sMUSD call (its
    /// PCV may distribute first), so the payout is at least what was missing; anything above stays held.
    function _release(uint256 assets, uint256 missing) internal {
        uint256 staked = savings.balanceOf(address(this));
        uint256 yield = _claimable(staked);
        if (missing <= yield) {
            _claim();
        } else {
            uint256 amount = missing - yield;
            if (amount > staked) revert InsufficientLiquidity(assets, assets - missing + staked + yield);
            uint256 before = musd.balanceOf(address(this));
            savings.withdraw(amount);
            uint256 received = musd.balanceOf(address(this)) - before;
            uint256 stakedAfter = savings.balanceOf(address(this));
            if (stakedAfter + amount != staked || received < amount) revert SavingsMismatch();
            principal = stakedAfter;
            yieldClaimed += received - amount;
        }
        uint256 held = musd.balanceOf(address(this));
        if (held < assets) revert InsufficientLiquidity(assets, held);
    }

    /// @dev Claims the adapter's yield; returns and counts what arrived.
    function _claim() internal returns (uint256 yield) {
        uint256 before = musd.balanceOf(address(this));
        savings.claimYield();
        yield = musd.balanceOf(address(this)) - before;
        yieldClaimed += yield;
    }

    /// @dev Deposits every MUSD held into sMUSD and checks it minted exactly that much.
    function _depositHeld() internal {
        uint256 held = musd.balanceOf(address(this));
        if (held == 0) return;
        uint256 staked = savings.balanceOf(address(this));
        musd.forceApprove(address(savings), held);
        savings.deposit(held);
        uint256 stakedAfter = savings.balanceOf(address(this));
        if (stakedAfter != staked + held) revert SavingsMismatch();
        principal = stakedAfter;
    }

    /// @dev The change that brings the vault's allocation to the position left once VaultV2 pulls `outgoing`.
    function _syncAllocation(uint256 outgoing) internal view returns (int256) {
        uint256 newAllocation = position() - outgoing;
        uint256 oldAllocation = IVaultV2(parentVault).allocation(adapterId);
        // Both are bounded by the MUSD supply, far below 2**255.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(newAllocation) - int256(oldAllocation);
    }

    /// @dev Yield on `staked` sMUSD: what sMUSD credited at the last update plus the index growth since, rounded
    /// down per update exactly as sMUSD does.
    function _claimable(uint256 staked) internal view returns (uint256 yield) {
        yield = savings.claimableYield(address(this));
        if (staked == 0) return yield;
        uint256 index = savings.yieldIndex();
        uint256 own = savings.supplyYieldIndex(address(this));
        if (index > own) yield += staked * (index - own) / WAD;
    }
    // forge-lint: disable-end(reentrancy-events, unused-return, missing-events-arithmetic)
}
