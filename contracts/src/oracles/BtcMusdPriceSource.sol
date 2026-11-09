// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMusdPeg} from "../interfaces/IMusdPeg.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title BtcMusdPriceSource
/// @notice BTC priced in MUSD: BTC/USD divided by MUSD/USD, with MUSD never taken below $1.
/// @dev `priceWad = btcUsd * 1e18 / max(peg, 1e18)`, where the peg is MusdPeg's median, or exactly $1 while MusdPeg
/// has too few usable sources. Conservative both ways for collateral: a MUSD above $1 lowers the BTC price in MUSD,
/// a MUSD below $1 is ignored, so BTC is never valued above BTC/USD.
/// Reverts only when the BTC/USD source does, so liquidations keep working through a depeg. The fallback applies
/// only to MusdPeg's `PegUnavailable`; any other failure, including running out of gas, propagates.
contract BtcMusdPriceSource is IPriceSource {
    uint256 internal constant WAD = 1e18;

    IPriceSource public immutable btcUsd;
    IMusdPeg public immutable peg;

    error ZeroAddress();

    constructor(IPriceSource btcUsd_, IMusdPeg peg_) {
        if (address(btcUsd_) == address(0) || address(peg_) == address(0)) revert ZeroAddress();
        btcUsd = btcUsd_;
        peg = peg_;
    }

    /// @notice BTC price in MUSD, WAD.
    function priceWad() external view returns (uint256) {
        uint256 price = btcUsd.priceWad();
        uint256 musdUsd = musdUsdWad();
        return musdUsd > WAD ? Math.mulDiv(price, WAD, musdUsd) : price;
    }

    /// @notice MUSD/USD this source divides by before the floor at $1: the peg's median, or $1 while it is
    /// unavailable.
    function musdUsdWad() public view returns (uint256) {
        try peg.musdUsdWad() returns (uint256 musdUsd) {
            return musdUsd;
        } catch (bytes memory reason) {
            // Only a bare 4-byte error is converted, so nothing is cut off.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (reason.length == 4 && bytes4(reason) == IMusdPeg.PegUnavailable.selector) return WAD;
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
