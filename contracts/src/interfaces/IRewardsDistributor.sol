// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRewardsDistributor
/// @notice Mezo's veBTC RewardsDistributor (BTC chain fees).
interface IRewardsDistributor {
    /// @notice Claims the NFT's accrued rewards: deposited into the lock, or paid to the owner once it expired.
    /// @return The amount claimed.
    function claim(uint256 tokenId) external returns (uint256);
}
