// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPriceSource
/// @notice BTC/USD price with 18 decimals. Implementations revert instead of returning unusable data.
interface IPriceSource {
    /// @notice The underlying feed has not updated within the allowed age.
    error StalePrice();
    /// @notice The underlying feed returned a non-positive answer or a malformed round.
    error BadPrice();

    /// @notice BTC/USD price scaled to 1e18.
    function priceWad() external view returns (uint256);
}
