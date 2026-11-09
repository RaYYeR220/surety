// Hand-written, from the verified sources on the Mezo explorer: the parts of Mezo's vote-escrow contracts that
// harvest planning reads (PoolsVoter, a Velodrome v2 style Voter; the per-gauge fee and bribe rewards; the veBTC
// RewardsDistributor), and the Tigris basic pool calls the keeper uses to keep the peg's pools fresh.
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

/**
 * Tigris basic pool (Velodrome v2 `Pool`): `sync` is permissionless and appends an observation (with unchanged
 * reserves when nobody traded) once `periodSize` (30 minutes) has passed since the previous one.
 */
export const tigrisBasicPoolAbi = parseAbi([
  "function sync()",
  "function lastObservation() view returns ((uint256 timestamp, uint256 reserve0Cumulative, uint256 reserve1Cumulative))",
  "function periodSize() view returns (uint256)",
]);
