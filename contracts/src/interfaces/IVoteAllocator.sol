// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVoteAllocator
/// @notice VaultV2 allocator that moves capital across lines according to CreditVoter tallies.
interface IVoteAllocator {
    /// @notice Records an asset change in `lineId` that is not interest (a recorded loss or a cover).
    function noteAdjustment(uint256 lineId, int256 delta) external;

    /// @notice Tally epoch whose votes drive the current allocation.
    function activeTallyEpoch() external view returns (uint256);

    /// @notice Assets currently held by `lineId`, as reported by its adapter.
    function lineAssets(uint256 lineId) external view returns (uint256);
}
