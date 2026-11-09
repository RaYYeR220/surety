// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBasicPool} from "../../interfaces/ITigrisPools.sol";
import {PegSourceBase} from "./PegSourceBase.sol";

/// @title StableTwapPegSource
/// @notice MUSD/USD from a Tigris basic pool that pairs MUSD with a dollar stablecoin (mUSDC, mUSDT), the stablecoin
/// being taken as exactly $1: the pool's `quote` of one MUSD at the reserves averaged over its last `granularity`
/// observation periods.
/// @dev The pool stores an observation at most every 30 minutes, on the first swap or sync after the period, so a
/// quote reflects trading up to the latest observation and may lag by the gap since then. Not ok when the pool holds
/// fewer than `granularity` periods or the quote fails.
/// Mainnet: sAMM mUSDC/MUSD `0xed812aec0fecc8fd882ac3eccc43f3aa80a6c356` and sAMM MUSD/mUSDT
/// `0x10906a9e9215939561597b4c8e4b98f93c02031a`, both with thousands of stored observations, at granularity 2.
contract StableTwapPegSource is PegSourceBase {
    uint256 public constant MAX_GRANULARITY = 48;

    IBasicPool public immutable pool;
    address public immutable musd;
    /// @notice Number of observation periods averaged.
    uint256 public immutable granularity;
    /// @notice Decimals of the stablecoin side.
    uint8 public immutable stableDecimals;

    uint256 internal immutable musdUnit;

    error BadGranularity();

    constructor(IBasicPool pool_, address musd_, uint256 granularity_) {
        if (address(pool_) == address(0) || musd_ == address(0)) revert ZeroAddress();
        if (granularity_ == 0 || granularity_ > MAX_GRANULARITY) revert BadGranularity();
        address token0 = pool_.token0();
        address token1 = pool_.token1();
        if (token0 != musd_ && token1 != musd_) revert NotMusdPool();

        pool = pool_;
        musd = musd_;
        granularity = granularity_;
        stableDecimals = _decimals(token0 == musd_ ? token1 : token0);
        musdUnit = 10 ** _decimals(musd_);
    }

    function _musdUsdWad() internal view override returns (uint256) {
        try pool.quote(musd, musdUnit, granularity) returns (uint256 amountOut) {
            (bool fits, uint256 scaled) = Math.tryMul(amountOut, WAD);
            return fits ? scaled / 10 ** stableDecimals : 0;
        } catch {
            return 0;
        }
    }
}
