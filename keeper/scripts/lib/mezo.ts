/**
 * The parts of Mezo's vote-escrow contracts the escrow scripts call, from their verified sources on the Mezo
 * explorer: veBTC (VotingEscrow), PoolsVoter (Voter), the per-gauge fee and bribe rewards (Velodrome v2 style
 * FeesVotingReward / BribeVotingReward) and the veBTC RewardsDistributor.
 */
import { parseAbi } from "viem";

/** Mezo epochs are weeks starting Thursday 00:00 UTC. */
export const MEZO_WEEK = 604_800n;
/** PoolsVoter refuses votes in an epoch's first hour, and in its last hour for NFTs it has not whitelisted. */
export const VOTE_WINDOW_MARGIN = 3_600n;
/** veBTC's longest lock. */
export const VEBTC_MAX_LOCK = 28n * 86_400n;

export const mezoEpochStart = (ts: bigint) => ts - (ts % MEZO_WEEK);
export const mezoEpochNext = (ts: bigint) => mezoEpochStart(ts) + MEZO_WEEK;
export const mezoVoteStart = (ts: bigint) => mezoEpochStart(ts) + VOTE_WINDOW_MARGIN;
export const mezoVoteEnd = (ts: bigint) => mezoEpochNext(ts) - VOTE_WINDOW_MARGIN;

export const veBTCLockAbi = parseAbi([
  "function createLock(uint256 value, uint256 lockDuration) returns (uint256)",
  "function votingPowerOfNFT(uint256 tokenId) view returns (uint256)",
  "function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent, uint256 boost))",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const poolsVoterAbi = parseAbi([
  "function vote(uint256 tokenId, address[] pools, uint256[] weights)",
  "function gauges(address pool) view returns (address)",
  "function gaugeToFees(address gauge) view returns (address)",
  "function gaugeToBribe(address gauge) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
  "function isWhitelistedToken(address token) view returns (bool)",
  "function weights(address pool) view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function votes(uint256 tokenId, address pool) view returns (uint256)",
  "function poolVote(uint256 tokenId, uint256 index) view returns (address)",
  "function usedWeights(uint256 tokenId) view returns (uint256)",
  "function lastVoted(uint256 tokenId) view returns (uint256)",
  "event Voted(address indexed voter, address indexed pool, uint256 indexed tokenId, uint256 weight, uint256 totalWeight, uint256 timestamp)",
]);

/** FeesVotingReward and BribeVotingReward: rewards notified in an epoch go to that epoch's voters, claimable after it. */
export const votingRewardAbi = parseAbi([
  "function notifyRewardAmount(address token, uint256 amount)",
  "function earned(address token, uint256 tokenId) view returns (uint256)",
  "function tokenRewardsPerEpoch(address token, uint256 epoch) view returns (uint256)",
  "function balanceOf(uint256 tokenId) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function isReward(address token) view returns (bool)",
  "function rewards(uint256 index) view returns (address)",
  "function rewardsListLength() view returns (uint256)",
  "event NotifyReward(address indexed from, address indexed reward, uint256 indexed epoch, uint256 amount)",
  "event ClaimRewards(address indexed from, address indexed reward, uint256 amount)",
]);

export const rewardsDistributorAbi = parseAbi([
  "function claimable(uint256 tokenId) view returns (uint256)",
  "function depositor() view returns (address)",
  "function lastTokenTime() view returns (uint256)",
  "function tokensPerWeek(uint256 week) view returns (uint256)",
  "event Claimed(uint256 indexed tokenId, uint256 indexed epochStart, uint256 indexed epochEnd, uint256 amount)",
]);

/** The distributor's depositor (chain-fee splitter): `claim` reverts until it has run for the current week. */
export const splitterAbi = parseAbi(["function activePeriod() view returns (uint256)"]);

export const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
]);

export const symbolAbi = parseAbi(["function symbol() view returns (string)"]);
