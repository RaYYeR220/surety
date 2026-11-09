// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPegSource} from "../../interfaces/IPegSource.sol";
import {ICLPool} from "../../interfaces/ITigrisPools.sol";
import {TickPrice} from "../../libraries/TickPrice.sol";

/// @title PegSourceBase
/// @notice Shared range check of the MUSD/USD sources. Internally a price of zero means "no usable reading".
abstract contract PegSourceBase is IPegSource {
    /// @notice Lowest reading a source reports as usable. Anything lower is taken as a broken market, not a price.
    uint256 public constant MIN_MUSD_USD = 0.5e18;
    /// @notice Highest reading a source reports as usable.
    uint256 public constant MAX_MUSD_USD = 2e18;

    uint256 internal constant WAD = 1e18;

    error ZeroAddress();
    error NotMusdPool();
    error UnsupportedDecimals();

    /// @inheritdoc IPegSource
    function read() external view returns (bool ok, uint256 musdUsdWad) {
        musdUsdWad = _musdUsdWad();
        if (musdUsdWad < MIN_MUSD_USD || musdUsdWad > MAX_MUSD_USD) musdUsdWad = 0;
        ok = musdUsdWad != 0;
    }

    /// @dev MUSD/USD, WAD, or zero when the source cannot read its market. Must not revert.
    function _musdUsdWad() internal view virtual returns (uint256);

    function _decimals(address token) internal view returns (uint8 d) {
        d = IERC20Metadata(token).decimals();
        if (d > 18) revert UnsupportedDecimals();
    }
}

/// @title ClPegSourceBase
/// @notice Time-weighted mean tick of a Tigris concentrated-liquidity pool that holds MUSD, used only when the pool
/// stayed liquid over the whole window.
/// @dev The pool, the window, the liquidity floor and the token order are fixed at deployment, which reads the pool's
/// tokens and MUSD's decimals once. Subclasses fix the other token's decimals.
///
/// A mean tick says nothing about what it cost to move it. A thin pool can be pushed past every position into a range
/// with no liquidity, held there for free and swapped back before the read, which leaves the current tick and
/// liquidity normal and the mean tick wherever the push put it. So a reading also needs the window's harmonic-mean
/// in-range liquidity, `window * 2^128 / (growth of secondsPerLiquidityCumulativeX128 over the window)`, to reach
/// `minLiquidity`:
/// - every second with no liquidity in range adds 2^128 to the accumulator, so `t` such seconds cap the harmonic mean
///   at `window / t`. With `minLiquidity > window` (enforced) a single second out of range fails the window;
/// - `t` seconds at liquidity `l` cap it at `window * l / t`, so a push can only rest in ranges about as deep as the
///   floor, where holding the price off costs real money;
/// - the source reads again on its own once the push has left the window.
abstract contract ClPegSourceBase is PegSourceBase {
    /// @notice Shortest and longest accepted TWAP windows.
    uint32 public constant MIN_WINDOW = 1 minutes;
    uint32 public constant MAX_WINDOW = 1 days;

    ICLPool public immutable pool;
    /// @notice TWAP window in seconds.
    uint32 public immutable window;
    /// @notice Least harmonic-mean in-range liquidity over the window for a usable reading, in the pool's liquidity
    /// units.
    uint128 public immutable minLiquidity;
    /// @notice Whether MUSD is the pool's token0.
    bool public immutable musdIsToken0;
    /// @notice The pool's other token.
    address public immutable other;

    uint8 internal immutable musdDecimals;

    error BadWindow();
    error BadMinLiquidity();

    constructor(ICLPool pool_, address musd, uint32 window_, uint128 minLiquidity_) {
        if (address(pool_) == address(0) || musd == address(0)) revert ZeroAddress();
        if (window_ < MIN_WINDOW || window_ > MAX_WINDOW) revert BadWindow();
        if (minLiquidity_ <= window_) revert BadMinLiquidity();
        address token0 = pool_.token0();
        address token1 = pool_.token1();
        if (token0 != musd && token1 != musd) revert NotMusdPool();

        pool = pool_;
        window = window_;
        minLiquidity = minLiquidity_;
        musdIsToken0 = token0 == musd;
        other = token0 == musd ? token1 : token0;
        musdDecimals = _decimals(musd);
    }

    /// @notice Harmonic-mean in-range liquidity over the last `window` seconds, capped at 2^128 - 1; `ok` is false
    /// when the pool cannot look back that far. Never reverts.
    function windowLiquidity() external view returns (bool ok, uint256 liquidity) {
        (ok,, liquidity) = _observe();
    }

    /// @dev Mean tick over the last `window` seconds. Not ok when the pool has no liquidity in range now, cannot look
    /// back `window` seconds, held less than `minLiquidity` in range (harmonic mean) over the window, or a call fails.
    function _meanTick() internal view returns (bool ok, int256 tick) {
        try pool.liquidity() returns (uint128 liquidity) {
            ok = liquidity != 0;
        } catch {}
        if (!ok) return (ok, tick);

        (bool observed, int56[] memory cumulatives, uint256 harmonic) = _observe();
        if (!observed || harmonic < minLiquidity) return (false, tick);
        tick = TickPrice.meanTick(cumulatives[0], cumulatives[1], window);
        ok = tick <= TickPrice.MAX_TICK && tick >= -TickPrice.MAX_TICK;
    }

    /// @dev `observe([window, 0])`: the two tick cumulatives and the harmonic-mean liquidity between them.
    function _observe() internal view returns (bool ok, int56[] memory cumulatives, uint256 harmonic) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try pool.observe(secondsAgos) returns (int56[] memory ticks, uint160[] memory perLiquidity) {
            if (ticks.length != 2 || perLiquidity.length != 2) return (false, cumulatives, 0);
            uint160 growth;
            // The accumulator wraps at 2^160 by design; the wrapped difference is the window's growth.
            unchecked {
                growth = perLiquidity[1] - perLiquidity[0];
            }
            // window < 2^17, so the numerator fits. Growth is at least `window` while time passes, as liquidity is
            // below 2^128; zero means no time passed and reads as unlimited.
            harmonic = growth == 0 ? type(uint128).max : Math.min((uint256(window) << 128) / growth, type(uint128).max);
            return (true, ticks, harmonic);
        } catch {}
    }

    /// @dev Price of one MUSD in the other token, WAD, at `tick`.
    function _musdInOther(int256 tick, uint8 otherDecimals) internal view returns (uint256) {
        return TickPrice.priceWad(musdIsToken0 ? tick : -tick, musdDecimals, otherDecimals);
    }

    /// @dev Price of one unit of the other token in MUSD, WAD, at `tick`.
    function _otherInMusd(int256 tick, uint8 otherDecimals) internal view returns (uint256) {
        return TickPrice.priceWad(musdIsToken0 ? -tick : tick, otherDecimals, musdDecimals);
    }
}
