# Claims

Every public claim Surety makes, with the strongest evidence behind it. If a statement in the README, the app or anywhere else is not in this ledger, treat it as unsupported.

| Tier | Meaning |
| --- | --- |
| **REPRODUCIBLE** | A test or command in this repository shows it. Run `forge test` in `contracts/` and `pnpm test` at the root; fork tests run with `SURETY_FORK=true` against live Mezo mainnet state. |
| **VERIFIED-LIVE** | A verified contract, a transaction or a state read on chain shows it. Links in [PROOF.md](PROOF.md). |
| **MODELED** | Follows from the math or a projection shown in full, not from an observation. |
| **NOT-CLAIMED** | Something Surety explicitly does not claim. |

A claim can carry two tiers when both kinds of evidence exist. Claims 1 to 39 date from v1 and still hold unless they say otherwise; claims 40 on are new in v2. "v1 run" and "v2 run" are the two recorded lifecycles on testnet ([PROOF.md](PROOF.md#live-lifecycle-on-testnet-v2)).

## Mechanism

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 1 | veBTC votes decide how the vault's capital is split across credit lines, within the vault's caps. | REPRODUCIBLE, VERIFIED-LIVE | `VoteAllocatorTest`, `LifecycleTest.test_fullCycle_happyPath`; the bootstrap `rebalance` in the [v1 lifecycle table](PROOF.md#live-lifecycle-on-testnet) (`Rebalanced` event targets) and the v2 run's rebalance (32.40 / 75.60 MUSD on a 30/70 vote) |
| 2 | A ballot's weight is the NFT's boosted veBTC power at the epoch start; locks created, merged or transferred during the epoch add nothing, and ballots in an epoch's first second are refused. | REPRODUCIBLE | `CreditVoterTest.test_vote_tallies_powerAtEpochStart`, `test_transferMidEpoch_newOwnerReplacesNotAdds`, `test_merge_mergedPowerNotCountedThisEpoch`, `test_vote_closedAtEpochStartSecond_mergeCountedOnce`; `invariant_tallyConservation` |
| 3 | NFTs held in a Surety loan escrow cannot vote on Surety's lines. | REPRODUCIBLE | `CreditVoterTest.test_vote_rejectsEscrowOwned`, `test_poke_revertsForEscrowOwned` |
| 4 | Votes cast in epoch t drive the allocation from the first rebalance of t+1, and the interest earned under them is attributed to the cohorts of t at the first rebalance of t+2. | REPRODUCIBLE, VERIFIED-LIVE | `VoteAllocatorTest`, `LifecycleTest`; the keeper's epoch rebalances in both lifecycle tables (`InterestAttributed`, `FeesDistributed`) |
| 5 | Voters' rewards (the 10% performance fee and sponsor incentives) are the first loss: a line's unmatured cohorts pay before the reserve, and the reserve before lenders. | REPRODUCIBLE, VERIFIED-LIVE | `SuretyPoolTest`, `LifecycleTest.test_fullCycle_negativePath`; the two `cover` transactions of the v1 run and their `CohortSlashed` events ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 6 | Cohorts season for 4 epochs after a 2-epoch lag; matured cohorts are never slashed and are claimable pro rata to votes. | REPRODUCIBLE, VERIFIED-LIVE | `SuretyPoolTest`; `SEASON()` = 4 and `maturityOf` on the testnet SuretyPools |
| 7 | A cover never covers more than the recorded loss. | REPRODUCIBLE | `invariant_coverNeverExceedsLoss` |
| 8 | A full cover brings lenders back to the pre-loss share price once VaultV2 has recognised it, and the slashed cohorts net exactly the recorded loss. | REPRODUCIBLE, MODELED | `test_L04_slashedCohortNetsExactlyTheRecordedLoss`, `test_M03_jitDepositIsRefusedUntilTheCoverIsRecognised`; the sizing derivation and its stated second-order limits in [ARCHITECTURE.md](ARCHITECTURE.md#sizing-a-cover) |
| 9 | Moving capital with VaultV2's permissionless `forceDeallocate` cannot move voter fees between lines. | REPRODUCIBLE | `test_M01_forceDeallocateCannotMoveVoterFees`, `test_forceDeallocate_lineCashReparked_interestUnchanged` |
| 10 | Morpho bad debt is measured from Morpho's own supply share price and recorded in full even if shares leave before the checkpoint; no loss is recorded for a period without exposure. | REPRODUCIBLE | `test_M02_forcedExitStillRecordsTheWholeMorphoLoss`, `test_L01_noPhantomMorphoLossAfterZeroExposure`, `SuretyPoolTest` |
| 11 | New vault shares wait while a loss is unrecorded, uncovered or still being recognised; withdrawals are never paused. | REPRODUCIBLE, VERIFIED-LIVE | `test_M03_jitDepositIsRefusedUntilTheCoverIsRecognised`, `DepositGateTest`, `invariant_depositGate`; `receiveSharesGate()` and `depositsPaused()` = `true` after the v1 run's covers ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 12 | A stale oracle at an epoch's first rebalance neither discards the closed tally nor pulls capital out of the line. | REPRODUCIBLE | `test_L02_staleOracleAtFirstRebalanceKeepsClosedTally` |
| 13 | After the bootstrap, a line can only be listed through a timelock, and a listed line cannot make the pool cover more than the vault allocated to it. | REPRODUCIBLE, VERIFIED-LIVE | `test_M04_fakeLineCannotDrainReserveOrBlockRebalance`, `test_M04_veBTCLineListedOncePerAdapter`; `bootstrapEnded()` = `true` on both testnet CreditVoters (`LINE_TIMELOCK` is 0 on testnet, 1 day on mainnet) |

## veBTC credit line

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 14 | A veBTC holder can borrow MUSD against a locked NFT without unlocking it; the NFT moves into its own escrow. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest.test_open_transfersNFTIntoFreshEscrow_andPaysBorrower`; "veBTC loan opened #1712" in the v1 run, loans #1 and #2 in the v2 run |
| 15 | While escrowed, the NFT keeps voting on Mezo's PoolsVoter, and its fees, bribes and rebase reach the borrower. | REPRODUCIBLE, VERIFIED-LIVE | `LoanEscrowTest.test_escrowVote_and_claim_forwardsRewardsToBorrower`, `test_escrowClaimRebase_compoundsWhileLive_paysBorrowerAfterExpiry` (against Mezo mocks); live escrow votes in claims 46 and 69, the live claims in claim 68 |
| 16 | Each loan has its own escrow with fixed targets, no generic call, no meta-transactions and no `onERC721Received`; the escrow cannot be used to move other tokens. | REPRODUCIBLE, VERIFIED-LIVE | `LoanEscrowTest.test_escrowClaim_cannotExfiltrate`, `test_escrow_onlyLine`, `invariant_escrowsHoldTheirNFT`; verified source of the LoanEscrow implementation, [v1](https://repo.sourcify.dev/31611/0x5480eC4D37Fe1eb31793d7FEC4BE6B3Ab3806417) and [v2](https://repo.sourcify.dev/31611/0x8d4A899372b543641468731B65f05CF74bA7ec6D) |
| 17 | Max LTV is 50% for timed locks and 40% for permanent locks; liquidation starts at 65% LTV (70% in v1) or at lock end. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest`; `params()` on the testnet lines ([v2](PROOF.md#configuration-on-chain-v2), [v1](PROOF.md#configuration-on-chain)) |
| 18 | A defaulted loan's NFT is sold by Dutch auction from 100% of collateral value down to a floor, 85% in v2 (70% in v1), and a sale below the debt is recorded as bad debt. | REPRODUCIBLE, VERIFIED-LIVE | `VeBTCCreditLineTest`; "veBTC auction bid at floor" in the v1 run and its `Bid` event (shortfall 31.7562 MUSD) |
| 19 | New loans, extra borrowing, auctions and bids fail closed on a price older than 60 seconds; repayment never reads the price. | REPRODUCIBLE, VERIFIED-LIVE | `OraclesTest`, `VeBTCCreditLineTest`; `maxAge()` = 60 on the testnet SkipPriceSources |

## Mezo integration

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 20 | The vault is Morpho VaultV2 with MorphoMarketV1AdapterV2, vendored unmodified, from the same sources as Mezo's VaultV2 on mainnet. | VERIFIED-LIVE | File-by-file comparison with Mezo's verified contracts ([PROOF.md](PROOF.md#same-sources-as-mezo-mainnet)); submodule commit `97bcce9` |
| 21 | BTC prices come from Mezo's Skip BTC/USD precompile. | VERIFIED-LIVE | Verified source of the SkipPriceSource, [v1](https://repo.sourcify.dev/31611/0x5b2889271154adD90BC4b33EaE3Bb5dDC09d6BFC) and [v2](https://repo.sourcify.dev/31611/0x9F7Ce9D147920f2499840163858C23d1A165EFe8), and its `aggregator()` = `0x7b7c…0015` |
| 22 | Surety uses Mezo's real testnet MUSD, veBTC, PoolsVoter and RewardsDistributor, and in v2 Mezo's testnet sMUSD. | VERIFIED-LIVE | `external` in `contracts/deployments/v1/31611.json` and `contracts/deployments/31611.json`; the line's `musd()`, `ve()`, `voter()` and `distributor()` |
| 23 | Weekly epochs flip on Thursday 00:00 UTC, like Mezo's. | REPRODUCIBLE | `EpochLibTest.test_start_weekAlignsToThursday` |
| 24 | The BTC / MUSD Morpho market uses AdaptiveCurveIrm at the LLTV Mezo's Morpho Blue enables: 86% on mainnet; 77% on Mezo's testnet Morpho Blue in v2. | VERIFIED-LIVE | `marketParams` in the deployment files; `isLltvEnabled(0.77e18)` = `true` on Mezo's testnet Morpho Blue `0xCe1d…5a73` |

## Deployment and live run, v1

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 25 | All 14 contracts of the v1 testnet deployment are verified with an exact match on Sourcify. | VERIFIED-LIVE | [PROOF.md](PROOF.md#mezo-testnet-31611-v1) |
| 26 | The v1 testnet vault is configured as documented: VoteAllocator as sole allocator, 10% performance fee to the SuretyPool, DepositGate as receive-shares gate, 200% a year max rate, 1% forced-exit penalty, 10,000,000 MUSD caps. | VERIFIED-LIVE | [Configuration on chain](PROOF.md#configuration-on-chain) |
| 27 | The whole v1 lifecycle ran live on testnet: deposit, votes, rebalance, incentives, a veBTC loan, a Morpho borrow, a price shock, a Morpho liquidation with bad debt, a veBTC auction settled below the debt, loss checkpoints and covers that slashed the voters' cohorts. | VERIFIED-LIVE | [v1 lifecycle table](PROOF.md#live-lifecycle-on-testnet) |
| 28 | In that run the Morpho line lost 125.4043 MUSD, of which 88.4209 was covered from voters (their whole 100 srMUSD cohort) and 36.9834 stayed with lenders; the veBTC line lost 31.7562 MUSD and was covered in full for 35.6901 srMUSD of its 150 srMUSD cohort. Voters covered 120.18 of the 157.16 MUSD of bad debt (76%). | VERIFIED-LIVE | `Liquidate`, `Bid`, `LossRecorded`, `CohortSlashed` and `Covered` events ([PROOF.md](PROOF.md#the-loss-from-the-events)) |
| 29 | Once VaultV2 has recognised the 118.63 MUSD the covers returned, which takes about three weeks at the vault's size, the v1 testnet share price is about 0.970. | MODELED | Arithmetic in [PROOF.md](PROOF.md#the-loss-from-the-events) |
| 30 | After the losses the keeper kept flipping epochs on testnet: hourly pokes and rebalances, and covers that use the new fees reaching the reserve to pay down the lenders' share of the Morpho loss. | VERIFIED-LIVE | Keeper rows of the [v1 lifecycle table](PROOF.md#live-lifecycle-on-testnet) |
| 31 | Surety v1 is deployed on Mezo mainnet: 11 contracts, all an exact match on Sourcify, wired to Mezo's own Morpho Blue and IRM, with 1-day timelocks and 2,000 MUSD caps. | VERIFIED-LIVE | [PROOF.md](PROOF.md#mezo-mainnet-31612-v1) |

## Tests, review and tooling

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 32 | 379 Foundry tests pass and 4 opt-in fork suites are skipped by default; 173 TypeScript tests pass (sdk 83, keeper 56, mcp 13, web 21). | REPRODUCIBLE | `forge test`, `pnpm test` ([PROOF.md](PROOF.md#tests)) |
| 33 | Fifteen invariants hold over 256 runs of 64 random actions each, and any revert fails the run: 9 system invariants, run with and without idle cash parked in sMUSD, and 6 on the veBTC line. | REPRODUCIBLE | `SuretyInvariants`, `SuretyInvariantsWithSavings`, `LineInvariants` |
| 34 | Every fixed review finding has a regression test that replays the attack against the fixed code, except the v1 deploy-script fix L-03. | REPRODUCIBLE | v1: `AuditPoCTest`, 9 regressions and 1 verified non-issue; v2: `AuditV2*` and the tests named in [SECURITY.md](SECURITY.md#v2-findings) ([v1 findings](SECURITY.md#findings)) |
| 35 | A large donation onto a tiny seed is not an inflation attack on later depositors. | REPRODUCIBLE | `test_NI_tinySeedDonationIsNotAnInflationAttack` |
| 36 | Slither reports 133 results on v1's `contracts/src` (at `09f1a49`), none of them a vulnerability. | REPRODUCIBLE | The command and the triage in [SECURITY.md](SECURITY.md#slither); the triage is our assessment. Slither has not been re-run on v2 |
| 37 | Surety deploys and runs against live Mezo mainnet state (real veBTC, MUSD, sMUSD, Morpho Blue, IRM and Tigris pools). | REPRODUCIBLE | `SURETY_FORK=true forge test --match-contract 'LiveMezo\|LivePeg\|LiveSavings\|AuditV2Fork'`: 18 tests (BTC and Skip precompiles replaced by stand-ins, because a fork cannot execute them) |
| 38 | The keeper holds no role; every call it makes is open to anyone. | REPRODUCIBLE, VERIFIED-LIVE | Keeper tests; the called functions have no access control in the verified sources |
| 39 | The SDK and the MCP server never hold keys; they return unsigned transactions. | REPRODUCIBLE | `packages/sdk` and `packages/mcp` tests |

## v2: the MUSD peg

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 40 | MusdPeg reads MUSD/USD as the median of fixed sources built on Mezo's pools, and is healthy only when enough sources read, they agree within `maxSpreadBps` of the median, and the median is within `bandBps` of $1. | REPRODUCIBLE, VERIFIED-LIVE | `PegTest`; verified [MusdPeg](https://repo.sourcify.dev/31611/0xd54D93aa56B080df424847142A1aaac59bB760AB) and its thresholds on testnet ([PROOF.md](PROOF.md#configuration-on-chain-v2)) |
| 41 | A CL source reads nothing when the window's harmonic-mean in-range liquidity is under its floor, so one second out of range drops it for the window; a basic-pool source reads nothing once its latest observation is older than `maxAge`. | REPRODUCIBLE | `test_clTwap_notOkBelowTheWindowLiquidityFloor`, `test_clTwap_oneSecondOutOfRangeFailsTheWindow`, `test_stableTwap_notOkWhenTheLatestObservationIsTooOld`, `test_btcCross_notOkOnStaleSkipOrWrongBtc` |
| 42 | BTC collateral is priced at BTC/USD divided by the peg's median clamped to [$1, $1.03] while the peg is healthy, and at BTC/USD otherwise: never above BTC/USD, never more than 2.91% below it. | REPRODUCIBLE, VERIFIED-LIVE | `test_btcMusd_dividesByAHealthyPegClampedToThePremium`, `test_btcMusd_anyPegFailureReadsAsOneDollar_onlySkipReverts`, `testFuzz_btcMusd_boundedByThePremium`; `maxPremiumBps()` = 300 on the testnet BtcMusdPriceSource |
| 43 | While the peg is unhealthy, new veBTC borrowing reverts with `PegUnhealthy` and rebalances fund no line; repayment, harvests, auctions and bids never read the peg. On testnet a `borrowMore` sent while MUSD read $0.94 reverted on chain with `PegUnhealthy`. | REPRODUCIBLE, VERIFIED-LIVE | `test_pegBreaker_blocksBorrowing_notRepayAuctionsOrEscrow`, `test_pegGate_holdsAllocations_deallocationsStillRun`, `invariant_noBorrowingWhileUnhealthy`; [0x6438…8e16](https://explorer.test.mezo.org/tx/0x6438e38d8cd1dfb4f522a6c72c25cf987e97e98201d2838d2f7a7942633f8e16) (status: reverted) |
| 44 | The v2 review's attack on the peg (both thin CL pools pushed for 60 s, $77.87 in fees) moves the BTC price by 0 bps on a fork of Mezo mainnet, and one pushed CL pool no longer trips the breaker. | REPRODUCIBLE | `AuditV2ForkTest` with `SURETY_FORK=true` |
| 45 | On Mezo mainnet's pools at block 13,100,532, the four mainnet sources read 0.99144 (CL mUSDC/MUSD), 0.99125 (basic mUSDC/MUSD), 0.98604 (basic MUSD/mUSDT, 13.9 hours since its last observation, so left out) and 1.00246 (BTC cross); the median, 0.99144, is healthy, and BTC is priced at BTC/USD. | REPRODUCIBLE | `SURETY_FORK=true forge test --match-contract LivePeg -vv`. The deployed mainnet MusdPeg's own reading is claim 66 |

## v2: the veBTC line

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 46 | Loan escrows voted veBTC on Mezo's PoolsVoter on testnet, and MUSD bribes were posted on that gauge, in both runs. | VERIFIED-LIVE | v1 loan #2: [0x1b78…9612](https://explorer.test.mezo.org/tx/0x1b78236ede57063dedf03347ee23c1c4ccc3920f081495332b5d997f17c99612), [0xef7a…919b](https://explorer.test.mezo.org/tx/0xef7ab6f4f99ef53b81d568de533ddd140711f8d86685113e787bb0a220a7919b); v2 loan #1: [0x1a50…0430](https://explorer.test.mezo.org/tx/0x1a50ee48bfa2a189fab44bbdccf936f6f630c4fe994766e0ce4d575529720430), [0x203f…ad0f](https://explorer.test.mezo.org/tx/0x203fd6fb5dfb44df73c952b5e99dbb6dc7330876861018df679d445e0594ad0f); PoolsVoter `votes(tokenId, pool)` |
| 47 | With auto-repay on, anyone can harvest a loan's escrowed NFT: its MUSD rewards repay the debt, other tokens go to the borrower, the rebase compounds into the lock, and only what the claim moved counts. | REPRODUCIBLE, VERIFIED-LIVE | `HarvestTest` (9 tests, a malicious token included), `LineInvariants`; auto-repay switched on for v2 loan #1: [0x30a8…fc41](https://explorer.test.mezo.org/tx/0x30a85874117863e547421a90056a812bea381561e7200b8b8a87ddbf3e3efc41). The live harvest is claim 68 |
| 48 | The auction floor sits above debt plus fee at the trigger (85% against at most 66.95%), and the constructor refuses parameters where it would not. | REPRODUCIBLE, VERIFIED-LIVE | `test_constructor_requiresFloorAboveDebtPlusFeeAtTrigger`; `params()` on the v2 testnet line |
| 49 | In the v2 run a loan pushed to 69.95% LTV by a −32.59% shock was auctioned and sold at 92.50% of its collateral value: 46.13 MUSD for a 35.00 debt, no shortfall, and the floor at that moment (42.57) was above debt plus fee (36.05). | VERIFIED-LIVE | `Bid` in [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1); [PROOF.md](PROOF.md#live-lifecycle-on-testnet-v2) |
| 50 | Every veBTC borrow pays a 0.25% origination fee to the treasury and owes the full amount; on testnet, 0.0625 MUSD on a 25 MUSD loan. | REPRODUCIBLE, VERIFIED-LIVE | `test_originationFee_paidToTreasury_debtIsFullAmount`, `testFuzz_originationFee_conserves`; `OriginationFeePaid` in [0x9f8d…99f9](https://explorer.test.mezo.org/tx/0x9f8decd8a5fa3e6944f3186d0d7f59f915627ee569558e4425da8858e2ea99f9) |
| 51 | The liquidation fee splits exactly: 80% to lenders, 10% to the treasury and 10% to whoever started the auction; on testnet 0.84 / 0.105 / 0.105 MUSD of a 1.05 MUSD fee. | REPRODUCIBLE, VERIFIED-LIVE | `testFuzz_bid_splitsFeeExactly`, `invariant_feeConservation`; `LiquidationFeePaid` in [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1) |

## v2: the vault, savings and the share market

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 52 | The vault's idle MUSD, buffer included, is parked in sMUSD through the SavingsAdapter as VaultV2's liquidity adapter: deposits land there and rebalances fund the lines from it. | REPRODUCIBLE, VERIFIED-LIVE | `SavingsAdapterTest`, `VoteAllocatorSavingsTest`, `LifecycleSavingsTest`, `SuretyInvariantsWithSavings`, `LiveSavingsTest` (fork); deposit [0xe25a…51f8](https://explorer.test.mezo.org/tx/0xe25a1e53b909718a19de0b74823a81c6ad68a66b596f950c1f4006f49c8d51f8) and rebalance [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2); `liquidityAdapter()` on the v2 vault |
| 53 | The voters' fee on sMUSD yield goes to the reserve, never to a line's cohort, and covers can draw on what sits in sMUSD. | REPRODUCIBLE | `test_distributeFees_savingsYieldToReserve`, `test_savingsYield_attributedUnderSavingsId`, `test_cover_drawsOnSavingsLiquidity` |
| 54 | If sMUSD stops paying out, the allocator's owner can stop parking: the liquidity adapter is unset and deposits and withdrawals use idle MUSD only. | REPRODUCIBLE | `test_setParking_offBringsSavingsHome_onParksAgain`, `test_rebalance_illiquidSavings_reportedAndFundsFromIdleOnly`, `test_fork_frozenStrategy_failsLoudly` (fork) |
| 55 | A lender can sell srMUSD on the ShareMarket at a discount to the live share price, with 0.10% of each fill to the treasury; listings and fills wait while the deposit gate is closed, and `cancelAndRedeem` stays open. On testnet, 10 srMUSD worth 10.0004 MUSD filled for 9.9004 MUSD, 0.0099 to the treasury. | REPRODUCIBLE, VERIFIED-LIVE | `ShareMarketTest`, `ShareMarketFuzzTest`, `ShareMarketSuretyTest.test_marketFollowsTheDepositGateThroughALoss`; [0x741e…de8a](https://explorer.test.mezo.org/tx/0x741e1b596a09c35b382c5ef245c16a168ea6eb725f86e09b2ceb2088ecbfde8a) |
| 56 | The vault charges a 0.20% a year management fee to the treasury, and the deposit gate answers for the treasury without calling the pool, so the first vault call after a cover costs ordinary gas. | REPRODUCIBLE, VERIFIED-LIVE | `test_M02_firstAccrualAfterACoverStaysCheap`, `test_M02_rebalanceAfterCoverFitsTheBlock`, `invariant_accrualStaysCheap`, `test_canReceiveShares_answersTheTreasuryWithoutThePool`; `managementFee()` and the gate's `treasury()` on testnet |
| 57 | At the mainnet caps protocol fees come to about 20.5 MUSD a year; they cover operations and one review a year from about 4.1M MUSD in the vault. | MODELED | [BUSINESS.md](BUSINESS.md#unit-economics), assumptions stated there |

## v2: onboarding, deployment and app

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 58 | A new testnet wallet can get one starter kit (0.00005 BTC for gas, a 0.001 BTC veBTC lock, 30 test MUSD; 50 before the refill of 2026-11-09) through the relayer, borrow against the lock and repay. | REPRODUCIBLE, VERIFIED-LIVE | `SponsorSuretyTest.test_newWalletBorrowsAndRepaysWithAStarterKit`, `SponsorTest`, `apps/web/api/starter.test.ts`; kit #1 to a team test wallet: [0x823f…1477](https://explorer.test.mezo.org/tx/0x823f99fc7d1e6efb55facc06676708f48fc994ee111de45259847107e5321477) |
| 59 | The users ledger lists every wallet that has sent a successful transaction to a Surety contract or received a starter kit, with team wallets labelled. | REPRODUCIBLE | `/app/ledger` (`pnpm --filter web dev`); the team list in `apps/web/src/lib/ledger.ts` |
| 60 | v2 runs on Mezo's own testnet Morpho Blue, not a self-deployed one. | VERIFIED-LIVE | `marketParams` of line 0 in `contracts/deployments/31611.json`; Morpho Blue `0xCe1d…5a73` and AdaptiveCurveIrm `0x0c97…7441`, verified on Mezo's explorer since May 2026, months before Surety's first deployment |
| 61 | All 18 Surety contracts of the v2 testnet deployment are an exact match on Sourcify. | VERIFIED-LIVE | [PROOF.md](PROOF.md#mezo-testnet-31611-v2) |
| 62 | The v2 testnet deployment is configured as documented: fees and recipients, liquidity adapter, gate and treasury, line parameters, peg thresholds, premium cap. | VERIFIED-LIVE | [Configuration on chain, v2](PROOF.md#configuration-on-chain-v2) |
| 63 | The whole v2 lifecycle ran live on testnet, each role from its own team account: a deposit parked in sMUSD, a vote, incentives, a rebalance, two veBTC loans with origination fees, auto-repay, an escrow vote and bribe, a Morpho borrow on Mezo's Morpho Blue, a `PegUnhealthy` revert, an auction with no shortfall, a ShareMarket fill, a starter kit and the next epoch's attribution. | VERIFIED-LIVE | [v2 lifecycle table](PROOF.md#live-lifecycle-on-testnet-v2): 53 transactions recorded, none pending |
| 64 | The app renders its pages from a build snapshot with every Mezo RPC blocked, reaches network idle within 5 s with the RPCs up, and makes no RPC request from a hidden tab. | REPRODUCIBLE | `pnpm --filter web build && pnpm --filter web check:load`; the numbers of 2026-11-09 in [FEEDBACK-RESPONSE.md](../FEEDBACK-RESPONSE.md#7-the-live-app-loads-quickly). The live site passes the same check: [FEEDBACK-RESPONSE.md](../FEEDBACK-RESPONSE.md#7-the-live-app-loads-quickly) |

## v2 on Mezo mainnet

| # | Claim | Tier | Evidence |
| --- | --- | --- | --- |
| 65 | Surety v2 is deployed on Mezo mainnet: 19 contracts, all an exact match on Sourcify (the LoanEscrow implementation, created by the line's constructor, on runtime bytecode), on Mezo's own Morpho Blue in a BTC/MUSD market at LLTV 86%, with Mezo's sMUSD as the vault's liquidity adapter, 2,000 MUSD caps on the Morpho line and the veBTC line, weekly epochs, and 1-day timelocks on the vault's curator functions, the Morpho adapter and new lines. | VERIFIED-LIVE | [PROOF.md](PROOF.md#mezo-mainnet-31612-v2) and [its configuration on chain](PROOF.md#configuration-on-chain-v2-mainnet); `contracts/deployments/31612.json` (market `0x4bff245d…3030b8`); 124 deployment transactions, all successful, in `contracts/broadcast/Deploy.s.sol/31612/run-latest.json` |
| 66 | Right after the deployment, at block 13,118,945, the mainnet MusdPeg read MUSD at 0.995137812070612232 and healthy, from two of its four sources: basic mUSDC/MUSD (0.991271) and the BTC cross (0.999005). CL mUSDC/MUSD was under its liquidity floor and basic MUSD/mUSDT past its 6-hour bound, so neither counted. BTC was priced at BTC/USD, 75,150.1 MUSD. | VERIFIED-LIVE | `cast call 0x07777966126dBf0f3919E217D0A2247156879a5F "musdUsdWad()(uint256)" --rpc-url https://mezo.drpc.org --block 13118945`, and likewise `pegHealthy()(bool)` and `readings()((address,bool,uint256)[])`; `priceWad()(uint256)` on the BtcMusdPriceSource `0x6C97…1279`; [PROOF.md](PROOF.md#the-mainnet-musd-peg-at-launch) |
| 67 | Real MUSD runs through the v2 mainnet vault on Mezo's Morpho Blue, from the team's own wallet. A 2.5 MUSD deposit parked in sMUSD; after a 50/50 veBTC vote the rebalance supplied 1.1254 MUSD to Surety's BTC/MUSD market on Mezo's Morpho Blue and 1.1254 MUSD to the veBTC line and left 0.25 MUSD in sMUSD. 1 MUSD is borrowed from that market (88.86% utilisation) and 1 MUSD is lent against veBTC #6178 at 45.94% LTV, with a 0.0025 MUSD origination fee to the treasury. A savings harvest deposited 0.00086 MUSD of sMUSD yield back. | VERIFIED-LIVE | [Live on mainnet, v2](PROOF.md#live-on-mainnet-v2): 18 transactions from 2026-11-10 to 2026-11-12, among them deposit [0x7d97…213d](https://explorer.mezo.org/tx/0x7d975656b297ad55730cf9f77ca3cf5a8e7d16711051d162bc78c5ee0eea213d), rebalance [0x4bc7…65d4](https://explorer.mezo.org/tx/0x4bc72f1a50a1e6999e83a3a18616438f177fdafd10bf4870587be4df77bd65d4), veBTC loan [0x26ba…f719](https://explorer.mezo.org/tx/0x26ba1c58ca6735a33d9b65f77f01758ef88bd9833e67373d30ca9422419ef719) and Morpho borrow [0xfeb5…b999](https://explorer.mezo.org/tx/0xfeb519ffd962f04f8d3a710595917f2f2d57d01cf0b1c6dc0f7f2b60827cb999); `market(bytes32)` on Morpho Blue `0x5658…A311`, `realAssets()` and `totalDebt()` on the line and `realAssets()` on the SavingsAdapter, read at block 13,178,340 |
| 68 | The escrow's claim paths ran live on testnet after the Mezo flip of 2026-11-12: the fee/bribe claim forwarded 0.28099 MUSD to the borrower of v1 loan #2, the rebase claim compounded 9.69e-10 BTC into its lock, and the keeper's auto-repay harvest of v2 loan #1 claimed 0.16764 MUSD of fees and bribe and put all of it toward repaying the loan. | VERIFIED-LIVE | `escrowClaim` [0x4c69…057a](https://explorer.test.mezo.org/tx/0x4c69cd096ea6a5123de7357268541bb0bfd7ffaa9ac1565db00cf899cc3d057a), `escrowClaimRebase` [0x5fd3…76d0](https://explorer.test.mezo.org/tx/0x5fd3f2f9e1d7ef3a6ad70b6151bc94b98dcdf9f0fef89c3a0c639172c29e76d0), `harvest` [0x04be…09e6](https://explorer.test.mezo.org/tx/0x04bef77906dbad8690ea3a6a2a9d2dfa1b8ce5ff782236280976dcc4b36509e6) (`Harvested`: claimed 0.167637, repaid 0.167637); both lifecycle tables in [PROOF.md](PROOF.md#live-lifecycle-on-testnet-v2) |
| 69 | On mainnet a loan's escrow votes veBTC on Mezo's PoolsVoter: the escrow of loan #1 votes #6178 100% on the CL mUSDC/MUSD pool, with auto-repay on. | VERIFIED-LIVE | `escrowVote` [0x2706…1574](https://explorer.mezo.org/tx/0x2706f059e6e99d9c2fc19c1b7ebf6972ba067f581e9f9fff486d9e333bfc1574); on PoolsVoter `0x4823…1f03`, `usedWeights(6178)` > 0 and `poolVote(6178, 0)` = `0xCC37…aC1a`; `loan(1)` on the line shows auto-repay `true`. Its first harvest is N22 |

## Not claimed

| # | Not claimed | Why |
| --- | --- | --- |
| N1 | Production readiness, or safety for meaningful amounts of money | Single-key owner roles, no external audit. Mainnet runs with 2,000 MUSD caps. |
| N2 | An external audit | The reviews were internal and independent, not a contracted audit. |
| N3 | A real Mezo gauge or MEZO emissions for srMUSD | Needs a Mezo governance call to `createVaultGauge`; on the roadmap. |
| N5 | That lenders never lose money | When the line's cohorts and the reserve are short, lenders bear the rest, as in the v1 run (36.98 MUSD). |
| N6 | That lenders are restored at once | A cover is recognised under VaultV2's `maxRate`; it can take weeks for a large loss. |
| N7 | Decentralised or timelocked administration on testnet | Every owner role is the deployer key and every timelock is zero on testnet. |
| N8 | That lenders are protected from MUSD losing its peg | Loans and deposits are in MUSD. The peg stops new credit while MUSD is off and bounds the price effect on collateral; it does not protect MUSD's value. v1 still values MUSD at exactly $1. |
| N9 | A fallback BTC price source | Skip BTC/USD is the only one; when it is stale the lines fail closed. |
| N10 | That Surety liquidates Morpho positions | Morpho's own liquidators do; the keeper's backstop is off by default. |
| N12 | Bytecode identical to Mezo's deployments | The sources match; compiler settings differ. |
| N13 | That APYs shown in the app or SDK are realised returns | They are estimates from the current rate curves and utilisation. |
| N14 | MEZO incentives or more collateral lines | Roadmap items, not built. |
| N15 | Outside users | Every wallet that has used Surety so far is the team's, the mainnet MUSD of claim 67 included, and the ledger labels them. Pending — outside wallets: the v2 app and its starter kits are live since 2026-11-09, and none has come yet. |
| N17 | A meaningful yield from sMUSD | sMUSD's yield has been about 0.05% a year lately, and testnet sMUSD paid none during the v2 run. |
| N18 | That the testnet peg reads a market | Testnet has no usable MUSD pool; its peg is one StressedPegSource that reads $1 unless someone overrides it. |
| N20 | Contracts verified on Mezo's Blockscout explorer | Its verifier currently lists no Solidity compiler versions; the contracts are verified on Sourcify ([PROOF.md](PROOF.md#mezo-testnet-31611-v2)). |
| N21 | A Slither run on v2 | The Slither triage covers v1's contracts at `09f1a49`. |
| N22 | A claim or harvest through a mainnet escrow | The mainnet escrow voted in the Mezo epoch that started on 2026-11-12 (claim 69), and Mezo pays an epoch's rewards after it ends. Pending — the auto-repay harvest of mainnet loan #1, from the Mezo flip on 2026-11-19 00:00 UTC. |
| N23 | Mainnet TVL, users or volume beyond the team's own | The MUSD in the v2 mainnet vault is the team's (claim 67): a test of the live contracts in small amounts, not traction. |
