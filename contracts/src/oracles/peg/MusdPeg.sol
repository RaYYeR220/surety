// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMusdPeg} from "../../interfaces/IMusdPeg.sol";
import {IPegSource} from "../../interfaces/IPegSource.sol";

/// @title MusdPeg
/// @notice MUSD/USD as the median of a fixed set of sources built on Mezo's own pools, with a health check that
/// blocks new borrowing while MUSD is off its peg or the sources disagree.
/// @dev Sources and thresholds are fixed at deployment; there is no owner. A source counts when its `read` returns
/// ok with a non-zero price; a source that reverts or answers malformed data counts as not ok. With an even number of
/// usable sources the median is the mean of the middle two.
///
/// Mainnet configuration. Sources: CL mUSDC/MUSD (liquidity floor 1e19), sAMM mUSDC/MUSD and sAMM MUSD/mUSDT
/// (maxAge 6 hours, granularity 2), BTC-cross on CL BTC/MUSD (floor 2e20); 30-minute windows. Measured on 672
/// half-hour samples of the live pools from 2026-10-26 to 2026-11-09 (blocks 12,778,087-13,102,180):
/// - `minSources` 2 of 4: no single pool prices MUSD, and a source that drops out (a thin CL window, a quiet stable
///   pool, a stale Skip round) does not stop borrowing while two others read.
/// - `maxSpreadBps` 1000: the honest spread peaked at 322 bps (95th percentile 157), mostly the BTC-cross source,
///   which sets a 30-minute TWAP against spot BTC/USD and so moves with BTC inside the window. 1000 keeps one lagging
///   or pushed source from tripping the breaker; the median and the band catch a real depeg.
/// - `bandBps` 300: the median stayed within 0.986-0.995, so 300 bps leaves room for drift and trips at $0.97.
/// With these values the breaker was open in 671 of 672 samples, and in all of them when the keeper syncs the stable
/// pools hourly. A source pushed out of range drops out instead of reading as an outlier, so tripping the breaker
/// takes either dropping both CL sources while a stable pool is stale (one block each, about $78 per 30 minutes) or
/// keeping MUSD about 6% off in both stable pools for an hour, open to arbitrage.
contract MusdPeg is IMusdPeg {
    uint256 public constant MAX_SOURCES = 8;
    uint256 public constant MAX_SPREAD_BPS = 2000;
    uint256 public constant MAX_BAND_BPS = 1000;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice One source's answer, as MusdPeg counts it.
    struct Reading {
        IPegSource source;
        bool ok;
        uint256 musdUsdWad;
    }

    /// @notice Least number of usable sources for a price.
    uint256 public immutable minSources;
    /// @notice Largest accepted gap between the highest and lowest usable reading, as a share of the median.
    uint256 public immutable maxSpreadBps;
    /// @notice Largest accepted distance of the median from $1.
    uint256 public immutable bandBps;

    IPegSource[] internal sourceList;

    error NoSources();
    error TooManySources();
    error ZeroAddress();
    error DuplicateSource();
    error BadParams();

    constructor(IPegSource[] memory sources_, uint256 minSources_, uint256 maxSpreadBps_, uint256 bandBps_) {
        uint256 n = sources_.length;
        if (n == 0) revert NoSources();
        if (n > MAX_SOURCES) revert TooManySources();
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (address(sources_[i]) == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                // forge-lint: disable-next-line(require-revert-in-loop)
                if (sources_[j] == sources_[i]) revert DuplicateSource();
            }
            sourceList.push(sources_[i]);
        }
        if (
            minSources_ == 0 || minSources_ > n || maxSpreadBps_ == 0 || maxSpreadBps_ > MAX_SPREAD_BPS || bandBps_ == 0
                || bandBps_ > MAX_BAND_BPS
        ) revert BadParams();

        minSources = minSources_;
        maxSpreadBps = maxSpreadBps_;
        bandBps = bandBps_;
    }

    /// @inheritdoc IMusdPeg
    function musdUsdWad() external view returns (uint256 median) {
        uint256 count;
        (count, median,,) = _aggregate();
        if (count < minSources) revert PegUnavailable();
    }

    /// @inheritdoc IMusdPeg
    function pegHealthy() external view returns (bool) {
        (uint256 count, uint256 median, uint256 low, uint256 high) = _aggregate();
        if (count < minSources) return false;
        if (high - low > Math.mulDiv(median, maxSpreadBps, BPS)) return false;
        uint256 offPeg = median > WAD ? median - WAD : WAD - median;
        return offPeg <= WAD * bandBps / BPS;
    }

    /// @notice Every source's answer, in deployment order. Never reverts.
    function readings() external view returns (Reading[] memory r) {
        uint256 n = sourceList.length;
        r = new Reading[](n);
        for (uint256 i; i < n; ++i) {
            uint256 price = _read(sourceList[i]);
            r[i] = Reading({source: sourceList[i], ok: price != 0, musdUsdWad: price});
        }
    }

    function sources() external view returns (IPegSource[] memory) {
        return sourceList;
    }

    /// @dev Number of usable readings, their median, lowest and highest; all zero without a usable reading.
    function _aggregate() internal view returns (uint256 count, uint256 median, uint256 low, uint256 high) {
        uint256 n = sourceList.length;
        uint256[] memory sorted = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 price = _read(sourceList[i]);
            if (price == 0) continue;
            // Insertion into the sorted prefix.
            uint256 j = count;
            while (j > 0 && sorted[j - 1] > price) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = price;
            ++count;
        }
        if (count == 0) return (0, 0, 0, 0);
        low = sorted[0];
        high = sorted[count - 1];
        median = count % 2 == 1 ? sorted[count / 2] : Math.average(sorted[count / 2 - 1], sorted[count / 2]);
    }

    /// @dev A source's price, zero unless the call succeeds with exactly (true, non-zero).
    function _read(IPegSource source) internal view returns (uint256 price) {
        // Sources are fixed at deployment; each call is independent and any failure only drops that source.
        // forge-lint: disable-next-line(calls-loop)
        (bool success, bytes memory ret) = address(source).staticcall(abi.encodeCall(IPegSource.read, ()));
        if (!success || ret.length != 64) return 0;
        (uint256 ok, uint256 answer) = abi.decode(ret, (uint256, uint256));
        if (ok == 1) price = answer;
    }
}
