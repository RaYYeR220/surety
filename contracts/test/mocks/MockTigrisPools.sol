// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBasicPool, ICLPool} from "../../src/interfaces/ITigrisPools.sol";

/// @notice Concentrated-liquidity pool model: `observe` answers two cumulative tick readings set by the test, a
/// seconds-per-liquidity accumulator whose growth over any look-back matches `windowLiquidity` in range (zero: no
/// liquidity in range throughout), and reverts like Slipstream's `OLD` when asked further back than `history`
/// seconds. The accumulator sits just above zero now, so every look-back wraps it, as a long-lived pool's does.
contract MockCLPool is ICLPool {
    address public immutable token0;
    address public immutable token1;

    uint128 public liquidity = 1e18;
    uint32 public history = type(uint32).max;
    int56 public cumulativeThen;
    int56 public cumulativeNow;
    uint256 public windowLiquidity = 1e18;
    /// @dev Seconds of any look-back spent with no liquidity in range (the rest at `windowLiquidity`).
    uint32 public secondsOutOfRange;
    bool public broken;

    error OLD();

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Makes the mean tick over `window` seconds equal `tick`.
    function setMeanTick(int24 tick, uint32 window) external {
        cumulativeThen = 1_000_000;
        cumulativeNow = 1_000_000 + int56(tick) * int56(uint56(window));
    }

    function setCumulatives(int56 then_, int56 now_) external {
        cumulativeThen = then_;
        cumulativeNow = now_;
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    function setWindowLiquidity(uint256 windowLiquidity_) external {
        windowLiquidity = windowLiquidity_;
    }

    function setSecondsOutOfRange(uint32 secondsOutOfRange_) external {
        secondsOutOfRange = secondsOutOfRange_;
    }

    function setHistory(uint32 history_) external {
        history = history_;
    }

    /// @notice Makes every call revert.
    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (broken) revert OLD();
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            if (secondsAgos[i] > history) revert OLD();
            tickCumulatives[i] = secondsAgos[i] == 0 ? cumulativeNow : cumulativeThen;
            uint256 out = secondsAgos[i] < secondsOutOfRange ? secondsAgos[i] : secondsOutOfRange;
            uint256 growth =
                (uint256(secondsAgos[i] - out) << 128) / (windowLiquidity == 0 ? 1 : windowLiquidity) + (out << 128);
            unchecked {
                secondsPerLiquidityCumulativeX128s[i] = uint160(7 - growth);
            }
        }
    }
}

/// @notice Basic (Velodrome v2) pool model: `quote` answers a fixed amount for the expected input and reverts, like
/// the real pool's underflow, when asked for more periods than it stores. The latest observation is as old as the
/// test sets, or written in the current block until it does.
contract MockBasicPool is IBasicPool {
    address public immutable token0;
    address public immutable token1;

    uint256 public amountOut;
    uint256 public periods = 100;
    address public expectedIn;
    uint256 public expectedAmount;
    uint256 public lastObservationAt;

    error BadQuote();

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setQuote(address tokenIn, uint256 amountIn, uint256 amountOut_) external {
        expectedIn = tokenIn;
        expectedAmount = amountIn;
        amountOut = amountOut_;
    }

    /// @notice Pins the latest observation's timestamp; zero follows the current block.
    function setLastObservationAt(uint256 timestamp) external {
        lastObservationAt = timestamp;
    }

    function lastObservation() external view returns (Observation memory last) {
        last.timestamp = lastObservationAt == 0 ? block.timestamp : lastObservationAt;
    }

    function setPeriods(uint256 periods_) external {
        periods = periods_;
    }

    function quote(address tokenIn, uint256 amountIn, uint256 granularity) external view returns (uint256) {
        if (granularity > periods) revert BadQuote();
        if (tokenIn != expectedIn || amountIn != expectedAmount) revert BadQuote();
        return amountOut;
    }
}
