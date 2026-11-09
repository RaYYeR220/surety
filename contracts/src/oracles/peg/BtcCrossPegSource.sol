// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPriceSource} from "../../interfaces/IPriceSource.sol";
import {ICLPool} from "../../interfaces/ITigrisPools.sol";
import {ClPegSourceBase} from "./PegSourceBase.sol";

/// @title BtcCrossPegSource
/// @notice MUSD/USD as BTC/USD divided by the BTC price in MUSD, the latter from the time-weighted mean tick of a
/// Tigris concentrated-liquidity BTC/MUSD pool.
/// @dev Independent of the stablecoin pools. It sets a TWAP against a spot BTC/USD, so it also moves with BTC within
/// the window (by roughly BTC's move over half of it). Not ok while the BTC/USD source reverts (a stale or bad Skip
/// round).
/// Mainnet: CL BTC/MUSD `0x9CBc1537d255768b431488305b1C7EFc2ac95022` (tick spacing 200, BTC is token0), 150
/// observation slots holding a few days, read over 30 minutes against SkipPriceSource.
/// BTC is a Mezo precompile that forge's local script run cannot execute, so its decimals are a constructor argument
/// rather than a call, and every read checks them, as SkipPriceSource does for the feed's.
contract BtcCrossPegSource is ClPegSourceBase {
    IPriceSource public immutable btcUsd;
    /// @notice Decimals the pool's BTC side is expected to report (18 on Mezo).
    uint8 public immutable btcDecimals;

    constructor(ICLPool pool_, address musd, uint32 window_, IPriceSource btcUsd_, uint8 btcDecimals_)
        ClPegSourceBase(pool_, musd, window_)
    {
        if (address(btcUsd_) == address(0)) revert ZeroAddress();
        if (btcDecimals_ > 18) revert UnsupportedDecimals();
        btcUsd = btcUsd_;
        btcDecimals = btcDecimals_;
    }

    function _musdUsdWad() internal view override returns (uint256) {
        // Low-level, so an address without code (or a malformed answer) reads as "no price" instead of reverting.
        (bool success, bytes memory ret) = other.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!success || ret.length != 32 || abi.decode(ret, (uint256)) != btcDecimals) return 0;
        try btcUsd.priceWad() returns (uint256 usd) {
            (bool ok, int256 tick) = _meanTick();
            if (!ok) return 0;
            uint256 btcInMusd = _otherInMusd(tick, btcDecimals);
            (bool fits, uint256 scaled) = Math.tryMul(usd, WAD);
            return btcInMusd == 0 || !fits ? 0 : scaled / btcInMusd;
        } catch {
            return 0;
        }
    }
}
