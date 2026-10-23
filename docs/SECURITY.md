# Security

Surety has had an internal review and an independent review. It has not had an external audit. The code is live on Mezo testnet only, with every owner role held by one key; read the [residual risks](#residual-risks) and [privileged roles](#privileged-roles) before relying on it.

## Scope

| | |
| --- | --- |
| Reviewed commit | `9c9a79eb08e3e5efa62d8d9d10bcb9d3b0f8be3b` (the first testnet deployment) |
| Fixes | `4633c87`, `acea196`, `584a18f`, `3aea1c8`, `b065020`, `ff6b7d4`, `23f1dfb`, `020e684`, merged in `d8f2b45` |
| Deployed and re-checked | `09f1a4914fef0c648b0e6340f13fd545f5f3dc28` (current testnet deployment); the regression tests and Slither run at this commit |
| In scope | `contracts/src/`: CreditVoter, VoteAllocator, SuretyPool, DepositGate (added by the fixes), lines/VeBTCCreditLine, lines/LoanEscrow, lines/LinearKinkIrm, oracles/SkipPriceSource, oracles/MorphoPriceOracle, oracles/StressedPriceSource, interfaces, libraries; and `contracts/script/Deploy.s.sol` |
| Integration only | VaultV2 and MorphoMarketV1AdapterV2 (`lib/vault-v2` at `97bcce9`), Morpho Blue and AdaptiveCurveIrm, all vendored unmodified. Read to model the integration, not audited. |
| External, read only | Mezo's veBTC, PoolsVoter, RewardsDistributor and MezoForwarder, checked against their verified sources and with live calls on mainnet |
| Not in scope | The SDK, keeper, MCP server and web app. None of them holds a role; they send ordinary, permissionless transactions. |

## Method

- **Internal review during the build.** Invariants were written down before the code and kept as tests: a fuzzed invariant suite over random lender, voter, sponsor, borrower, liquidator, price-shock and keeper actions, plus adversarial unit tests for the escrow's call surface, reentrancy through token receivers, stale and malformed prices, over-slashing and auction edge cases. `forge lint` reports nothing at its default severity; its suppressions are scoped to single lines or blocks.
- **Independent review of `9c9a79e`.** The reviewer first stated the properties the system must keep (only the allocator moves vault capital, and only to listed adapters; fees follow each line's interest; voters bear at most the recorded loss and the recorded loss is the real one; a cover makes lenders whole; nobody but the borrower or the settlement logic moves an escrowed NFT; vote power is a snapshot at the epoch start; every MUSD in or out is accounted for). They then read every in-scope line and swept the usual bug classes with an eye on edge cases: first and last epoch, zero shares, dust, the epoch boundary, stale oracles, lock expiry and permanent locks. All four medium findings and three of the low ones came with a Foundry proof of concept on the repository's integrated fixture, which runs the real Morpho Blue, AdaptiveCurveIrm, VaultV2 and MorphoMarketV1AdapterV2 bytecode with mocked veBTC, PoolsVoter and Skip feed, each as a control branch and an attack branch from the same snapshot.
- **Regression tests.** Each proof of concept became a test in [`contracts/test/audit/AuditPoC.t.sol`](../contracts/test/audit/AuditPoC.t.sol) that replays the attack against the fixed code and asserts the fixed behaviour; L-06 got a test with its fix.
- **Slither** 0.11.6 on `contracts/src` at `09f1a49`, with dependencies, tests and scripts filtered out: 102 detectors, 133 results, triaged [below](#slither). None is a vulnerability.

Severity: **Medium** means funds can be lost or misattributed under realistic conditions, bounded by caps and pool size; **Low** means limited impact or unusual preconditions; **Informational** means no direct loss.

## Findings

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

### M-01: A forced exit could erase a line's measured interest

The allocator measured a line's interest as the change in its assets since the previous rebalance, and booked a drop as zero interest. VaultV2's `forceDeallocate` is permissionless, so anyone could pull slightly more than a line had earned out of it just before an epoch's first rebalance. That line's interest for the whole window then read as zero, and every voter fee share went to the other lines, including one the caller had voted for, at a cost of only the 1% exit penalty on a small amount. Interest no longer comes from asset changes: a Morpho line earns the shares it held at the last snapshot times the rise in Morpho's supply share price, and the veBTC line reports a cumulative interest counter that capital moves do not touch (`4633c87`). The regression runs the attack and checks that both lines' cohorts receive the same fee shares with and without it.

### M-02: A forced exit after Morpho bad debt could shrink the recorded loss

A Morpho loss was valued on the adapter's supply shares at the time of the checkpoint. If those shares fell between the bad debt and the checkpoint, through a `forceDeallocate` that can even be bundled with the liquidation itself, the loss on the shares that left was never recorded. Those shares left at the impaired price, so the loss was real: lenders bore it and the voters who should have paid kept their cohort. The pool now stores the adapter's shares with the mark, values a drop on the larger of the shares at the mark and now, and the allocator checkpoints again after its own moves to keep the stored count current (`acea196`). If a forced exit came before the bad debt within the same window this over-records, which is the direction that protects lenders.

### M-03: A deposit made after a loss could capture the cover

VaultV2 realises a loss immediately but recognises the MUSD that a cover returns only at its maximum rate, as a gain. A depositor arriving after the loss bought shares at the depressed price, held them while the cover was recognised, and took a pro-rata share of it; with a deposit much larger than the vault, that was most of the cover, and the lenders who took the loss were not made whole. The vault now has a receive-shares gate, `DepositGate`, which refuses new share receivers from the moment a loss exists (before anyone checkpoints it), while it is uncovered, and until VaultV2 has recognised the cover (`ff6b7d4`, wired by `020e684`). Withdrawals are never gated. The regression checks that deposits are refused at each of those stages, reopen once the cover is recognised, and that the pre-loss lender ends up whole.

### M-04: Lines could be listed instantly and without validation

The CreditVoter owner could list any contract as a credit line at once. The pool trusted a veBTC-kind line's reported bad debt and paid the shared reserve into it on `cover`, the allocator trusted its reported interest when splitting voter fees, and a line whose `ids()` reverted blocked every rebalance; one adapter could also be listed twice under different data. Now a line's adapter must already be a vault adapter (which VaultV2's own `addAdapter` timelock governs), a Morpho line must use the vault's Morpho adapter with canonical market parameters, and a veBTC line must report the Surety vault and is unique per adapter. After the bootstrap, which the deployment ends, listing takes `proposeLine` and then `executeLine` after `LINE_TIMELOCK`; the pool never records more loss for a line than the vault allocated to it; and the allocator guards every call into a veBTC-kind line, so a broken line only makes itself ineligible (`584a18f`, `3aea1c8`). The owner keys themselves are still a single account on testnet, and a line that clears both timelocks could still over-report interest; both are listed under residual risks.

### L-01: A stale Morpho mark recorded a loss the vault never took

The Morpho high-water mark only moved when a loss above dust was recorded. While the adapter held no shares, bad debt borne by other suppliers lowered the market's share price but left the mark where it was. When the vault later bought in at the lower price, its next checkpoint valued the new shares against the old mark, recorded a loss the vault never took, and slashed voters for it. The mark now moves to the current price and shares at every checkpoint (`acea196`, the same change as M-02), and the regression replays the scenario and checks that nothing is recorded or slashed.

### L-02: A stale oracle at the flip discarded the closed tally

The allocator chose an epoch's tally among lines with a live price. If the Skip feed was more than 60 seconds old at the first rebalance of an epoch, which anyone can call, no line qualified: the closed epoch's tally was thrown away for the whole epoch and every line targeted zero, pulling capital to idle and raising borrowers' rates. The tally is now chosen from active lines regardless of the oracle, and a line that cannot take new money holds what it has, up to its target (`3aea1c8`). The regression makes the feed stale at the flip and checks that the closed tally drives the epoch and the line keeps its capital.

### L-03: The Morpho adapter's timelocks were never raised

`MorphoMarketV1AdapterV2` starts with all of its own timelocks at zero, and its documentation asks for them to be set before a vault adds it. The deploy script did not, so the curator could call `burnShares`, which writes off the Morpho position with no Surety loss recorded, or `setSkimRecipient` and `abdicate`, without waiting out any of the vault's timelocks. The script now raises the adapter's timelocks on those three functions and on `increaseTimelock` itself to `VAULT_TIMELOCK` before the vault adds the adapter: 1 day on mainnet, zero on testnet (`020e684`). There is no Foundry test for the script; after a mainnet deployment, `timelock(bytes4)` on the adapter shows the values.

### L-04: Slashed cohorts paid more than the recorded loss

The cover sizing made the pool as a whole bear exactly the loss U. But the fee shares VaultV2 mints on the MUSD a cover returns came back to the pool as unattributed shares, and the next distribution handed them to whichever lines earned interest next, or to the reserve. The cohorts that were slashed therefore paid about U/(1 − f), roughly 11% more than the loss with a 10% fee. Each cover now records what it took from each cohort and from the reserve, and the following `distributeFees` calls credit the fee shares back to those cohorts pro rata as VaultV2 recognises the MUSD (`b065020`). The regression checks that the slashed cohort nets the recorded loss within 0.01% and that the reserve, which paid nothing, receives nothing.

### L-05: Draining the veBTC line's cash raises its rate

Anyone can pull the veBTC line's idle cash out with `forceDeallocate`, paying the 1% penalty to lenders. The line's utilisation, measured on its own cash, then reads 100%: every borrower accrues at the curve's 60% maximum APR and new loans revert until the allocator refills the line. This is acknowledged rather than changed. The cost to borrowers lasts only until the next rebalance and part of it goes to lenders, the keeper rebalances at every epoch flip and may rebalance mid-epoch when the line's cash falls well below its target, and the behaviour is documented in the line, the rate model and the keeper. Measuring utilisation against allocated capital rather than cash is a possible later change.

### L-06: A borrower could vote the NFT during its auction

The escrow's PoolsVoter actions were open to the borrower while the loan was in auction. Mezo's PoolsVoter allows one vote or reset per NFT per Mezo epoch, so a vote cast just before a bid handed the buyer an NFT it could not reset, withdraw, merge or split for up to a week, and bidders would discount for that, which raises the expected shortfall. `escrowVote` and `escrowReset` now require an active loan (`23f1dfb`). Claims stay open during an auction because they only pay out rewards the NFT earned while the borrower held it and leave the lock and its votes unchanged.

### Informational

- **I-01.** The deploy script creates the BTC / MUSD market without seeding it. The adapter's own share-price check prevents theft; what remains is a denial-of-service risk from share-price deflation after bad debt in a nearly empty market, so the mainnet market should be seeded from a dead address before caps rise. The market's oracle reverts when Skip is stale, which also blocks Morpho liquidations during an outage; that fail-closed trade-off is accepted.
- **I-02.** A ballot cast before an NFT enters a loan escrow still counts for that epoch, matured claims go to whoever owns the NFT at claim time (including an auction buyer), and merging or withdrawing an NFT forfeits its unclaimed cohorts to the reserve. All by design.
- **I-03.** Voters in the current epoch can move their votes off a line just before a cover and back afterwards. The current cohort, which holds this epoch's incentives, then escapes the slash and older cohorts pay more.
- **I-04.** Until an epoch closes with votes, the allocation follows the live tally and can be moved within the epoch, and the bootstrap cohort is credited for two windows. By design, and only at launch.
- **I-05.** On mainnet the deploy script does not range-check `VAULT_TIMELOCK`, `EPOCH_LENGTH` or the cap overrides, apart from the CreditVoter refusing a zero line timelock, and one account ends up holding every role.
- **I-06.** If a third party claims the rebase of an expired lock into an escrow after its loan has closed, the BTC paid to that escrow cannot be forwarded any more. The amounts are rebase dust.
- **I-07.** The allocator's documentation assumed it was the only party moving vault capital, ignoring the permissionless `forceDeallocate` and the sentinel. That assumption was the root of M-01 and M-02; the code and its documentation no longer rely on it.

## Verified non-issues

- **NFT custody.** Each loan gets its own `LoanEscrow` clone, initialised in the transaction that creates it; the implementation is locked at construction. The escrow's targets are fixed, it has no generic call or execute, no meta-transaction support (no ERC-2771), no `onERC721Received` and no payable function. The NFT arrives by plain `transferFrom` and leaves only through `release`, called by the line on full repayment or a winning bid. Every veBTC function that could move or shrink a lock (`withdraw`, `merge`, `split`, `lockPermanent`, `unlockPermanent`, `delegate`, `depositManaged`) is limited to the owner or an approved address, and the escrow never calls any of them. Grant locks are refused at `open`, and a normal NFT cannot gain a grant manager later. Transfers of a voted NFT are allowed and delegation bookkeeping does not revert, so a borrower cannot make `release` fail to block a liquidation.
- **Mezo's October 5 veBTC incident.** That exploit went through veBTC's trusted-forwarder meta-transaction path: the appended sender was not carried into external library calls, so a crafted `safeTransferFrom` payload could act as someone else ([Mezo's incident report](https://mezo.org/blog/incident-report-october-5-2026)). Mezo has since disabled meta-transactions on veBTC (`forwarder()` returns zero). Surety's escrow path does not touch that surface: it never calls `safeTransferFrom`, never passes data payloads and never goes through a forwarder. PoolsVoter still trusts MezoForwarder, but that forwarder only executes a request with a valid ECDSA signature from its `from` address, which a contract escrow cannot produce, and PoolsVoter has no multicall; so nobody can impersonate an escrow to vote, reset or deposit its NFT into a managed lock.
- **Reentrancy.** Every state-changing function of the line, the pool and the allocator is `nonReentrant` with a transient-storage guard. Mainnet MUSD is a plain OpenZeppelin ERC-20 without hooks, so no MUSD transfer, including the surplus paid to a borrower in `bid`, can re-enter or be blocked by the receiver. Reward tokens a borrower chooses in `escrowClaim` can only re-enter guarded functions, and the escrow forwards balance increases measured on live balances.
- **Vote double counting.** Power is read from veBTC's point history at the epoch start, with the boost already in the checkpointed points. Ballots in an epoch's first second are refused. Merges, splits, deposits and lock changes after the start only write later points, a transfer keeps the tokenId's ballot, and past epochs are never written.
- **Donation and inflation on a tiny seed.** VaultV2 recognises a donation no faster than `maxRate` times its total assets, so the share price cannot jump. With 100,000 MUSD donated onto a 0.5 MUSD seed, a later 1,000 MUSD deposit is still worth 1,000 MUSD to within one part per million (`test_NI_tinySeedDonationIsNotAnInflationAttack`).
- **Blocking the allocator.** Moves and checkpoints are wrapped in try/catch, nobody can burn the pool's shares (a `forceDeallocate` on the pool's behalf needs its allowance), and the work left after each inner call is too large for gas griefing under the 63/64 rule.
- **Steering the cover size.** Donating MUSD to inflate the pending amount lowers the cover by about the donation's own restoring value, so it substitutes rather than profits. The shares a cover burns never exceed the shares it may slash, given VaultV2's rounding directions.
- **Dutch auction.** The price falls monotonically to the 70% floor and is computed from the live collateral value. The line keeps at most the debt plus the 3% fee, the borrower gets the surplus, and a shortfall is recorded exactly; the line's assets drop by exactly the shortfall.

## Slither

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

- **Key centralisation.** One account is the vault's owner, curator and sentinel and the owner of every Surety contract (and, on testnet, of Morpho Blue). On testnet every timelock is zero. On mainnet the vault's curator functions and line listings wait 1 day, but the Surety owners' immediate powers remain: deactivating a line, setting the vault's max rate (a lower rate slows the recognition of covers) and pausing new veBTC loans. Every owner role should move to a multisig behind a timelock before caps rise.
- **A listed line is trusted.** A malicious line that clears VaultV2's `addAdapter` timelock and the CreditVoter's line timelock could report interest it did not earn and draw voter fees. What it can make the pool cover is bounded by what the vault allocated to it.
- **Upgradeable Mezo dependencies.** veBTC and PoolsVoter are proxies. An upgrade that re-enabled forwarder trust or changed `ownerOf`, `votingPowerOfNFTAt` or the lock layout would reopen custody and voting questions; their implementation slots should be monitored.
- **Liveness.** Checkpoints, covers, epoch flips and auctions need someone to call them. The keeper does, and every call is open to anyone. A stale Skip feed fails closed, which also stops Morpho liquidations until it recovers.
- **Inherited VaultV2 behaviour.** A loss is accounted once per transaction, and every gain is limited by `maxRate`. The second is why the deposit gate exists and why it can stay closed for days after a large loss.
- **Test fidelity.** veBTC, PoolsVoter and the Skip feed are mocks in the unit, integration, invariant and regression tests; their real behaviour was checked by reading their verified sources and calling them on mainnet. The opt-in fork suite (`SURETY_FORK=true`) deploys Surety against live mainnet state, with the BTC and Skip precompiles replaced by mocks because a local fork cannot execute them. It should run against mainnet before launch.
- **Scale.** Caps start at 2,000 MUSD per line on mainnet. The impact of most findings above grew with TVL and cohort size, so any change to the economics should be reviewed again before caps rise.

## Privileged roles

On testnet every account role below is held by the deployer, [`0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282`](https://explorer.test.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282).

| Role | Can | Timelock (testnet / mainnet) |
| --- | --- | --- |
| VaultV2 owner | Set the owner, curator, sentinels, name and symbol | none by VaultV2 design |
| VaultV2 curator | Add or remove adapters, raise caps, set fees and fee recipients, forced-exit penalties, gates, adapter registry and allocators; abdicate functions | 0 / 1 day on every one of these |
| VaultV2 sentinel | Deallocate to the vault, lower caps, revoke pending curator actions | none; it can only reduce risk |
| VaultV2 allocator | `allocate`, `deallocate`, `setMaxRate`: held by the VoteAllocator contract only | n/a |
| MorphoMarketV1AdapterV2 (through the vault's curator) | `burnShares`, `setSkimRecipient`, `abdicate` | 0 / 1 day |
| CreditVoter owner | List lines after the bootstrap (`proposeLine`, `executeLine`); activate or deactivate a line; set the escrow registry (once, already set) | listing 0 / 1 day; activation immediate |
| VoteAllocator owner | Set the pool (once, already set); set the vault's max rate up to 200% a year | immediate |
| SuretyPool owner | Set the allocator (once, already set); nothing else | n/a |
| VeBTCCreditLine owner | Pause and unpause new borrowing; set the pool (once, already set). Cannot move NFTs or MUSD | immediate |
| Morpho Blue owner (testnet only) | Enable IRMs and LLTVs, set a market fee and fee recipient. On mainnet Surety uses Mezo's Morpho Blue, which Mezo owns | immediate |
| StressedPriceSource (testnet only) | Anyone: apply a haircut of up to 90% for up to 2 hours | n/a; refused on mainnet |
| Permissionless actions | Anyone, including the keeper: `rebalance`, `poke`, `checkpoint`, `cover`, `claim`, `startAuction`, `bid`, `repay` | n/a |
