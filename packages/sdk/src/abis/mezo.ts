// Hand-written: the parts of Mezo's vote-escrow contracts that harvest planning reads, from their verified sources on
// the Mezo explorer: PoolsVoter (Velodrome v2 style Voter), the per-gauge fee and bribe rewards (FeesVotingReward /
// BribeVotingReward) and the veBTC RewardsDistributor.
import { parseAbi } from "viem";

/** PoolsVoter views: an NFT's voted pools, each pool's gauge and the gauge's fee and bribe reward contracts. */
export const mezoPoolsVoterAbi = parseAbi([
  "function poolVote(uint256 tokenId, uint256 index) view returns (address)",
  "function gauges(address pool) view returns (address)",
  "function gaugeToFees(address gauge) view returns (address)",
  "function gaugeToBribe(address gauge) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
  "function lastVoted(uint256 tokenId) view returns (uint256)",
]);

/** Fee and bribe rewards: rewards notified in a Mezo epoch go to that epoch's voters, claimable after it ends. */
export const votingRewardAbi = parseAbi([
  "function earned(address token, uint256 tokenId) view returns (uint256)",
  "function rewards(uint256 index) view returns (address)",
  "function rewardsListLength() view returns (uint256)",
]);

/** The veBTC rebase distributor. */
export const rewardsDistributorAbi = parseAbi(["function claimable(uint256 tokenId) view returns (uint256)"]);
