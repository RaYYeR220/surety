// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMusdPeg
/// @notice MUSD/USD built from Mezo's own pools.
interface IMusdPeg {
    /// @notice Fewer than the minimum number of sources produced a usable price.
    error PegUnavailable();

    /// @notice Median MUSD/USD of the usable sources, scaled to 1e18. Reverts with PegUnavailable when too few
    /// sources are usable.
    function musdUsdWad() external view returns (uint256);

    /// @notice True when enough sources are usable, they agree with each other and their median sits inside the
    /// accepted band around $1. Never reverts.
    function pegHealthy() external view returns (bool);
}
