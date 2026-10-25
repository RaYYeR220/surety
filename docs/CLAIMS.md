# Claims

Every public claim Surety makes, with the strongest evidence behind it. If a statement in the README, the app or anywhere else is not in this ledger, treat it as unsupported.

| Tier | Meaning |
| --- | --- |
| **REPRODUCIBLE** | A test or command in this repository shows it. Run `forge test` in `contracts/` and `pnpm test` at the root. |
| **VERIFIED-LIVE** | A verified contract, a transaction or a state read on chain shows it. Links in [PROOF.md](PROOF.md). |
| **MODELED** | Follows from the math or a projection shown in full, not from an observation. |
| **NOT-CLAIMED** | Something Surety explicitly does not claim. |

A claim can carry two tiers when both kinds of evidence exist.

## Mechanism

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 1 | veBTC votes decide how the vault's capital is split across credit lines, within the vault's caps. | REPRODUCIBLE, VERIFIED-LIVE | `VoteAllocatorTest`, `LifecycleTest.test_fullCycle_happyPath`; the bootstrap `rebalance` in the [lifecycle table](PROOF.md#live-lifecycle-on-testnet) (`Rebalanced` event targets) |
| 2 | A ballot's weight is the NFT's boosted veBTC power at the epoch start; locks created, merged or transferred during the epoch add nothing, and ballots in an epoch's first second are refused. | REPRODUCIBLE | `CreditVoterTest.test_vote_tallies_powerAtEpochStart`, `test_transferMidEpoch_newOwnerReplacesNotAdds`, `test_merge_mergedPowerNotCountedThisEpoch`, `test_vote_closedAtEpochStartSecond_mergeCountedOnce`; `invariant_tallyConservation` |
| 3 | NFTs held in a Surety loan escrow cannot vote on Surety's lines. | REPRODUCIBLE | `CreditVoterTest.test_vote_rejectsEscrowOwned`, `test_poke_revertsForEscrowOwned` |
| 4 | Votes cast in epoch t drive the allocation from the first rebalance of t+1, and the interest earned under them is attributed to the cohorts of t at the first rebalance of t+2. | REPRODUCIBLE | `VoteAllocatorTest`, `LifecycleTest`; the live epoch rebalance is PENDING in the [lifecycle table](PROOF.md#live-lifecycle-on-testnet) |
| 5 | Voters' rewards (the 10% performance fee and sponsor incentives) are the first loss: a line's unmatured cohorts pay before the reserve, and the reserve before lenders. | REPRODUCIBLE, VERIFIED-LIVE | `SuretyPoolTest`, `LifecycleTest.test_fullCycle_negativePath`; the two `cover` transactions and their `CohortSlashed` events ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 6 | Cohorts season for 4 epochs after a 2-epoch lag; matured cohorts are never slashed and are claimable pro rata to votes. | REPRODUCIBLE, VERIFIED-LIVE | `SuretyPoolTest`; `SEASON()` = 4 and `maturityOf` on the testnet SuretyPool |
| 7 | A cover never covers more than the recorded loss. | REPRODUCIBLE | `invariant_coverNeverExceedsLoss` |
| 8 | A full cover brings lenders back to the pre-loss share price once VaultV2 has recognised it, and the slashed cohorts net exactly the recorded loss. | REPRODUCIBLE, MODELED | `test_L04_slashedCohortNetsExactlyTheRecordedLoss`, `test_M03_jitDepositIsRefusedUntilTheCoverIsRecognised`; the sizing derivation and its stated second-order limits in [ARCHITECTURE.md](ARCHITECTURE.md#sizing-a-cover) |
| 9 | Moving capital with VaultV2's permissionless `forceDeallocate` cannot move voter fees between lines. | REPRODUCIBLE | `test_M01_forceDeallocateCannotMoveVoterFees` |
| 10 | Morpho bad debt is measured from Morpho's own supply share price and recorded in full even if shares leave before the checkpoint; no loss is recorded for a period without exposure. | REPRODUCIBLE | `test_M02_forcedExitStillRecordsTheWholeMorphoLoss`, `test_L01_noPhantomMorphoLossAfterZeroExposure`, `SuretyPoolTest` |
| 11 | New vault shares wait while a loss is unrecorded, uncovered or still being recognised; withdrawals are never paused. | REPRODUCIBLE, VERIFIED-LIVE | `test_M03_jitDepositIsRefusedUntilTheCoverIsRecognised`, `DepositGateTest`, `invariant_depositGate`; `receiveSharesGate()` and `depositsPaused()` = `true` after the live covers ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 12 | A stale oracle at an epoch's first rebalance neither discards the closed tally nor pulls capital out of the line. | REPRODUCIBLE | `test_L02_staleOracleAtFirstRebalanceKeepsClosedTally` |
| 13 | After the bootstrap, a line can only be listed through a timelock, and a listed line cannot make the pool cover more than the vault allocated to it. | REPRODUCIBLE, VERIFIED-LIVE | `test_M04_fakeLineCannotDrainReserveOrBlockRebalance`, `test_M04_veBTCLineListedOncePerAdapter`; `bootstrapEnded()` = `true` on the testnet CreditVoter (its `LINE_TIMELOCK` is 0 on testnet, 1 day on mainnet) |

## veBTC credit line

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 14 | A veBTC holder can borrow MUSD against a locked NFT without unlocking it; the NFT moves into its own escrow. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest.test_open_transfersNFTIntoFreshEscrow_andPaysBorrower`; "veBTC loan opened #1712" in the [lifecycle table](PROOF.md#live-lifecycle-on-testnet) |
| 15 | While escrowed, the NFT keeps voting on Mezo's PoolsVoter and its fees, bribes and rebase reach the borrower. | REPRODUCIBLE | `LoanEscrowTest.test_escrowVote_and_claim_forwardsRewardsToBorrower`, `test_escrowClaimRebase_compoundsWhileLive_paysBorrowerAfterExpiry` (against Mezo mocks; see NOT-CLAIMED) |
| 16 | Each loan has its own escrow with fixed targets, no generic call, no meta-transactions and no `onERC721Received`; the escrow cannot be used to move other tokens. | REPRODUCIBLE, VERIFIED-LIVE | `LoanEscrowTest.test_escrowClaim_cannotExfiltrate`, `test_escrow_onlyLine`, `invariant_escrowsHoldTheirNFT`; verified source of the [LoanEscrow implementation](https://repo.sourcify.dev/31611/0x5480eC4D37Fe1eb31793d7FEC4BE6B3Ab3806417) |
| 17 | Max LTV is 50% for timed locks and 40% for permanent locks; liquidation starts at 70% LTV or at lock end. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest`; `params()` on the testnet line |
| 18 | A defaulted loan's NFT is sold by Dutch auction from 100% of collateral value down to a 70% floor, and a sale below the debt is recorded as bad debt. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest`; "veBTC auction bid at floor" and its `Bid` event (shortfall 31.7562 MUSD) |
| 19 | New loans, extra borrowing, auctions and bids fail closed on a price older than 60 seconds; repayment never reads the price. | REPRODUCIBLE, VERIFIED-LIVE | `OraclesTest`, `VeBTCCreditLineTest`; `maxAge()` = 60 on the testnet SkipPriceSource |

## Mezo integration

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 20 | The vault is Morpho VaultV2 with MorphoMarketV1AdapterV2, vendored unmodified, from the same sources as Mezo's VaultV2 on mainnet. | VERIFIED-LIVE | File-by-file comparison with Mezo's verified contracts ([PROOF.md](PROOF.md#same-sources-as-mezo-mainnet)); submodule commit `97bcce9` |
| 21 | Prices come from Mezo's Skip BTC/USD precompile. | VERIFIED-LIVE | Verified source of the [SkipPriceSource](https://repo.sourcify.dev/31611/0x5b2889271154adD90BC4b33EaE3Bb5dDC09d6BFC) and its `aggregator()` = `0x7b7c…0015` |
| 22 | Surety uses Mezo's real testnet MUSD, veBTC, PoolsVoter and RewardsDistributor. | VERIFIED-LIVE | `external` in `contracts/deployments/31611.json`; the line's `musd()`, `ve()`, `voter()` and `distributor()` |
| 23 | Weekly epochs flip on Thursday 00:00 UTC, like Mezo's. | REPRODUCIBLE | `EpochLibTest.test_start_weekAlignsToThursday` |
| 24 | The BTC / MUSD Morpho market uses LLTV 86% and AdaptiveCurveIrm, as Mezo's Morpho Blue enables. | VERIFIED-LIVE | `marketParams` in the deployment file; Morpho Blue and AdaptiveCurveIrm verified on Sourcify |

## Deployment and live run

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 25 | All 14 contracts of the testnet deployment are verified with an exact match on Sourcify. | VERIFIED-LIVE | [PROOF.md](PROOF.md#verified-contracts) |
| 26 | The testnet vault is configured as documented: VoteAllocator as sole allocator, 10% performance fee to the SuretyPool, DepositGate as receive-shares gate, 200% a year max rate, 1% forced-exit penalty, 10,000,000 MUSD caps. | VERIFIED-LIVE | [Configuration on chain](PROOF.md#configuration-on-chain) |
| 27 | The whole lifecycle ran live on testnet: deposit, votes, rebalance, incentives, a veBTC loan, a Morpho borrow, a price shock, a Morpho liquidation with bad debt, a veBTC auction settled below the debt, loss checkpoints and covers that slashed the voters' cohorts. | VERIFIED-LIVE | [Lifecycle table](PROOF.md#live-lifecycle-on-testnet) |
| 28 | In that run the Morpho line lost 125.4043 MUSD, of which 88.4209 was covered from voters (their whole 100 srMUSD cohort) and 36.9834 stayed with lenders; the veBTC line lost 31.7562 MUSD and was covered in full for 35.6901 srMUSD of its 150 srMUSD cohort. | VERIFIED-LIVE | `Liquidate`, `Bid`, `LossRecorded`, `CohortSlashed` and `Covered` events ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 29 | Once VaultV2 has recognised the 118.63 MUSD the covers returned, which takes about three weeks at the vault's size, the testnet share price is about 0.970. | MODELED | Arithmetic in [PROOF.md](PROOF.md#the-loss-from-the-events) |
| 30 | The epoch flip after the losses attributes interest to the cohorts on chain. | VERIFIED-LIVE (PENDING) | The epoch rows of the [lifecycle table](PROOF.md#live-lifecycle-on-testnet) are not recorded yet |
| 31 | Surety is deployed on Mezo mainnet: 11 contracts, all an exact match on Sourcify, wired to Mezo's own Morpho Blue and IRM, with 1-day timelocks and 2,000 MUSD caps. | VERIFIED-LIVE | [PROOF.md](PROOF.md#mezo-mainnet-31612) |

## Tests, review and tooling

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 31 | 197 Foundry tests pass and 1 opt-in fork suite is skipped by default; 98 TypeScript tests pass (sdk 53, keeper 37, mcp 8). | REPRODUCIBLE | `forge test`, `pnpm test` |
| 32 | Seven system invariants hold over 256 runs of 64 random actions each, and any revert fails the run. | REPRODUCIBLE | `SuretyInvariants` |
| 33 | Every fixed review finding has a regression test that replays the attack against the fixed code. | REPRODUCIBLE | `AuditPoCTest`: 9 regressions and 1 verified non-issue ([SECURITY.md](SECURITY.md#findings)) |
| 34 | A large donation onto a tiny seed is not an inflation attack on later depositors. | REPRODUCIBLE | `test_NI_tinySeedDonationIsNotAnInflationAttack` |
| 35 | Slither reports 133 results on `contracts/src`, none of them a vulnerability. | REPRODUCIBLE | The command and the triage in [SECURITY.md](SECURITY.md#slither); the triage is our assessment |
| 36 | Surety deploys and runs against live Mezo mainnet state (real veBTC, MUSD, Morpho Blue and IRM). | REPRODUCIBLE | `SURETY_FORK=true forge test --match-contract LiveMezo` (BTC and Skip precompiles mocked, because a fork cannot execute them) |
| 37 | The keeper holds no role; every call it makes is open to anyone. | REPRODUCIBLE, VERIFIED-LIVE | Keeper tests; the called functions have no access control in the verified sources |
| 38 | The SDK and the MCP server never hold keys; they return unsigned transactions. | REPRODUCIBLE | `packages/sdk` and `packages/mcp` tests |

## Not claimed

| # | Not claimed | Why |
| --- | --- | --- |
| N1 | Production readiness, or safety for meaningful amounts of money | Single-key owner roles, no external audit. Mainnet runs with 2,000 MUSD caps. |
| N2 | An external audit | The reviews were internal and independent, not a contracted audit. |
| N3 | A real Mezo gauge or MEZO emissions for srMUSD | Needs a Mezo governance call to `createVaultGauge`; on the roadmap. |
| N4 | Mainnet TVL, users or volume | Mainnet is a capped launch: deployed and verified, no deposits yet. |
| N5 | That lenders never lose money | When the line's cohorts and the reserve are short, lenders bear the rest, as in the live run (36.98 MUSD). |
| N6 | That lenders are restored at once | A cover is recognised under VaultV2's `maxRate`; it can take weeks for a large loss. |
| N7 | Decentralised or timelocked administration on testnet | Every owner role is the deployer key and every timelock is zero on testnet. |
| N8 | Protection against MUSD losing its peg | MUSD is valued at exactly $1. |
| N9 | A fallback price source | Skip BTC/USD is the only source; when it is stale the lines fail closed. |
| N10 | That Surety liquidates Morpho positions | Morpho's own liquidators do; the keeper's backstop is off by default. |
| N11 | A live escrow vote or reward claim on Mezo's PoolsVoter | Tested against Mezo mocks and checked against the verified sources; the recorded run does not include one. |
| N12 | Bytecode identical to Mezo's deployments | The sources match; compiler settings differ. |
| N13 | That APYs shown in the app or SDK are realised returns | They are estimates from the current rate curves and utilisation. |
| N14 | Self-repaying veBTC loans, MEZO incentives or more collateral lines | Roadmap items, not built. |
