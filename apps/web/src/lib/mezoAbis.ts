// The parts of Mezo's own contracts the app reads to vote an escrowed veBTC and claim its rewards:
// PoolsVoter (Velodrome-style Voter, checked against the verified source on the Mezo explorer), its fee and
// bribe reward contracts, and the pools' metadata.

export const poolsVoterAbi = [
  { type: "function", name: "length", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pools", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "gauges", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isAlive", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "gaugeToFees", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "gaugeToBribe", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "votes",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "lastVoted", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxVotingNum", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochStart", stateMutability: "pure", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochVoteStart", stateMutability: "pure", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochVoteEnd", stateMutability: "pure", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

/** FeesVotingReward / BribeVotingReward. */
export const votingRewardAbi = [
  { type: "function", name: "rewardsListLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rewards", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "earned",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Pool metadata: AMM pools have a symbol; concentrated pools have token0/token1 and a tick spacing. */
export const poolMetaAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
] as const;
