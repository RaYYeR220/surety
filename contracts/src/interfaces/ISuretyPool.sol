// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISuretyPool
/// @notice Holds voter reward cohorts that act as first loss for the lines they voted for.
interface ISuretyPool {
    /// @notice Attributes newly received vault fee shares to the cohorts of `cohortEpoch`, pro rata to `interest`.
    function distributeFees(uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest) external;

    /// @notice Records any loss `lineId` took since its last checkpoint.
    /// @return newLoss Loss recorded by this call, in the vault asset.
    function checkpoint(uint256 lineId) external returns (uint256 newLoss);

    /// @notice Whether new vault shares should wait: a loss is pending or uncovered, or a cover's MUSD is still being
    /// re-recognised by the vault. Withdrawals are never paused.
    function depositsPaused() external view returns (bool);
}
