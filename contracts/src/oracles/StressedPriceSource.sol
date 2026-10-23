// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title StressedPriceSource
/// @notice Wraps a price source and lets anyone apply a temporary haircut to it.
/// @dev For the testnet stress deployment only: it is how a live bad-debt event is produced on demand.
/// Mainnet uses SkipPriceSource directly. A new shock replaces the active one.
contract StressedPriceSource is IPriceSource {
    uint16 public constant MAX_HAIRCUT_BPS = 9000;
    uint32 public constant MAX_SHOCK_DURATION = 2 hours;
    uint256 internal constant BPS = 10_000;

    IPriceSource public immutable base;

    /// @notice Timestamp at which the latest shock stops applying.
    uint256 public shockEndsAt;
    uint16 internal shockBps;

    event Shocked(address indexed caller, uint16 haircutBps, uint256 endsAt);

    error ZeroAddress();
    error HaircutTooHigh();
    error ShockTooLong();

    constructor(IPriceSource base_) {
        if (address(base_) == address(0)) revert ZeroAddress();
        base = base_;
    }

    /// @notice Discounts the base price by `bps` for the next `duration` seconds.
    /// @param bps Haircut in basis points, at most 9000.
    /// @param duration Seconds the haircut applies, at most 2 hours.
    function shock(uint16 bps, uint32 duration) external {
        if (bps > MAX_HAIRCUT_BPS) revert HaircutTooHigh();
        if (duration > MAX_SHOCK_DURATION) revert ShockTooLong();

        shockBps = bps;
        shockEndsAt = block.timestamp + duration;
        emit Shocked(msg.sender, bps, block.timestamp + duration);
    }

    /// @notice Haircut currently applied, zero once the shock has expired.
    function haircutBps() public view returns (uint16) {
        return block.timestamp < shockEndsAt ? shockBps : 0;
    }

    /// @inheritdoc IPriceSource
    function priceWad() external view returns (uint256) {
        return base.priceWad() * (BPS - haircutBps()) / BPS;
    }
}
