// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPoolsVoter
/// @notice The subset of Mezo's PoolsVoter (veBTC staking-gauge voter) that Surety calls.
interface IPoolsVoter {
    /// @notice Votes `tokenId` for `pools` with relative `weights`. One vote or reset per NFT per Mezo epoch.
    function vote(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external;

    /// @notice Removes the NFT's votes. One vote or reset per NFT per Mezo epoch.
    function reset(uint256 tokenId) external;

    /// @notice Claims fees and bribes from `rewards` for the listed `tokens`; rewards go to the NFT owner.
    function claimFeesAndBribes(address[] calldata rewards, address[][] calldata tokens, uint256 tokenId) external;
}
