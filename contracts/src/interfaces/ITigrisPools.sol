// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICLPool
/// @notice The subset of a Tigris concentrated-liquidity pool (Velodrome Slipstream `CLPool`) that the peg sources
/// read. A tick t prices token0 at 1.0001^t raw units of token1.
interface ICLPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    /// @notice Liquidity in range at the current tick.
    function liquidity() external view returns (uint128);

    /// @notice Cumulative tick and seconds-per-liquidity values `secondsAgos[i]` seconds ago. Reverts when the
    /// oldest stored observation is younger than the largest age asked for.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @title IBasicPool
/// @notice The subset of a Tigris basic pool (Velodrome v2 `Pool`) that the peg sources read.
interface IBasicPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    /// @notice Output for `amountIn` of `tokenIn` at the reserves averaged over each of the last `granularity`
    /// observation periods (without the swap fee), averaged. Reverts when fewer periods are stored.
    function quote(address tokenIn, uint256 amountIn, uint256 granularity) external view returns (uint256 amountOut);
}
