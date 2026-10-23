// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISuretyPool
/// @notice Holds voter reward cohorts that act as first loss for the lines they voted for.
interface ISuretyPool {
    /// @notice Attributes newly received vault fee shares to the cohorts of `cohortEpoch`, pro rata to `interest`.
    function distributeFees(uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest) external;
}
