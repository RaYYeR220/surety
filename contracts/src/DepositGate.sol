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
/// - The treasury always receives shares too, without asking the pool: it is the management-fee recipient. VaultV2
///   asks the gate about each fee recipient in every accrual (the first vault call of a transaction), and while a
///   cover is being re-recognised `depositsPaused` reads the vault's accrued total assets, which accrues again and asks
///   the gate again: the recursion burns all the gas the caller gave it. Answering the treasury here breaks that
///   loop. Letting it through is safe:
///   - it receives fee shares only, minted for elapsed time at `managementFee * totalAssets` and never for MUSD
///     paid in, so it cannot time an entry around a cover the way a deposit could;
///   - fee shares minted during a recognition dilute the cover in recognition by the fee's share of supply over that
///     time: at 0.20% a year, 0.0038% of the cover for a one-week recognition (0.002 * 7 / 365);
///   - it must stay a fee sink, never a depositor: the gate cannot tell a fee mint from a deposit or transfer to the
///     treasury, so the treasury account must not deposit or buy shares while deposits are paused.
///   A zero treasury means none.
/// - Withdrawals stay open: VaultV2 gates exits only through the send-shares and receive-assets gates, which Surety
///   leaves unset, and in-kind exits through `forceDeallocate` are untouched.
/// - While paused, every new share receiver other than the pool and the treasury waits: deposits and mints, share
///   transfers, and the pool's claim and refund payouts (those revert until deposits reopen; nothing is lost
///   meanwhile).
/// - Never reverts, as VaultV2 requires of gates: if the pool's view reverts, receivers other than the pool and the
///   treasury wait.
/// - Every fee recipient must be answered without reading the vault: assumes the pool stays the performance-fee
///   recipient and `treasury` the management-fee recipient. Re-check this whenever a fee or recipient changes.
contract DepositGate is IReceiveSharesGate {
    /// @notice The SuretyPool whose `depositsPaused` the gate follows.
    ISuretyPool public immutable pool;
    /// @notice The vault's management-fee recipient, always let through; zero for none.
    address public immutable treasury;

    error ZeroAddress();

    constructor(ISuretyPool pool_, address treasury_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        pool = pool_;
        treasury = treasury_;
    }

    /// @inheritdoc IReceiveSharesGate
    function canReceiveShares(address account) external view returns (bool open) {
        open = account == address(pool) || (account == treasury && account != address(0));
        if (open) return open;
        try pool.depositsPaused() returns (bool paused) {
            open = !paused;
        } catch {}
    }
}
