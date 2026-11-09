// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPegSource} from "../../interfaces/IPegSource.sol";
import {PegSourceBase} from "./PegSourceBase.sol";

/// @title StressedPegSource
/// @notice Passes a MUSD/USD source through and lets anyone override it for up to two hours.
/// @dev For testnet only: it is how a MUSD depeg (or an outage of the source) is produced on demand. Without a base
/// it reads exactly $1 when no override applies. A new override replaces the active one.
contract StressedPegSource is PegSourceBase {
    uint32 public constant MAX_STRESS_DURATION = 2 hours;

    /// @notice Source read when no override applies; zero for a fixed $1.
    IPegSource public immutable base;

    /// @notice Timestamp at which the latest override stops applying.
    uint256 public stressEndsAt;
    uint256 internal stressedPrice;

    /// @param musdUsdWad The override, zero for an outage.
    event Stressed(address indexed caller, uint256 musdUsdWad, uint256 endsAt);

    error PriceOutOfRange();
    error StressTooLong();

    constructor(IPegSource base_) {
        base = base_;
    }

    /// @notice Makes the source read `musdUsdWad` for the next `duration` seconds, or read nothing (not ok) when
    /// `musdUsdWad` is zero.
    /// @param musdUsdWad MUSD/USD, WAD, within [MIN_MUSD_USD, MAX_MUSD_USD], or zero.
    /// @param duration Seconds the override applies, at most 2 hours.
    function stress(uint256 musdUsdWad, uint32 duration) external {
        if (musdUsdWad != 0 && (musdUsdWad < MIN_MUSD_USD || musdUsdWad > MAX_MUSD_USD)) revert PriceOutOfRange();
        if (duration > MAX_STRESS_DURATION) revert StressTooLong();

        stressedPrice = musdUsdWad;
        stressEndsAt = block.timestamp + duration;
        emit Stressed(msg.sender, musdUsdWad, block.timestamp + duration);
    }

    /// @notice Whether an override applies now, and its value (zero for an outage).
    function activeStress() public view returns (bool active, uint256 musdUsdWad) {
        active = block.timestamp < stressEndsAt;
        if (active) musdUsdWad = stressedPrice;
    }

    /// @dev The override while one applies, else the base reading (or $1 without a base).
    function _musdUsdWad() internal view override returns (uint256) {
        (bool active, uint256 stressed) = activeStress();
        if (active) return stressed;
        if (address(base) == address(0)) return WAD;
        try base.read() returns (bool ok, uint256 price) {
            return ok ? price : 0;
        } catch {
            return 0;
        }
    }
}
