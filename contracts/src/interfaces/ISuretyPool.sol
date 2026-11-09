// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Line id under which the VoteAllocator reports the yield of the vault's idle MUSD parked in sMUSD. No credit
/// line can have it (line ids count up from zero), and `distributeFees` credits its fee part to the reserve.
uint256 constant SAVINGS_LINE_ID = type(uint256).max;

/// @title ISuretyPool
/// @notice Holds voter reward cohorts that act as first loss for the lines they voted for.
interface ISuretyPool {
    /// @notice Attributes newly received vault fee shares to the cohorts of `cohortEpoch`, pro rata to `interest`.
    /// Interest reported under SAVINGS_LINE_ID (savings yield) counts in the split but its part goes to the reserve.
    function distributeFees(uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest) external;

    /// @notice Records any loss `lineId` took since its last checkpoint.
    /// @return newLoss Loss recorded by this call, in the vault asset.
    function checkpoint(uint256 lineId) external returns (uint256 newLoss);

    /// @notice Whether new vault shares should wait: a loss is pending or uncovered, or a cover's MUSD is still being
    /// re-recognised by the vault. Withdrawals are never paused.
    function depositsPaused() external view returns (bool);
}
