// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

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
/// @notice Time-weighted mean tick of a Tigris concentrated-liquidity pool that holds MUSD.
/// @dev The pool, the window and the token order are fixed at deployment, which reads the pool's tokens and MUSD's
/// decimals once. Subclasses fix the other token's decimals.
abstract contract ClPegSourceBase is PegSourceBase {
    /// @notice Shortest and longest accepted TWAP windows.
    uint32 public constant MIN_WINDOW = 1 minutes;
    uint32 public constant MAX_WINDOW = 1 days;

    ICLPool public immutable pool;
    /// @notice TWAP window in seconds.
    uint32 public immutable window;
    /// @notice Whether MUSD is the pool's token0.
    bool public immutable musdIsToken0;
    /// @notice The pool's other token.
    address public immutable other;

    uint8 internal immutable musdDecimals;

    error BadWindow();

    constructor(ICLPool pool_, address musd, uint32 window_) {
        if (address(pool_) == address(0) || musd == address(0)) revert ZeroAddress();
        if (window_ < MIN_WINDOW || window_ > MAX_WINDOW) revert BadWindow();
        address token0 = pool_.token0();
        address token1 = pool_.token1();
        if (token0 != musd && token1 != musd) revert NotMusdPool();

        pool = pool_;
        window = window_;
        musdIsToken0 = token0 == musd;
        other = token0 == musd ? token1 : token0;
        musdDecimals = _decimals(musd);
    }

    /// @dev Mean tick over the last `window` seconds. Not ok when the pool has no liquidity in range, cannot look
    /// back `window` seconds, or a call fails.
    function _meanTick() internal view returns (bool ok, int256 tick) {
        try pool.liquidity() returns (uint128 liquidity) {
            ok = liquidity != 0;
        } catch {}
        if (!ok) return (ok, tick);
        ok = false;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        // The seconds-per-liquidity values are not used.
        // forge-lint: disable-next-line(unused-return)
        try pool.observe(secondsAgos) returns (int56[] memory cumulatives, uint160[] memory) {
            if (cumulatives.length == 2) {
                tick = TickPrice.meanTick(cumulatives[0], cumulatives[1], window);
                ok = tick <= TickPrice.MAX_TICK && tick >= -TickPrice.MAX_TICK;
            }
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
