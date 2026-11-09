// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TickPrice
/// @notice Token prices from concentrated-liquidity ticks, where tick t prices token0 at 1.0001^t raw units of
/// token1.
/// @dev 1.0001^n is computed by binary exponentiation in 36-decimal fixed point, in which 1.0001 is exact. Every
/// product rounds down by less than 1e-36 of a value that is at least 1, and there are at most 39 of them, so the
/// relative error stays below 1e-34.
library TickPrice {
    /// @notice Largest tick magnitude a Uniswap-v3-style pool can reach (1.0001^887272 is about 2^128).
    int256 internal constant MAX_TICK = 887_272;

    uint256 internal constant ONE = 1e36;
    uint256 internal constant BASE = 1.0001e36;

    error TickOutOfRange();
    error UnsupportedDecimals();

    /// @notice 1.0001^n in 36-decimal fixed point, for n up to MAX_TICK (below 3.5e74, so it fits).
    function pow(uint256 n) internal pure returns (uint256 result) {
        // MAX_TICK is a positive constant.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (n > uint256(MAX_TICK)) revert TickOutOfRange();
        result = ONE;
        uint256 base = BASE;
        while (n != 0) {
            if (n & 1 == 1) result = Math.mulDiv(result, base, ONE);
            n >>= 1;
            // Squared only while bits remain: at most 1.0001^(2^19), about 5.9e22 in units of ONE.
            if (n != 0) base = Math.mulDiv(base, base, ONE);
        }
    }

    /// @notice Price of one whole `base` token in whole `quote` tokens, scaled to 1e18, where 1.0001^tick is the raw
    /// amount of quote per raw unit of base. For a pool at tick t, token0 in token1 is `priceWad(t, d0, d1)` and
    /// token1 in token0 is `priceWad(-t, d1, d0)`.
    /// @dev Rounds down. Decimals are at most 18, so 10^(18 + baseDecimals) and 1e36 / 10^quoteDecimals are exact.
    function priceWad(int256 tick, uint8 baseDecimals, uint8 quoteDecimals) internal pure returns (uint256) {
        if (tick > MAX_TICK || tick < -MAX_TICK) revert TickOutOfRange();
        if (baseDecimals > 18 || quoteDecimals > 18) revert UnsupportedDecimals();
        uint256 up = 10 ** (18 + uint256(baseDecimals));
        uint256 down = 10 ** uint256(quoteDecimals);
        // Safe casts: |tick| <= MAX_TICK.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (tick >= 0) return Math.mulDiv(pow(uint256(tick)), up, ONE * down);
        // forge-lint: disable-next-line(unsafe-typecast)
        return Math.mulDiv(up, ONE / down, pow(uint256(-tick)));
    }

    /// @notice Arithmetic mean tick between two cumulative tick readings `window` seconds apart, rounded toward
    /// negative infinity.
    function meanTick(int56 cumulativeThen, int56 cumulativeNow, uint32 window) internal pure returns (int256 tick) {
        int256 delta = int256(cumulativeNow) - int256(cumulativeThen);
        int256 span = int256(uint256(window));
        tick = delta / span;
        // Solidity division truncates toward zero; step down for a negative remainder.
        if (delta < 0 && delta % span != 0) tick -= 1;
    }
}
