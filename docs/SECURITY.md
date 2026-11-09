# Security

Surety has had an internal review and two independent reviews: one of the first contracts (v1) and one of the changes in v2. It has not had an external audit. v2 runs on Mezo testnet; v1 runs on testnet and on Mezo mainnet as a capped launch. Every owner role is held by one key. Read the [residual risks](#residual-risks) and [privileged roles](#privileged-roles) before relying on it.

| Review | Commit reviewed | Findings | Status |
| --- | --- | --- | --- |
| [v2 changes](#v2-review-the-wave-2-changes) | `d33193c` | 1 high, 2 medium, 2 low, 8 informational | High, medium and low all fixed, each with regression tests; informational: 3 addressed, 5 acknowledged |
| [v1](#v1-review) | `9c9a79e` | 4 medium, 6 low, 7 informational | All medium and 5 of 6 low fixed, each with a regression test except the deploy-script fix L-03; 1 low acknowledged |

Severity: **High** means user funds can be taken under realistic conditions at a cost far below the gain; **Medium** means funds can be lost or misattributed, or a core action denied, under realistic conditions, bounded by caps and pool size; **Low** means limited impact or unusual preconditions; **Informational** means no direct loss.

## v2 review: the Wave 2 changes

### v2 scope

| | |
| --- | --- |
| Reviewed commit | `d33193c619d67e5bf83a5eb1a5144278557f4b74`: the v2 contracts, before the deployment script was rewritten for them |
| Diff | `git diff 2a2b236..d33193c -- contracts/src`: 21 files, plus the code they call into |
| Fixes | `62b189c`, `145329b`, `b47d831`, `59ab3e9`, `23a2dc4`, `d038239`, merged in `10b1114` |
| Deployed | The v2 testnet deployment (`9a6f096`, [`contracts/deployments/31611.json`](../contracts/deployments/31611.json)) includes every fix; the regression tests pass at `23f8596` |
| New code in scope | `oracles/peg/` (PegSourceBase, ClTwapPegSource, StableTwapPegSource, BtcCrossPegSource, StressedPegSource, MusdPeg), `libraries/TickPrice.sol`, `oracles/BtcMusdPriceSource.sol`, `interfaces/ITigrisPools.sol`, `SavingsAdapter.sol`, `ShareMarket.sol`, `testnet/Sponsor.sol` |
| Changed code in scope | `lines/VeBTCCreditLine.sol` (peg breaker, origination fee, liquidation-fee split, auto-repay and `harvest`), `VoteAllocator.sol` (savings, parking, peg gate), `SuretyPool.sol` (savings yield to the reserve, cover liquidity), `oracles/MorphoPriceOracle.sol` |
| Read for interaction | DepositGate, LoanEscrow, CreditVoter, and VaultV2 at `97bcce9` |
| External, verified sources read | Mezo's sMUSD (MUSD Savings Rate) implementation and the Tigris concentrated-liquidity and basic pool implementations, from Mezo's explorer |
| Not in scope | `contracts/script/Deploy.s.sol`, which was being rewritten (read only where a finding depends on the configuration it sets); the SDK, keeper, MCP server and web app |

### v2 method

- **Reading.** Every new and changed line, then its call sites in the unchanged contracts. Each design intent of v2 was checked against the code, and each fact about Mezo (pool layouts, token order and decimals, observation cadence, sMUSD's accounting) against chain state or verified source.
- **Bug classes swept.** Oracle manipulation (a TWAP against the depth behind it, single-block against multi-block, observation cardinality, staleness), revert paths in liquidations, 63/64 gas griefing, accounting (`realAssets = cash + debt`, fee conservation, interest attribution), reentrancy through reward contracts and tokens a caller chooses, VaultV2's gates and liquidity adapter, share-price timing around ShareMarket fills, and owner powers.
- **Proofs of concept** on two setups: a fork of Mezo mainnet at block 13,100,532 that runs real swaps on Mezo's Tigris pools, and the repository's integrated fixture with real Morpho Blue and VaultV2 bytecode.
- **Regression tests.** Each proof of concept became a test that replays it against the fixed code, in [`contracts/test/audit/AuditV2PoC.t.sol`](../contracts/test/audit/AuditV2PoC.t.sol) and [`AuditV2Fork.t.sol`](../contracts/test/audit/AuditV2Fork.t.sol) (fork, opt-in with `SURETY_FORK=true`). Two suites in the first file also re-run `SuretyPoolTest` and `LifecycleTest` with the production fee configuration.

### v2 findings

The review reported no critical finding, 1 high, 2 medium, 2 low and 8 informational. The v1 fixes all still hold.

| ID | Title | Severity | Status | Fix | Regression tests |
| --- | --- | --- | --- | --- | --- |
| V2-H-01 | A cheap push of two thin CL pools priced BTC 32% low and made healthy positions liquidatable | High | Fixed | `62b189c`, `145329b` | `test_H01_liftedPegNoLongerAuctionsAHealthyLoan`, `test_H01_liftedPegNoLongerLiquidatesMorphoPositions`, `test_H01_fork_pushedClPoolsNoLongerMoveTheBtcPrice` (fork) |
| V2-M-01 | One pushed CL pool tripped the borrow breaker for 30 minutes | Medium | Fixed | `145329b`, `b47d831` | `test_M01_fork_onePushedSourceNoLongerTripsTheBreaker`, `test_M01_fork_droppingBothClSourcesTripsOnlyWhileAStablePoolIsStale`, `test_M01_fork_skewingBothStablePoolsForAnHourTripsTheBand` (fork) |
| V2-M-02 | After a cover, the first vault call of each block burned all its gas | Medium | Fixed | `59ab3e9` | `test_M02_firstAccrualAfterACoverStaysCheap`, `test_M02_control_gateWithoutTheTreasuryBurnsTheGas`, `test_M02_redeemAfterACoverNeedsOrdinaryGas`, `test_M02_rebalanceAfterCoverFitsTheBlock`, `invariant_accrualStaysCheap` |
| V2-L-01 | A peg tripped for good had no way out | Low | Fixed | `23a2dc4` | `test_setPegCheck_ownerOnly_offLetsBorrowingThroughAnUnhealthyPeg`, `test_setPeg_ownerOnly_replaceableAndRemovable` |
| V2-L-02 | Stale stable-pool sources could hide a 4% depeg | Low | Fixed | `145329b` | `test_L02_staleStableSourcesNoLongerMaskAFourPercentDepeg`, `test_stableTwap_notOkWhenTheLatestObservationIsTooOld` |
| V2-I-01 to V2-I-08 | [Informational](#v2-informational) | Info | 3 addressed, 5 acknowledged | | |

#### V2-H-01: A cheap push of two thin CL pools priced BTC 32% low

Two of the four mainnet peg sources are 30-minute TWAPs of concentrated-liquidity pools with little MUSD in range: CL mUSDC/MUSD and CL BTC/MUSD. Buying through that MUSD pushes each pool's tick past every position into a range with no liquidity, where it rests at no further cost. A TWAP is a mean of ticks, so a minute at an extreme tick moves a 30-minute mean a long way, and swapping back in the transaction that uses the price leaves both pools looking normal. On the mainnet fork, a 60-second push of both pools lifted both sources to about $1.94 and the median of the four to $1.466, for $77.87 in fees and about $19.4k of capital that comes back. BtcMusdPriceSource divided BTC/USD by the median whether or not the peg was healthy, so BTC read 31.8% low.

**Impact.** A veBTC loan at 45% LTV, 20 points under the trigger, could be auctioned and bought in one transaction at 68% of its collateral value: in the proof of concept the borrower of a 0.1 BTC lock lost 2,704 MUSD. Morpho positions above about 59% LTV could be liquidated; one at 75% LTV left 788 MUSD of bad debt for voters and lenders. The gain grows with TVL. v1 priced BTC at BTC/USD with MUSD at $1 and did not have this.

**Fix.** Two layers. BtcMusdPriceSource now divides only by a healthy peg, clamped to [$1, $1 + `maxPremiumBps`] (300 bps on mainnet, at most 500 by construction), and by exactly $1 on an unhealthy peg, too few sources or any failed answer; only the BTC/USD source can make it revert (`62b189c`). The CL sources now also need the window's harmonic-mean in-range liquidity, computed from the pool's `secondsPerLiquidityCumulativeX128`, to reach a floor: 1e19 for CL mUSDC/MUSD and 2e20 for CL BTC/MUSD. The constructor requires a floor above the window length, so a single second out of range fails the window (`145329b`). On the same fork, the same push now drops both CL sources and moves the BTC price by 0 bps. At the worst median the clamp still lets through, $1.03, the proof-of-concept loan reads 46.35% LTV and cannot be auctioned, and the Morpho position stays healthy.

**Regression tests.** `test_H01_liftedPegNoLongerAuctionsAHealthyLoan` and `test_H01_liftedPegNoLongerLiquidatesMorphoPositions` replay both attacks on the fixture; `test_H01_fork_pushedClPoolsNoLongerMoveTheBtcPrice` replays the push on real pools; `test_btcMusd_dividesByAHealthyPegClampedToThePremium`, `test_btcMusd_anyPegFailureReadsAsOneDollar_onlySkipReverts`, `testFuzz_btcMusd_boundedByThePremium`, `test_clTwap_notOkBelowTheWindowLiquidityFloor` and `test_clTwap_oneSecondOutOfRangeFailsTheWindow` pin the pieces.

#### V2-M-01: One pushed CL pool tripped the borrow breaker

The same push, aimed at CL mUSDC/MUSD alone for one minute (about $7 in fees), lifted that source to 1.053. Against the basic pools' 0.986 the spread exceeded the 500 bps limit then set, and the breaker stayed tripped for the 30-minute window.

**Impact.** No new veBTC loans and no new allocations for 30 minutes per push, repeatable for about $355 a day. No funds lost.

**Fix.** With the liquidity floor of V2-H-01, a pushed source drops out instead of reading as an outlier (`145329b`). The mainnet thresholds were then set from 672 half-hour samples of the live pools between 2026-10-26 and 2026-11-09: 2 of 4 sources, a 1000 bps spread and a 300 bps band (`b47d831`; the reasoning is in [`MusdPeg.sol`](../contracts/src/oracles/peg/MusdPeg.sol)). The keeper syncs the basic pools hourly (`c313935`). With those syncs the breaker was open in every sample, and dropping both CL sources no longer trips it. What still trips it is moving the market itself: keeping MUSD about 6% off in both basic pools for an hour, open to arbitrage throughout.

**Regression tests.** `test_M01_fork_onePushedSourceNoLongerTripsTheBreaker`, `test_M01_fork_droppingBothClSourcesTripsOnlyWhileAStablePoolIsStale`, `test_M01_fork_skewingBothStablePoolsForAnHourTripsTheBand`, all on real pools.

#### V2-M-02: After a cover, the first vault call of each block burned all its gas

v2 sends VaultV2's management fee to the treasury. VaultV2 asks the receive-shares gate about each fee recipient on the first accrual of a block. The gate asked the pool's `depositsPaused`, which, while a cover's MUSD is being re-recognised, reads `vault.totalAssets()`; that accrues again and asks the gate again. The recursion ran until the gas ran out, and the gate's try/catch then unwound it.

**Impact.** After any cover, the first transaction of each block that touched the vault used its whole gas limit: a redeem under 1 to 3M gas failed, and the keeper's rebalance failed at Mezo's 10M block limit, which kept the condition from clearing. No funds were lost. A cheap vault accrual earlier in the same block avoided the loop, but nothing in the system made that call.

**Fix.** `DepositGate(pool, treasury)` answers for the treasury without calling the pool, as it does for the pool itself (`59ab3e9`). Letting the treasury receive shares while deposits are paused is safe because it only receives fee shares minted for elapsed time, never for MUSD paid in: at 0.20% a year they dilute a cover recognised over a week by 0.0038%. That holds only while the treasury stays a pure fee sink (see residual risks). The test fixtures now run with the production fee configuration. After the fix, the first accrual after a cover costs 99,101 gas (29.05M before, at a 30M cap), a redeem 146k, and the keeper's rebalance 991,066.

**Regression tests.** `test_M02_firstAccrualAfterACoverStaysCheap`, `test_M02_control_gateWithoutTheTreasuryBurnsTheGas`, `test_M02_redeemAfterACoverNeedsOrdinaryGas`, `test_M02_rebalanceAfterCoverFitsTheBlock`, `test_canReceiveShares_answersTheTreasuryWithoutThePool` and the invariant `invariant_accrualStaysCheap`.

#### V2-L-01: A peg tripped for good had no way out

The line's peg was immutable and the allocator's could be set once. If Mezo's pools thinned out below `minSources` for good, borrowing and allocation would have stopped for good too, and recovery would have needed a new line or allocator through VaultV2's timelocks.

**Fix.** `VeBTCCreditLine.setPegCheck(bool)`: on by default; off skips only the health check in `open` and `borrowMore`, and pricing still reads the peg. `VoteAllocator.setPeg` can replace the peg, and zero removes the gate (`23a2dc4`). Both are owner powers, listed under [privileged roles](#privileged-roles).

**Regression tests.** `test_setPegCheck_ownerOnly_offLetsBorrowingThroughAnUnhealthyPeg`, `test_setPeg_ownerOnly_replaceableAndRemovable`.

#### V2-L-02: Stale stable-pool sources could hide a depeg

A basic pool's `quote` averages closed observation periods, and the pool writes an observation only on the first swap or sync at least 30 minutes after the previous one. On mainnet the gap between observations runs to hours, sometimes days. Two stale stable readings could hold the median inside the band through a real 4% depeg: with both fresh sources at $0.96, the median read 0.973 and the peg healthy.

**Fix.** `StableTwapPegSource` takes a `maxAge` (between 1 hour and 7 days; 6 hours on mainnet) and reads not ok when the pool's latest observation is older (`145329b`). The keeper's hourly `sync` keeps both mainnet pools inside it (`c313935`). The same readings now give a median of 0.96, and the breaker trips.

**Regression tests.** `test_L02_staleStableSourcesNoLongerMaskAFourPercentDepeg`, `test_stableTwap_notOkWhenTheLatestObservationIsTooOld`, and `test_fork_sourcesReadTheLivePools` in `LivePeg`, where a stale pool reads not ok until it is synced.

#### v2 informational

- **V2-I-01, addressed.** Anyone can set the testnet `StressedPegSource` to any MUSD/USD in [$0.50, $2] for 2 hours. That is the point on testnet; the deploy script refuses it, `StressedPriceSource` and the Sponsor on Mezo mainnet (`fd1f8c7`).
- **V2-I-02, acknowledged.** CL BTC/MUSD keeps 150 observation slots, so about 150 dust swaps in separate blocks can overwrite them and drop the cross source for up to 30 minutes. Three sources remain; `increaseObservationCardinalityNext` on the pool is permissionless if it becomes a problem.
- **V2-I-03, addressed.** The savings adapter needs a forced-exit penalty (else anyone can move parked cash to idle for free) and an absolute cap above any reachable TVL (it takes every deposit). The deploy script sets 1% and 1e27, with a relative cap of exactly 100%.
- **V2-I-04, acknowledged.** The new owner functions `setPeg`, `setParking` and `setSavings` are not timelocked. They cannot move funds; like every Surety owner role they are to move behind a timelock and a multisig.
- **V2-I-05, acknowledged.** ShareMarket's `bestListing` and `listingsOf` scan every listing, so spam can push them past an RPC's gas cap. They are off-chain views that nothing on chain calls, and `openListings(start, count)` pages the same data. Documented in the contract.
- **V2-I-06, acknowledged.** A ShareMarket buyer can fill at the pre-loss share price while an auction is visibly heading below its debt; the gate closes only once the loss is realised. That is the same price a seller's `redeem` gets. Documented in the contract.
- **V2-I-07, addressed.** The Sponsor's only hard limit on relayer sybils is its daily limit, and a kit sent to the Sponsor itself would strand its veBTC NFT. `starterKit` now refuses the Sponsor's own address and the constructor refuses Mezo mainnet (`d038239`). A kit sent to a contract that cannot use the NFT still strands it; this is testnet only.
- **V2-I-08, acknowledged.** The keeper share of the liquidation fee gives bots a reason to start an auction in the first block after a timed lock ends, and a borrower who does not extend in time can lose up to 15% plus the 3% fee. The behaviour is not new, the incentive is. The app shows each loan's lock end and asks the borrower to repay or extend before it.

### v2 verified non-issues

- **Tick math.** `TickPrice` stays within range for every tick a pool can report, routes intermediate products through `mulDiv`, and floors the mean tick toward −∞. Fork readings match 100-digit cross-checks exactly (`test_fork_readingsMatchTheCrossChecks`).
- **Token order and decimals.** Each mainnet pool's order (mUSDC token0 with 6 decimals in CL mUSDC/MUSD, BTC token0 in CL BTC/MUSD, MUSD token1 and token0 in the two basic pools) is handled, and the cross source checks BTC's decimals on every read.
- **Single-block manipulation does nothing.** A Tigris CL swap writes its observation with the pre-swap tick, so a push must be held for at least a block. Moving a basic pool's TWAP takes a full 30-minute period of skewed reserves.
- **MusdPeg** never reverts in `pegHealthy` or `readings`, drops any source that reverts or answers malformed data, and rejects duplicate or zero sources and out-of-range thresholds.
- **The peg cannot brick liquidations.** Every peg failure reads as $1, which prices BTC at BTC/USD, the higher of the possible prices. Only a stale Skip feed fails closed, as in v1. BTC is never priced above BTC/USD, so the peg cannot help anyone borrow more.
- **63/64 gas griefing.** Every call into a source, the peg or the rebase claim in `harvest` is followed by far more required work than 1/64 of a starved call could pay for, and every low-level call target is fixed at deployment.
- **Line accounting.** `realAssets = cash + debt` holds on every path, including the origination fee (paid out of the borrower's proceeds, never through `cash`), harvests and the liquidation-fee split, whose three parts sum to the fee exactly. Only the lenders' part counts as interest. Fuzzed in `testFuzz_accountingHolds` and `LineInvariants`.
- **Harvest.** Every line entry point is non-reentrant, so a malicious reward contract or token that calls back reverts. Only balance increases the claim causes are applied, MUSD and veBTC are never forwarded as listed tokens, and an escrow can claim only for its own NFT.
- **SavingsAdapter against live sMUSD.** Its yield arithmetic matches sMUSD's, `withdraw` pays yield before principal, principal moves 1:1 with no fees or rounding, `realAssets` never reverts, and sMUSD's trusted forwarder only accepts ECDSA-signed requests, which the adapter cannot be made to sign (`LiveSavings` fork suite).
- **Savings attribution.** Savings yield is read from a counter that only grows, so `forceDeallocate` cannot move it (v1 M-01's class), and its fee share goes to the reserve, never to a line's cohort.
- **Covers with a liquidity adapter.** Cover capacity counts idle MUSD plus the savings position, which VaultV2 deallocates on the withdrawal; the sizing and the v1 L-04 credit-back are unchanged.
- **DepositGate.** A depositor's gate check runs after the deposit's own accrual, so the gate still answers correctly; savings and ShareMarket do not bypass it.
- **ShareMarket** prices fills at VaultV2's `previewRedeem`, which rises no faster than `maxRate` and drops only on a realised loss, when the gate makes fills wait. It has no admin, and only a listing's seller can take its shares back.
- **v1 findings not reopened.** Interest on every line and on savings is still counter- or share-price-based; the Morpho mark, the deposit gate, line validation and the auction-vote rule are unchanged.

## v1 review

### Scope

| | |
| --- | --- |
| Reviewed commit | `9c9a79eb08e3e5efa62d8d9d10bcb9d3b0f8be3b` (the first testnet deployment) |
| Fixes | `4633c87`, `acea196`, `584a18f`, `3aea1c8`, `b065020`, `ff6b7d4`, `23f1dfb`, `020e684`, merged in `d8f2b45` |
| Deployed and re-checked | `09f1a4914fef0c648b0e6340f13fd545f5f3dc28` (the v1 testnet deployment); the regression tests and Slither run at this commit |
| In scope | `contracts/src/`: CreditVoter, VoteAllocator, SuretyPool, DepositGate (added by the fixes), lines/VeBTCCreditLine, lines/LoanEscrow, lines/LinearKinkIrm, oracles/SkipPriceSource, oracles/MorphoPriceOracle, oracles/StressedPriceSource, interfaces, libraries; and `contracts/script/Deploy.s.sol` |
| Integration only | VaultV2 and MorphoMarketV1AdapterV2 (`lib/vault-v2` at `97bcce9`), Morpho Blue and AdaptiveCurveIrm, all vendored unmodified. Read to model the integration, not audited. |
| External, read only | Mezo's veBTC, PoolsVoter, RewardsDistributor and MezoForwarder, checked against their verified sources and with live calls on mainnet |
| Not in scope | The SDK, keeper, MCP server and web app. None of them holds a role; they send ordinary, permissionless transactions. |

### Method

- **Internal review during the build.** Invariants were written down before the code and kept as tests: a fuzzed invariant suite over random lender, voter, sponsor, borrower, liquidator, price-shock and keeper actions, plus adversarial unit tests for the escrow's call surface, reentrancy through token receivers, stale and malformed prices, over-slashing and auction edge cases. `forge lint` reports nothing at its default severity; its suppressions are scoped to single lines or blocks.
- **Independent review of `9c9a79e`.** The reviewer first stated the properties the system must keep (only the allocator moves vault capital, and only to listed adapters; fees follow each line's interest; voters bear at most the recorded loss and the recorded loss is the real one; a cover makes lenders whole; nobody but the borrower or the settlement logic moves an escrowed NFT; vote power is a snapshot at the epoch start; every MUSD in or out is accounted for). They then read every in-scope line and swept the usual bug classes with an eye on edge cases: first and last epoch, zero shares, dust, the epoch boundary, stale oracles, lock expiry and permanent locks. All four medium findings and three of the low ones came with a Foundry proof of concept on the repository's integrated fixture, which runs the real Morpho Blue, AdaptiveCurveIrm, VaultV2 and MorphoMarketV1AdapterV2 bytecode with mocked veBTC, PoolsVoter and Skip feed, each as a control branch and an attack branch from the same snapshot.
- **Regression tests.** Each proof of concept became a test in [`contracts/test/audit/AuditPoC.t.sol`](../contracts/test/audit/AuditPoC.t.sol) that replays the attack against the fixed code and asserts the fixed behaviour; L-06 got a test with its fix.
- **Slither** 0.11.6 on `contracts/src` at `09f1a49`, with dependencies, tests and scripts filtered out: 102 detectors, 133 results, triaged [below](#slither). None is a vulnerability.

### Findings

The independent review reported no critical or high findings, 4 medium, 6 low and 7 informational.

| ID | Title | Severity | Status | Regression test |
| --- | --- | --- | --- | --- |
| M-01 | A forced exit could erase a line's measured interest and redirect its voters' fees | Medium | Fixed | `test_M01_forceDeallocateCannotMoveVoterFees` |
| M-02 | A forced exit after Morpho bad debt could shrink the recorded loss | Medium | Fixed | `test_M02_forcedExitStillRecordsTheWholeMorphoLoss` |
| M-03 | A deposit made after a loss could capture most of the voter-funded cover | Medium | Fixed | `test_M03_jitDepositIsRefusedUntilTheCoverIsRecognised` |
| M-04 | Lines could be listed instantly and without validation | Medium | Fixed (owner keys acknowledged) | `test_M04_fakeLineCannotDrainReserveOrBlockRebalance`, `test_M04_veBTCLineListedOncePerAdapter` |
| L-01 | A stale Morpho mark after a period without exposure recorded a loss the vault never took | Low | Fixed | `test_L01_noPhantomMorphoLossAfterZeroExposure` |
| L-02 | A stale oracle at an epoch's first rebalance discarded the closed tally and pulled all capital | Low | Fixed | `test_L02_staleOracleAtFirstRebalanceKeepsClosedTally` |
| L-03 | The Morpho adapter's own timelocks were never raised | Low | Fixed | none (deployment script) |
| L-04 | Slashed cohorts paid about U/(1 − f) for a loss of U | Low | Fixed | `test_L04_slashedCohortNetsExactlyTheRecordedLoss` |
| L-05 | Draining the veBTC line's cash raises every borrower's rate until the next rebalance | Low | Acknowledged | none |
| L-06 | A borrower could vote the escrowed NFT during its auction | Low | Fixed | `test_L06_borrowerCannotVoteTheNFTDuringTheAuction` |
| I-01 | The Morpho market is not seeded, and its oracle blocks liquidations when stale | Info | Acknowledged | |
| I-02 | Ballots and claims follow the NFT | Info | Acknowledged | |
| I-03 | Current-epoch voters can step out of a cover | Info | Acknowledged | |
| I-04 | The bootstrap epoch follows the live tally | Info | Acknowledged | |
| I-05 | Mainnet deploy parameters are not range-checked; one key holds every role | Info | Acknowledged | |
| I-06 | A rebase claimed by a third party after a loan closes is stranded | Info | Acknowledged | |
| I-07 | The allocator assumed it was the only party moving capital | Info | Fixed (with M-01, M-02) | |

One more test in the same file, `test_NI_tinySeedDonationIsNotAnInflationAttack`, checks a [verified non-issue](#verified-non-issues).

#### M-01: A forced exit could erase a line's measured interest

The allocator measured a line's interest as the change in its assets since the previous rebalance, and booked a drop as zero interest. VaultV2's `forceDeallocate` is permissionless, so anyone could pull slightly more than a line had earned out of it just before an epoch's first rebalance. That line's interest for the whole window then read as zero, and every voter fee share went to the other lines, including one the caller had voted for, at a cost of only the 1% exit penalty on a small amount. Interest no longer comes from asset changes: a Morpho line earns the shares it held at the last snapshot times the rise in Morpho's supply share price, and the veBTC line reports a cumulative interest counter that capital moves do not touch (`4633c87`). The regression runs the attack and checks that both lines' cohorts receive the same fee shares with and without it.

#### M-02: A forced exit after Morpho bad debt could shrink the recorded loss

A Morpho loss was valued on the adapter's supply shares at the time of the checkpoint. If those shares fell between the bad debt and the checkpoint, through a `forceDeallocate` that can even be bundled with the liquidation itself, the loss on the shares that left was never recorded. Those shares left at the impaired price, so the loss was real: lenders bore it and the voters who should have paid kept their cohort. The pool now stores the adapter's shares with the mark, values a drop on the larger of the shares at the mark and now, and the allocator checkpoints again after its own moves to keep the stored count current (`acea196`). If a forced exit came before the bad debt within the same window this over-records, which is the direction that protects lenders.

#### M-03: A deposit made after a loss could capture the cover

VaultV2 realises a loss immediately but recognises the MUSD that a cover returns only at its maximum rate, as a gain. A depositor arriving after the loss bought shares at the depressed price, held them while the cover was recognised, and took a pro-rata share of it; with a deposit much larger than the vault, that was most of the cover, and the lenders who took the loss were not made whole. The vault now has a receive-shares gate, `DepositGate`, which refuses new share receivers from the moment a loss exists (before anyone checkpoints it), while it is uncovered, and until VaultV2 has recognised the cover (`ff6b7d4`, wired by `020e684`). Withdrawals are never gated. The regression checks that deposits are refused at each of those stages, reopen once the cover is recognised, and that the pre-loss lender ends up whole.

#### M-04: Lines could be listed instantly and without validation

The CreditVoter owner could list any contract as a credit line at once. The pool trusted a veBTC-kind line's reported bad debt and paid the shared reserve into it on `cover`, the allocator trusted its reported interest when splitting voter fees, and a line whose `ids()` reverted blocked every rebalance; one adapter could also be listed twice under different data. Now a line's adapter must already be a vault adapter (which VaultV2's own `addAdapter` timelock governs), a Morpho line must use the vault's Morpho adapter with canonical market parameters, and a veBTC line must report the Surety vault and is unique per adapter. After the bootstrap, which the deployment ends, listing takes `proposeLine` and then `executeLine` after `LINE_TIMELOCK`; the pool never records more loss for a line than the vault allocated to it; and the allocator guards every call into a veBTC-kind line, so a broken line only makes itself ineligible (`584a18f`, `3aea1c8`). The owner keys themselves are still a single account on testnet, and a line that clears both timelocks could still over-report interest; both are listed under residual risks.

#### L-01: A stale Morpho mark recorded a loss the vault never took

The Morpho high-water mark only moved when a loss above dust was recorded. While the adapter held no shares, bad debt borne by other suppliers lowered the market's share price but left the mark where it was. When the vault later bought in at the lower price, its next checkpoint valued the new shares against the old mark, recorded a loss the vault never took, and slashed voters for it. The mark now moves to the current price and shares at every checkpoint (`acea196`, the same change as M-02), and the regression replays the scenario and checks that nothing is recorded or slashed.

#### L-02: A stale oracle at the flip discarded the closed tally

The allocator chose an epoch's tally among lines with a live price. If the Skip feed was more than 60 seconds old at the first rebalance of an epoch, which anyone can call, no line qualified: the closed epoch's tally was thrown away for the whole epoch and every line targeted zero, pulling capital to idle and raising borrowers' rates. The tally is now chosen from active lines regardless of the oracle, and a line that cannot take new money holds what it has, up to its target (`3aea1c8`). The regression makes the feed stale at the flip and checks that the closed tally drives the epoch and the line keeps its capital.

#### L-03: The Morpho adapter's timelocks were never raised

`MorphoMarketV1AdapterV2` starts with all of its own timelocks at zero, and its documentation asks for them to be set before a vault adds it. The deploy script did not, so the curator could call `burnShares`, which writes off the Morpho position with no Surety loss recorded, or `setSkimRecipient` and `abdicate`, without waiting out any of the vault's timelocks. The script now raises the adapter's timelocks on those three functions and on `increaseTimelock` itself to `VAULT_TIMELOCK` before the vault adds the adapter: 1 day on mainnet, zero on testnet (`020e684`). There is no Foundry test for the script; after a mainnet deployment, `timelock(bytes4)` on the adapter shows the values.

#### L-04: Slashed cohorts paid more than the recorded loss

The cover sizing made the pool as a whole bear exactly the loss U. But the fee shares VaultV2 mints on the MUSD a cover returns came back to the pool as unattributed shares, and the next distribution handed them to whichever lines earned interest next, or to the reserve. The cohorts that were slashed therefore paid about U/(1 − f), roughly 11% more than the loss with a 10% fee. Each cover now records what it took from each cohort and from the reserve, and the following `distributeFees` calls credit the fee shares back to those cohorts pro rata as VaultV2 recognises the MUSD (`b065020`). The regression checks that the slashed cohort nets the recorded loss within 0.01% and that the reserve, which paid nothing, receives nothing.

#### L-05: Draining the veBTC line's cash raises its rate

Anyone can pull the veBTC line's idle cash out with `forceDeallocate`, paying the 1% penalty to lenders. The line's utilisation, measured on its own cash, then reads 100%: every borrower accrues at the curve's 60% maximum APR and new loans revert until the allocator refills the line. This is acknowledged rather than changed. The cost to borrowers lasts only until the next rebalance and part of it goes to lenders, the keeper rebalances at every epoch flip and may rebalance mid-epoch when the line's cash falls well below its target, and the behaviour is documented in the line, the rate model and the keeper. Measuring utilisation against allocated capital rather than cash is a possible later change.

#### L-06: A borrower could vote the NFT during its auction

The escrow's PoolsVoter actions were open to the borrower while the loan was in auction. Mezo's PoolsVoter allows one vote or reset per NFT per Mezo epoch, so a vote cast just before a bid handed the buyer an NFT it could not reset, withdraw, merge or split for up to a week, and bidders would discount for that, which raises the expected shortfall. `escrowVote` and `escrowReset` now require an active loan (`23f1dfb`). Claims stay open during an auction because they only pay out rewards the NFT earned while the borrower held it and leave the lock and its votes unchanged.

#### Informational

- **I-01.** The deploy script creates the BTC / MUSD market without seeding it. The adapter's own share-price check prevents theft; what remains is a denial-of-service risk from share-price deflation after bad debt in a nearly empty market, so the mainnet market should be seeded from a dead address before caps rise. The market's oracle reverts when Skip is stale, which also blocks Morpho liquidations during an outage; that fail-closed trade-off is accepted.
- **I-02.** A ballot cast before an NFT enters a loan escrow still counts for that epoch, matured claims go to whoever owns the NFT at claim time (including an auction buyer), and merging or withdrawing an NFT forfeits its unclaimed cohorts to the reserve. All by design.
- **I-03.** Voters in the current epoch can move their votes off a line just before a cover and back afterwards. The current cohort, which holds this epoch's incentives, then escapes the slash and older cohorts pay more.
- **I-04.** Until an epoch closes with votes, the allocation follows the live tally and can be moved within the epoch, and the bootstrap cohort is credited for two windows. By design, and only at launch.
- **I-05.** On mainnet the deploy script does not range-check `VAULT_TIMELOCK`, `EPOCH_LENGTH` or the cap overrides, apart from the CreditVoter refusing a zero line timelock, and one account ends up holding every role.
- **I-06.** If a third party claims the rebase of an expired lock into an escrow after its loan has closed, the BTC paid to that escrow cannot be forwarded any more. The amounts are rebase dust.
- **I-07.** The allocator's documentation assumed it was the only party moving vault capital, ignoring the permissionless `forceDeallocate` and the sentinel. That assumption was the root of M-01 and M-02; the code and its documentation no longer rely on it.

### Verified non-issues

- **NFT custody.** Each loan gets its own `LoanEscrow` clone, initialised in the transaction that creates it; the implementation is locked at construction. The escrow's targets are fixed, it has no generic call or execute, no meta-transaction support (no ERC-2771), no `onERC721Received` and no payable function. The NFT arrives by plain `transferFrom` and leaves only through `release`, called by the line on full repayment or a winning bid. Every veBTC function that could move or shrink a lock (`withdraw`, `merge`, `split`, `lockPermanent`, `unlockPermanent`, `delegate`, `depositManaged`) is limited to the owner or an approved address, and the escrow never calls any of them. Grant locks are refused at `open`, and a normal NFT cannot gain a grant manager later. Transfers of a voted NFT are allowed and delegation bookkeeping does not revert, so a borrower cannot make `release` fail to block a liquidation.
- **Mezo's October 5 veBTC incident.** That exploit went through veBTC's trusted-forwarder meta-transaction path: the appended sender was not carried into external library calls, so a crafted `safeTransferFrom` payload could act as someone else ([Mezo's incident report](https://mezo.org/blog/incident-report-october-5-2026)). Mezo has since disabled meta-transactions on veBTC (`forwarder()` returns zero). Surety's escrow path does not touch that surface: it never calls `safeTransferFrom`, never passes data payloads and never goes through a forwarder. PoolsVoter still trusts MezoForwarder, but that forwarder only executes a request with a valid ECDSA signature from its `from` address, which a contract escrow cannot produce, and PoolsVoter has no multicall; so nobody can impersonate an escrow to vote, reset or deposit its NFT into a managed lock.
- **Reentrancy.** Every state-changing function of the line, the pool and the allocator is `nonReentrant` with a transient-storage guard. Mainnet MUSD is a plain OpenZeppelin ERC-20 without hooks, so no MUSD transfer, including the surplus paid to a borrower in `bid`, can re-enter or be blocked by the receiver. Reward tokens a borrower chooses in `escrowClaim` can only re-enter guarded functions, and the escrow forwards balance increases measured on live balances.
- **Vote double counting.** Power is read from veBTC's point history at the epoch start, with the boost already in the checkpointed points. Ballots in an epoch's first second are refused. Merges, splits, deposits and lock changes after the start only write later points, a transfer keeps the tokenId's ballot, and past epochs are never written.
- **Donation and inflation on a tiny seed.** VaultV2 recognises a donation no faster than `maxRate` times its total assets, so the share price cannot jump. With 100,000 MUSD donated onto a 0.5 MUSD seed, a later 1,000 MUSD deposit is still worth 1,000 MUSD to within one part per million (`test_NI_tinySeedDonationIsNotAnInflationAttack`).
- **Blocking the allocator.** Moves and checkpoints are wrapped in try/catch, nobody can burn the pool's shares (a `forceDeallocate` on the pool's behalf needs its allowance), and the work left after each inner call is too large for gas griefing under the 63/64 rule.
- **Steering the cover size.** Donating MUSD to inflate the pending amount lowers the cover by about the donation's own restoring value, so it substitutes rather than profits. The shares a cover burns never exceed the shares it may slash, given VaultV2's rounding directions.
- **Dutch auction.** The price falls monotonically to the 70% floor and is computed from the live collateral value. The line keeps at most the debt plus the 3% fee, the borrower gets the surplus, and a shortfall is recorded exactly; the line's assets drop by exactly the shortfall.

### Slither

Slither 0.11.6 on `contracts/src` at `09f1a49` (`slither . --filter-paths "lib/|test/|script/" --exclude-dependencies`, run from `contracts/`).

| Detector | Results | Assessment |
| --- | --- | --- |
| `calls-loop` | 49 | Loops are bounded by the curated line list, `SEASON + 2` cohorts or 8 covers, and call fixed contracts or listed lines whose calls are guarded |
| `timestamp` | 38 | Epochs, lock ends, auctions and oracle freshness are timestamp-based by design |
| `incorrect-equality` | 20 | Comparisons of internal values (zero amounts, the epoch start, the last accrual time), not of balances anyone can move |
| `reentrancy-benign`, `reentrancy-no-eth`, `reentrancy-balance` | 6, 3, 1 | Calls to VaultV2, Morpho Blue and the CreditVoter inside `nonReentrant` functions; `cover` checks the shares VaultV2 burned against its own preview |
| `naming-convention` | 6 | Upper-case immutables, on purpose |
| `unused-return` | 5 | Ignored on purpose: unused round fields, Morpho's borrow totals, a checkpoint inside try/catch, the distributor's reported amount |
| `events-maths` | 2 | VaultV2 emits `Allocate` and `Deallocate` with the amounts |
| `low-level-calls` | 2 | Guarded `staticcall`s that treat a revert or malformed answer as no answer |
| `uninitialized-local` | 1 | `cuts` is an empty array when a cover takes nothing from cohorts |


## Residual risks

From the v2 changes:

- **The MUSD clamp.** While the peg is healthy, the clamp still lets BTC read up to 2.91% under BTC/USD (a 3% premium, `1 − 1/1.03`). That can push only veBTC loans already at 63.1% LTV or more over the 65% trigger, and an instant bid at that price still pays 97.1% of fair value, well inside the 18-point cushion between debt plus fee at the trigger and the 85% floor. On Morpho it can bring forward only positions at 83.5% LTV or more (LLTV 86%). An unhealthy or unavailable peg reads exactly $1, so BTC is then priced at BTC/USD.
- **sMUSD can freeze withdrawals.** sMUSD is an upgradeable proxy whose owner, a Mezo Safe ([`0x98D8…7C7a`](https://explorer.mezo.org/address/0x98D8899c3030741925BE630C710A98B57F397C7a) on mainnet), can upgrade it or switch its strategy. As the vault's liquidity adapter it can then make deposits, and withdrawals above the vault's idle MUSD, revert. The VoteAllocator's owner can call `setParking(false)`: the liquidity adapter is unset, deposits and withdrawals use idle MUSD only, and the next rebalance brings back what sMUSD pays out. Lenders' exit liquidity above the idle MUSD depends on sMUSD until then.
- **Owner powers.** v2 adds immediate owner powers on top of v1's: replacing or removing the allocator's peg, turning parking off or on, and switching the line's peg check off. None of them can move funds, but all should move behind a timelock and a multisig before caps rise, with the v1 roles below.
- **The treasury must remain a pure fee sink.** The deposit gate lets the treasury receive vault shares while deposits are paused, because it cannot tell a fee mint from a deposit or a transfer. So the treasury must never deposit, buy srMUSD or take share transfers while a loss is being covered. Today it is the deployer key; the same rule binds the multisig that replaces it.
- **Thin stable pools.** Mezo's MUSD pools are small and held by a few positions. Anyone with enough MUSD can move the basic pools; keeping MUSD about 6% off in both for an hour trips the breaker (no new veBTC loans, no new allocations) for as long as they keep it there, at the cost of leaving that MUSD open to arbitrage. The clamp keeps any such move from pricing collateral more than 2.91% low. Without the keeper's hourly syncs the basic pools go stale and the peg leans on the CL sources. Sources, floors and thresholds should be re-tuned as Mezo's pools deepen.

From v1, still current:

- **Key centralisation.** One account is the vault's owner, curator and sentinel and the owner of every Surety contract (and, on the v1 testnet deployment, of Morpho Blue). On testnet every timelock is zero. On mainnet the vault's curator functions and line listings wait 1 day, but the Surety owners' immediate powers remain: deactivating a line, setting the vault's max rate (a lower rate slows the recognition of covers), pausing new veBTC loans, and the v2 powers above. Every owner role should move to a multisig behind a timelock before caps rise.
- **A listed line is trusted.** A malicious line that clears VaultV2's `addAdapter` timelock and the CreditVoter's line timelock could report interest it did not earn and draw voter fees. What it can make the pool cover is bounded by what the vault allocated to it.
- **Upgradeable Mezo dependencies.** veBTC, PoolsVoter and sMUSD are proxies. An upgrade that re-enabled forwarder trust or changed `ownerOf`, `votingPowerOfNFTAt` or the lock layout would reopen custody and voting questions; their implementation slots should be monitored.
- **Liveness.** Checkpoints, covers, epoch flips, auctions, harvests and the peg pools' syncs need someone to call them. The keeper does, and every call is open to anyone. A stale Skip feed fails closed, which also stops liquidations until it recovers.
- **Inherited VaultV2 behaviour.** A loss is accounted once per transaction, and every gain is limited by `maxRate`. The second is why the deposit gate exists and why it can stay closed for days after a large loss.
- **Test fidelity.** veBTC, PoolsVoter, the Skip feed, sMUSD and Mezo's pools are mocks in the unit, integration, invariant and regression tests. Their real behaviour was checked by reading their verified sources and by the opt-in fork suites (`SURETY_FORK=true`), which run against live Mezo mainnet state: 18 tests in `LiveMezo`, `LivePeg`, `LiveSavings` and `AuditV2Fork`, all passing on 2026-11-09. A local fork cannot execute Mezo's BTC and Skip precompiles, so those are replaced by stand-ins there.
- **Scale.** Caps start at 2,000 MUSD per line on mainnet. The impact of most findings above grows with TVL and cohort size, so any change to the economics should be reviewed again before caps rise.

## Privileged roles

On testnet every account role below is held by the deployer, [`0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282`](https://explorer.test.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282), which is also the treasury.

| Role | Can | Timelock (testnet / mainnet) |
| --- | --- | --- |
| VaultV2 owner | Set the owner, curator, sentinels, name and symbol | none by VaultV2 design |
| VaultV2 curator | Add or remove adapters, raise caps, set fees and fee recipients (performance and management), forced-exit penalties, gates, adapter registry and allocators; abdicate functions | 0 / 1 day on every one of these |
| VaultV2 sentinel | Deallocate to the vault, lower caps, revoke pending curator actions | none; it can only reduce risk |
| VaultV2 allocator | `allocate`, `deallocate`, `setMaxRate`, and the liquidity adapter: held by the VoteAllocator contract only | n/a |
| MorphoMarketV1AdapterV2 (through the vault's curator) | `burnShares`, `setSkimRecipient`, `abdicate` | 0 / 1 day |
| CreditVoter owner | List lines after the bootstrap (`proposeLine`, `executeLine`); activate or deactivate a line; set the escrow registry (once, already set) | listing 0 / 1 day; activation immediate |
| VoteAllocator owner | Set the pool and the savings adapter (once each, already set); set the vault's max rate up to 200% a year; turn parking in sMUSD on or off (`setParking`); set, replace or remove the peg gate (`setPeg`) | immediate |
| SuretyPool owner | Set the allocator (once, already set); nothing else | n/a |
| VeBTCCreditLine owner | Pause and unpause new borrowing; switch the peg check on `open` and `borrowMore` off or on (`setPegCheck`); set the pool (once, already set). Cannot move NFTs or MUSD; the treasury is fixed at deployment | immediate |
| Treasury | Receives the origination fee, the treasury part of liquidation fees, the management fee and the ShareMarket fee. No powers; must stay a pure fee sink | n/a |
| MusdPeg, its sources, BtcMusdPriceSource, SavingsAdapter, ShareMarket | No owner | n/a |
| Morpho Blue owner | On the v1 testnet deployment only, the deployer: enable IRMs and LLTVs, set a market fee and fee recipient. v2 uses Mezo's Morpho Blue on both chains, which Mezo owns | immediate |
| StressedPriceSource, StressedPegSource (testnet only) | Anyone: a BTC price haircut of up to 90%, or a MUSD/USD override in [$0.50, $2] (or an outage), for up to 2 hours | n/a; refused on mainnet |
| Sponsor owner (testnet only) | Set the kit, the relayers and the daily limit; withdraw the Sponsor's funds | immediate |
| Sponsor relayer (testnet only) | Hand a wallet its one starter kit, within the daily limit | n/a |
| Permissionless actions | Anyone, including the keeper: `rebalance`, `poke`, `checkpoint`, `cover`, `claim`, `startAuction`, `bid`, `repay`, `harvest` on loans with auto-repay on, the savings adapter's `harvest`, ShareMarket `list`, `fill` and `cancel`, and `sync` on the peg's basic pools | n/a |
