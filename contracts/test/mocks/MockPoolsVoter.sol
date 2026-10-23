// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolsVoter} from "../../src/interfaces/IPoolsVoter.sol";
import {MockVeBTC} from "./MockVeBTC.sol";

/// @notice PoolsVoter model. Mirrors the rules a veBTC holder (or a loan escrow) runs into on Mezo:
/// - `vote`, `reset` and claims require `isApprovedOrOwner(msg.sender, tokenId)` on veBTC;
/// - one vote or reset per NFT per Mezo week (`AlreadyVotedOrDeposited`), regardless of Surety's epoch length;
/// - weights are relative and scaled by current voting power, so a vote reverts `ZeroBalance` in the block the
///   NFT changed hands or once the lock has decayed to zero.
/// Gauge existence, the vote window and pool count limits are not modelled.
/// Rewards: `setReward(rewardContract, token, amount)` accrues an amount that the next
/// `claimFeesAndBribes` listing that pair pays to the NFT owner. The voter must hold the tokens.
contract MockPoolsVoter is IPoolsVoter {
    using SafeERC20 for IERC20;

    uint256 internal constant WEEK = 1 weeks;

    MockVeBTC public immutable ve;

    mapping(uint256 tokenId => mapping(address pool => uint256)) public votes;
    mapping(uint256 tokenId => uint256) public usedWeights;
    mapping(uint256 tokenId => uint256) public lastVoted;
    mapping(address rewardContract => mapping(address token => uint256)) public reward;
    mapping(uint256 tokenId => address[]) internal poolVote;

    event Voted(uint256 indexed tokenId, address indexed voter, address[] pools, uint256[] weights);
    event Reset(uint256 indexed tokenId);
    event RewardPaid(address indexed rewardContract, address indexed token, uint256 indexed tokenId, uint256 amount);

    error NotApprovedOrOwner();
    error AlreadyVotedOrDeposited();
    error LengthMismatch();
    error ZeroAddress();
    error ZeroBalance();

    constructor(MockVeBTC ve_) {
        ve = ve_;
    }

    modifier onlyNewEpoch(uint256 tokenId) {
        if (block.timestamp - block.timestamp % WEEK <= lastVoted[tokenId]) revert AlreadyVotedOrDeposited();
        _;
    }

    function vote(uint256 tokenId, address[] calldata pools, uint256[] calldata weights)
        external
        onlyNewEpoch(tokenId)
    {
        if (!ve.isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        if (pools.length != weights.length) revert LengthMismatch();

        _reset(tokenId);
        uint256 power = ve.votingPowerOfNFT(tokenId);
        uint256 totalWeight;
        for (uint256 i; i < weights.length; i++) {
            totalWeight += weights[i];
        }

        uint256 used;
        for (uint256 i; i < pools.length; i++) {
            if (pools[i] == address(0)) revert ZeroAddress();
            uint256 poolWeight = totalWeight == 0 ? 0 : weights[i] * power / totalWeight;
            if (poolWeight == 0) revert ZeroBalance();
            votes[tokenId][pools[i]] += poolWeight;
            poolVote[tokenId].push(pools[i]);
            used += poolWeight;
        }
        usedWeights[tokenId] = used;
        lastVoted[tokenId] = block.timestamp;
        if (used > 0) ve.voting(tokenId, true);
        emit Voted(tokenId, msg.sender, pools, weights);
    }

    function reset(uint256 tokenId) external onlyNewEpoch(tokenId) {
        if (!ve.isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        _reset(tokenId);
        lastVoted[tokenId] = block.timestamp;
        ve.voting(tokenId, false);
        emit Reset(tokenId);
    }

    function claimFeesAndBribes(address[] calldata rewards, address[][] calldata tokens, uint256 tokenId) external {
        if (!ve.isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        if (rewards.length != tokens.length) revert LengthMismatch();

        address owner = ve.ownerOf(tokenId);
        for (uint256 i; i < rewards.length; i++) {
            for (uint256 j; j < tokens[i].length; j++) {
                uint256 amount = reward[rewards[i]][tokens[i][j]];
                if (amount == 0) continue;
                reward[rewards[i]][tokens[i][j]] = 0;
                IERC20(tokens[i][j]).safeTransfer(owner, amount);
                emit RewardPaid(rewards[i], tokens[i][j], tokenId, amount);
            }
        }
    }

    function poolVoteOf(uint256 tokenId) external view returns (address[] memory) {
        return poolVote[tokenId];
    }

    /* Test helpers */

    /// @notice Sets the amount of `token` that `rewardContract` pays on the next claim listing it.
    function setReward(address rewardContract, address token, uint256 amount) external {
        reward[rewardContract][token] = amount;
    }

    function _reset(uint256 tokenId) internal {
        address[] storage pools = poolVote[tokenId];
        for (uint256 i; i < pools.length; i++) {
            delete votes[tokenId][pools[i]];
        }
        delete poolVote[tokenId];
        usedWeights[tokenId] = 0;
    }
}
