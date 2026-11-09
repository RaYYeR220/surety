// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPegSource
/// @notice One MUSD/USD reading for MusdPeg.
interface IPegSource {
    /// @notice MUSD/USD scaled to 1e18. `ok` is false, with a zero price, when the source cannot produce a sane value
    /// (its market has no history or no liquidity, a call fails, or the value is out of range). Never reverts.
    function read() external view returns (bool ok, uint256 musdUsdWad);
}
