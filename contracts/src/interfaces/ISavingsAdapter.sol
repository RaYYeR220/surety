// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAdapter} from "vault-v2/interfaces/IAdapter.sol";

import {IMusdSavingsRate} from "./IMusdSavingsRate.sol";

/// @title ISavingsAdapter
/// @notice VaultV2 adapter that parks the vault's idle MUSD in sMUSD. Never a credit line.
interface ISavingsAdapter is IAdapter {
    /// @notice The VaultV2 the adapter belongs to.
    function parentVault() external view returns (address);

    /// @notice The sMUSD vault the adapter deposits into.
    function savings() external view returns (IMusdSavingsRate);

    /// @notice VaultV2 cap id of the adapter (its only id).
    function adapterId() external view returns (bytes32);

    /// @notice Cumulative MUSD yield the adapter has earned in sMUSD: paid out to it so far plus claimable now.
    /// Never decreases and is not moved by capital entering or leaving, so its difference over a window is the
    /// yield of that window.
    function interestEarnedTotal() external view returns (uint256);

    /// @notice Claims the adapter's yield and deposits every MUSD it holds back into sMUSD. Permissionless.
    /// @return yield MUSD yield claimed.
    function harvest() external returns (uint256 yield);
}
