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
/// Mainnet configuration, from the readings at block 13,100,532 (2026-11-09 03:20 UTC; see test/fork/LivePeg.t.sol):
/// CL mUSDC/MUSD 30-minute TWAP 0.99144, sAMM mUSDC/MUSD 0.99125, sAMM MUSD/mUSDT 0.98604, BTC-cross on CL BTC/MUSD
/// 1.00246; median 0.99134, spread 166 bps. MUSD's 30-day market range was 0.988-1.005.
/// - `minSources` 2 of 4: no single pool prices MUSD, and one source dropping out (a stale Skip round, a pool without
///   history) does not stop borrowing.
/// - `bandBps` 300: the median sits about 90 bps under $1 and the 30-day range stays within 125 bps of it, so 300
///   bps leaves room for normal drift and still trips on a real depeg.
/// - `maxSpreadBps` 500: most of the live spread is the BTC-cross source, which sets a 30-minute TWAP against spot
///   BTC/USD and so moves with BTC inside the window. 500 bps absorbs a 3% BTC move within the window and still trips
///   when any source is off by more than the band.
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
