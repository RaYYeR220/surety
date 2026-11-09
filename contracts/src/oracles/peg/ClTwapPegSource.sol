// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICLPool} from "../../interfaces/ITigrisPools.sol";
import {ClPegSourceBase} from "./PegSourceBase.sol";

/// @title ClTwapPegSource
/// @notice MUSD/USD from the time-weighted mean tick of a Tigris concentrated-liquidity pool that pairs MUSD with a
/// dollar stablecoin (mUSDC, mUSDT), the stablecoin being taken as exactly $1.
/// @dev Not ok unless the pool kept at least `minLiquidity` in range (harmonic mean) over the window; see
/// ClPegSourceBase. A push out of range therefore drops this source for one window instead of moving it.
/// Mainnet: CL mUSDC/MUSD `0xCC372B7E15535aB225fe17c1075831D38ef7aC1a` (tick spacing 10, mUSDC is token0 with 6
/// decimals), whose 600 observation slots hold weeks of history, read over 30 minutes with `minLiquidity` 1e19.
/// The floor comes from 672 half-hour windows between 2026-10-26 and 2026-11-09 (blocks 12,778,087-13,102,180):
/// - steady state held 4.2e19-9.5e20 in range (2.67e20 at block 13,100,532), all in a few narrow positions;
/// - LP repositioning dipped single windows to 1e17-4e18, and on Nov 2-3 the price sat for hours in dust ranges
///   (5e14-6e15, reading as low as $0.966) or out of range;
/// - with 1e19 the source read in 96.7% of the windows and missed only those.
/// Resting a push at the floor takes a position of about 4,900 MUSD per 10-tick spacing near $1.05, which an
/// arbitrageur can trade against for the whole window.
contract ClTwapPegSource is ClPegSourceBase {
    /// @notice Decimals of the stablecoin side.
    uint8 public immutable stableDecimals;

    constructor(ICLPool pool_, address musd, uint32 window_, uint128 minLiquidity_)
        ClPegSourceBase(pool_, musd, window_, minLiquidity_)
    {
        address token0 = pool_.token0();
        stableDecimals = _decimals(token0 == musd ? pool_.token1() : token0);
    }

    /// @dev The mean-tick price of one MUSD in the stablecoin.
    function _musdUsdWad() internal view override returns (uint256) {
        (bool ok, int256 tick) = _meanTick();
        return ok ? _musdInOther(tick, stableDecimals) : 0;
    }
}
