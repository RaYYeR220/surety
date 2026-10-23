// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IReceiveSharesGate} from "vault-v2/interfaces/IGate.sol";

import {ISuretyPool} from "./interfaces/ISuretyPool.sol";

/// @title DepositGate
/// @notice The Surety vault's receive-shares gate: holds new vault shares back while the SuretyPool reports
/// `depositsPaused()`, that is while a loss is unrecorded or uncovered or a cover's MUSD is still being re-recognised.
/// VaultV2 realises a loss at once but recognises the cover that restores it only at its max rate, so without the
/// gate anyone could deposit at the depressed price, hold through the recognition and capture most of the
/// voter-funded cover meant for the lenders who took the loss.
/// @dev
/// - The SuretyPool always receives shares: it is the performance-fee recipient (VaultV2 skips the fee when its
///   recipient cannot receive shares, which the cover sizing counts on) and deposits sponsors' incentives.
/// - Withdrawals stay open: VaultV2 gates exits only through the send-shares and receive-assets gates, which Surety
///   leaves unset, and in-kind exits through `forceDeallocate` are untouched.
/// - While paused, every new share receiver other than the pool waits: deposits and mints, share transfers, and the
///   pool's claim and refund payouts (those revert until deposits reopen; nothing is lost meanwhile).
/// - Never reverts, as VaultV2 requires of gates: if the pool's view reverts, receivers other than the pool wait.
/// - Assumes the pool stays the vault's performance-fee recipient: VaultV2 asks the gate about the fee recipient in
///   every accrual, and `depositsPaused` reads the vault's accrued total assets in turn, so the pool's own answer
///   must not depend on that view.
contract DepositGate is IReceiveSharesGate {
    /// @notice The SuretyPool whose `depositsPaused` the gate follows.
    ISuretyPool public immutable pool;

    error ZeroAddress();

    constructor(ISuretyPool pool_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        pool = pool_;
    }

    /// @inheritdoc IReceiveSharesGate
    function canReceiveShares(address account) external view returns (bool open) {
        open = account == address(pool);
        if (open) return open;
        try pool.depositsPaused() returns (bool paused) {
            open = !paused;
        } catch {}
    }
}
