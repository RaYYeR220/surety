// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMusdPeg} from "../interfaces/IMusdPeg.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title BtcMusdPriceSource
/// @notice BTC priced in MUSD: BTC/USD divided by MUSD/USD, where MUSD/USD is taken from the peg only while the peg is
/// healthy, never below $1 and never above $1 plus `maxPremiumBps`.
/// @dev `priceWad = btcUsd * 1e18 / divisor`, with `divisor = clamp(median, 1e18, 1e18 + maxPremiumBps * 1e14)` while
/// MusdPeg reports `pegHealthy()`, and exactly 1e18 otherwise (unhealthy, too few sources, or any failed or malformed
/// answer).
/// - BTC is never valued above BTC/USD, so the peg cannot help anyone borrow more.
/// - The peg can lower collateral value by at most `maxPremiumBps`, and only while its sources agree with each other
///   and sit near $1. Pool readings on Mezo come from a few thin positions; whatever they are pushed to, a
///   liquidation sees BTC at no less than `BTC/USD / (1 + maxPremiumBps)`. That bound must stay well inside the
///   lines' liquidation cushion (veBTC line: trigger 65% LTV, floor 85%; Morpho: LLTV 86%).
/// - Reverts only when the BTC/USD source does, so liquidations keep working through a depeg or a broken peg.
///   A gas-starved peg call reads as $1 (BTC at BTC/USD), the higher of the possible prices, so starving it cannot
///   make a loan liquidatable; and every caller has far more work after the price than 1/64 of the gas could pay.
/// Mainnet: `maxPremiumBps` 300, the same as MusdPeg's band, so the clamp never binds below the band's edge.
contract BtcMusdPriceSource is IPriceSource {
    uint256 internal constant WAD = 1e18;
    /// @notice Highest accepted `maxPremiumBps`.
    uint16 public constant MAX_PREMIUM_BPS = 500;

    IPriceSource public immutable btcUsd;
    IMusdPeg public immutable peg;
    /// @notice Largest MUSD premium over $1 the price divides by, in basis points.
    uint16 public immutable maxPremiumBps;

    error ZeroAddress();
    error PremiumTooHigh();

    constructor(IPriceSource btcUsd_, IMusdPeg peg_, uint16 maxPremiumBps_) {
        if (address(btcUsd_) == address(0) || address(peg_) == address(0)) revert ZeroAddress();
        if (maxPremiumBps_ > MAX_PREMIUM_BPS) revert PremiumTooHigh();
        btcUsd = btcUsd_;
        peg = peg_;
        maxPremiumBps = maxPremiumBps_;
    }

    /// @notice BTC price in MUSD, WAD.
    function priceWad() external view returns (uint256) {
        uint256 price = btcUsd.priceWad();
        uint256 musdUsd = musdUsdWad();
        return musdUsd == WAD ? price : Math.mulDiv(price, WAD, musdUsd);
    }

    /// @notice MUSD/USD this source divides by, WAD: the peg's median clamped to [$1, $1 + maxPremiumBps] while the
    /// peg is healthy, else exactly $1. Never reverts.
    function musdUsdWad() public view returns (uint256) {
        (bool ok, bytes memory ret) = address(peg).staticcall(abi.encodeCall(IMusdPeg.pegHealthy, ()));
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != 1) return WAD;
        (ok, ret) = address(peg).staticcall(abi.encodeCall(IMusdPeg.musdUsdWad, ()));
        if (!ok || ret.length != 32) return WAD;
        uint256 median = abi.decode(ret, (uint256));
        uint256 cap = WAD + uint256(maxPremiumBps) * 1e14;
        return median <= WAD ? WAD : Math.min(median, cap);
    }
}
