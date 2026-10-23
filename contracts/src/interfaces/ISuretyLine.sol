// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAdapter} from "vault-v2/interfaces/IAdapter.sol";

/// @title ISuretyLine
/// @notice A Surety-native credit line: a VaultV2 adapter that tracks its own bad debt and can be made whole.
/// @dev `realAssets()` is inherited from IAdapter.
interface ISuretyLine is IAdapter {
    /// @notice Cumulative shortfall recorded on positions closed below their debt.
    function badDebtTotal() external view returns (uint256);

    /// @notice Pulls `assets` of the loan asset from the caller to restore the line after a loss.
    function receiveCover(uint256 assets) external;
}
