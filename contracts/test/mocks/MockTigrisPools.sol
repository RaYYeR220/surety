// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBasicPool, ICLPool} from "../../src/interfaces/ITigrisPools.sol";

/// @notice Concentrated-liquidity pool model: `observe` answers two cumulative tick readings set by the test, and
/// reverts like Slipstream's `OLD` when asked further back than `history` seconds.
contract MockCLPool is ICLPool {
    address public immutable token0;
    address public immutable token1;

    uint128 public liquidity = 1e18;
    uint32 public history = type(uint32).max;
    int56 public cumulativeThen;
    int56 public cumulativeNow;
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
        }
    }
}

/// @notice Basic (Velodrome v2) pool model: `quote` answers a fixed amount for the expected input and reverts, like
/// the real pool's underflow, when asked for more periods than it stores.
contract MockBasicPool is IBasicPool {
    address public immutable token0;
    address public immutable token1;

    uint256 public amountOut;
    uint256 public periods = 100;
    address public expectedIn;
    uint256 public expectedAmount;

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

    function setPeriods(uint256 periods_) external {
        periods = periods_;
    }

    function quote(address tokenIn, uint256 amountIn, uint256 granularity) external view returns (uint256) {
        if (granularity > periods) revert BadQuote();
        if (tokenIn != expectedIn || amountIn != expectedAmount) revert BadQuote();
        return amountOut;
    }
}
