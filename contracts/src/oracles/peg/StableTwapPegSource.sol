// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBasicPool} from "../../interfaces/ITigrisPools.sol";
import {PegSourceBase} from "./PegSourceBase.sol";

/// @title StableTwapPegSource
/// @notice MUSD/USD from a Tigris basic pool that pairs MUSD with a dollar stablecoin (mUSDC, mUSDT), the stablecoin
/// being taken as exactly $1: the pool's `quote` of one MUSD at the reserves averaged over its last `granularity`
/// observation periods, while the latest observation is at most `maxAge` old.
/// @dev The pool appends an observation on the first swap, mint, burn or `sync` more than 30 minutes after the
/// previous one, and `quote` reads closed periods only. A pool nobody touches therefore keeps answering with reserves
/// that can be days old while the market moves elsewhere; past `maxAge` since its last observation the source reads
/// not ok instead. `sync()` is permissionless and writes an observation (with unchanged reserves when nobody traded),
/// so a keeper that syncs both pools more often than `maxAge` keeps them fresh at the cost of gas.
/// Freshness bounds where the latest period ends, not how long it is: the first observation after a long quiet spell
/// averages mostly the quiet reserves. Not ok when the pool holds fewer than `granularity` periods, its latest
/// observation is older than `maxAge`, or a call fails.
/// Mainnet: sAMM mUSDC/MUSD `0xed812aec0fecc8fd882ac3eccc43f3aa80a6c356` and sAMM MUSD/mUSDT
/// `0x10906a9e9215939561597b4c8e4b98f93c02031a`, both with thousands of stored observations, at granularity 2 and
/// `maxAge` 6 hours. Organic cadence, sampled every 30 minutes from 2026-10-26 to 2026-11-09 (672 samples), age of
/// the latest observation:
/// - sAMM mUSDC/MUSD: median 3.4 h, 90th percentile 11.2 h, max 25.6 h (fresh at 6 h in 71% of samples);
/// - sAMM MUSD/mUSDT: median 15.2 h, 90th percentile 43 h, max 57 h (fresh at 6 h in 23%).
/// The deployment's keeper syncs both pools at least hourly, which keeps both fresh and bounds how long a quiet pool
/// can hide a move to about an hour plus one period. Without the keeper, MusdPeg still reads from the CL sources.
contract StableTwapPegSource is PegSourceBase {
    uint256 public constant MAX_GRANULARITY = 48;
    /// @notice Shortest and longest accepted `maxAge`. The shortest is one observation period plus a margin.
    uint32 public constant MIN_MAX_AGE = 1 hours;
    uint32 public constant MAX_MAX_AGE = 7 days;

    IBasicPool public immutable pool;
    address public immutable musd;
    /// @notice Number of observation periods averaged.
    uint256 public immutable granularity;
    /// @notice Oldest accepted age of the pool's latest observation, in seconds.
    uint32 public immutable maxAge;
    /// @notice Decimals of the stablecoin side.
    uint8 public immutable stableDecimals;

    uint256 internal immutable musdUnit;

    error BadGranularity();
    error BadMaxAge();

    constructor(IBasicPool pool_, address musd_, uint256 granularity_, uint32 maxAge_) {
        if (address(pool_) == address(0) || musd_ == address(0)) revert ZeroAddress();
        if (granularity_ == 0 || granularity_ > MAX_GRANULARITY) revert BadGranularity();
        if (maxAge_ < MIN_MAX_AGE || maxAge_ > MAX_MAX_AGE) revert BadMaxAge();
        address token0 = pool_.token0();
        address token1 = pool_.token1();
        if (token0 != musd_ && token1 != musd_) revert NotMusdPool();

        pool = pool_;
        musd = musd_;
        granularity = granularity_;
        maxAge = maxAge_;
        stableDecimals = _decimals(token0 == musd_ ? token1 : token0);
        musdUnit = 10 ** _decimals(musd_);
    }

    /// @notice Seconds since the pool's latest observation; `ok` is false when it cannot be read. Never reverts.
    function lastObservationAge() public view returns (bool ok, uint256 age) {
        // Low-level, so a malformed answer reads as "no observation" instead of reverting.
        (bool success, bytes memory ret) = address(pool).staticcall(abi.encodeCall(IBasicPool.lastObservation, ()));
        if (!success || ret.length != 96) return (false, 0);
        uint256 timestamp = abi.decode(ret, (uint256));
        return (true, timestamp >= block.timestamp ? 0 : block.timestamp - timestamp);
    }

    function _musdUsdWad() internal view override returns (uint256) {
        (bool observed, uint256 age) = lastObservationAge();
        if (!observed || age > maxAge) return 0;
        try pool.quote(musd, musdUnit, granularity) returns (uint256 amountOut) {
            (bool fits, uint256 scaled) = Math.tryMul(amountOut, WAD);
            return fits ? scaled / 10 ** stableDecimals : 0;
        } catch {
            return 0;
        }
    }
}
