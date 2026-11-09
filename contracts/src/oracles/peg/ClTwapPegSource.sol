// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICLPool} from "../../interfaces/ITigrisPools.sol";
import {ClPegSourceBase} from "./PegSourceBase.sol";

/// @title ClTwapPegSource
/// @notice MUSD/USD from the time-weighted mean tick of a Tigris concentrated-liquidity pool that pairs MUSD with a
/// dollar stablecoin (mUSDC, mUSDT), the stablecoin being taken as exactly $1.
/// @dev Mainnet: CL mUSDC/MUSD `0xCC372B7E15535aB225fe17c1075831D38ef7aC1a` (tick spacing 10, mUSDC is token0 with 6
/// decimals), whose 600 observation slots hold weeks of history, read over 30 minutes. A thin pool can be held off
/// its price for a window's length; MusdPeg's median and spread check limit what one source can do.
contract ClTwapPegSource is ClPegSourceBase {
    /// @notice Decimals of the stablecoin side.
    uint8 public immutable stableDecimals;

    constructor(ICLPool pool_, address musd, uint32 window_) ClPegSourceBase(pool_, musd, window_) {
        address token0 = pool_.token0();
        stableDecimals = _decimals(token0 == musd ? pool_.token1() : token0);
    }

    /// @dev The mean-tick price of one MUSD in the stablecoin.
    function _musdUsdWad() internal view override returns (uint256) {
        (bool ok, int256 tick) = _meanTick();
        return ok ? _musdInOther(tick, stableDecimals) : 0;
    }
}
