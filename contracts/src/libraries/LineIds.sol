// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarketParams} from "morpho-blue/interfaces/IMorpho.sol";

/// @title LineIds
/// @notice VaultV2 cap ids, encoded exactly as MorphoMarketV1AdapterV2 encodes them.
/// @dev VaultV2 caps are keyed by `keccak256(idData)`; the `*Data` variants are what
/// `increaseAbsoluteCap` / `increaseRelativeCap` take.
library LineIds {
    function adapterIdData(address adapter) internal pure returns (bytes memory) {
        return abi.encode("this", adapter);
    }

    /// @notice Id shared by every allocation made through `adapter`.
    function adapterId(address adapter) internal pure returns (bytes32) {
        return keccak256(adapterIdData(adapter));
    }

    function collateralIdData(address token) internal pure returns (bytes memory) {
        return abi.encode("collateralToken", token);
    }

    /// @notice Id shared by every allocation backed by collateral `token`, across adapters.
    function collateralId(address token) internal pure returns (bytes32) {
        return keccak256(collateralIdData(token));
    }

    function marketParamsIdData(address adapter, MarketParams memory params) internal pure returns (bytes memory) {
        return abi.encode("this/marketParams", adapter, params);
    }

    /// @notice Id of one Morpho market as seen by one MorphoMarketV1AdapterV2.
    function marketParamsId(address adapter, MarketParams memory params) internal pure returns (bytes32) {
        return keccak256(marketParamsIdData(adapter, params));
    }
}
