# What changed since Wave 1

Surety v2 is a redeployment built around the Wave 1 review. This page takes the review point by point: what changed (contract, file and commit), the evidence on chain, and how to check it yourself. Where something is not finished, a **Pending —** line says what is left and when it lands; it is replaced with the transaction once it exists.

> Your integration is deep on the veBTC side (voting power, veBTC custody as collateral, PoolsVoter and RewardsDistributor pass-through, the Skip oracle), but on-chain only the veBTC escrow transfer and auction release were exercised, and the mainnet vault holds no MUSD. For Wave 2, run the escrow vote, fee/bribe and rebase claim paths on chain, put real MUSD through the mainnet vault on Mezo's own Morpho Blue (testnet used a self-deployed Morpho), and get outside users borrowing against veBTC. Add a MUSD/USD price feed or depeg check in place of the hard-coded $1, and widen the gap between the auction trigger and the floor. State who pays the team and how the protocol sustains itself beyond sponsor incentives, and make sure the live app loads quickly; our headless browser timed out on it.
>
> — Wave 1 review

The v2 deployment on Mezo testnet is [`contracts/deployments/31611.json`](contracts/deployments/31611.json) (block 16,667,109, 2026-11-09); v1 is kept in [`contracts/deployments/v1/`](contracts/deployments/v1/). Every transaction below is also listed in [docs/PROOF.md](docs/PROOF.md), and every claim is graded in [docs/CLAIMS.md](docs/CLAIMS.md). App pages are on [surety-credit.vercel.app](https://surety-credit.vercel.app).

Pending — production deploy of the v2 app. surety-credit.vercel.app still serves the Wave 1 build, so the v2 pages named below (`/app/try`, `/app/peg`, `/app/ledger`, `/app/business`, `/app/market`, `/app/review`) return 404 there until it lands, before 2026-11-15. Until then `pnpm install && pnpm --filter web dev` serves them locally against the live chains.

## At a glance

| Wave 1 review point | Status on 2026-11-09 |
| --- | --- |
| [Escrow vote, fee/bribe and rebase claims on chain](#1-escrow-vote-feebribe-and-rebase-claims) | Escrow votes and bribes on chain on v1 and v2 testnet; the claims follow the Mezo epoch flip on 2026-11-12 |
| [Real MUSD through the mainnet vault on Mezo's Morpho Blue](#2-real-musd-through-the-mainnet-vault-on-mezos-morpho-blue) | v2 testnet runs on Mezo's own testnet Morpho Blue; v2 mainnet and real MUSD pending |
| [Outside users borrowing against veBTC](#3-outside-users-borrowing-against-vebtc) | Starter kits, Try it and the users ledger built and run on chain; no outside users yet |
| [MUSD/USD price or depeg check](#4-a-musdusd-price-instead-of-1) | Done: MusdPeg, BtcMusdPriceSource, borrow breaker; a `PegUnhealthy` revert on chain |
| [Gap between auction trigger and floor](#5-the-gap-between-the-auction-trigger-and-the-floor) | Done: trigger 65% LTV, floor 85% (was 70% and 70%); an auction with no shortfall on chain |
| [Who pays the team, how the protocol sustains itself](#6-who-pays-the-team-and-how-the-protocol-sustains-itself) | Done: four protocol fees to a treasury, each exercised on chain; [docs/BUSINESS.md](docs/BUSINESS.md) |
| [The live app loads quickly](#7-the-live-app-loads-quickly) | Done in the build and measured in headless Chrome; production deploy pending |

## 1. Escrow vote, fee/bribe and rebase claims

> run the escrow vote, fee/bribe and rebase claim paths on chain
>
> — Wave 1 review

**What changed**

- `VeBTCCreditLine.setAutoRepay` and `harvest` ([`contracts/src/lines/VeBTCCreditLine.sol`](contracts/src/lines/VeBTCCreditLine.sol), `b206f68`). With auto-repay on, anyone may harvest a loan's escrowed NFT: its fees and bribes are claimed to the line, the MUSD among them repays the debt (any excess goes to the borrower), other tokens go to the borrower, and the veBTC rebase compounds into the lock. Off, only the borrower can harvest. Harvests never read the oracle or the peg.
- The keeper harvests every auto-repay loan once per Mezo epoch, as soon as its NFT has something to claim (`keeper/src`, `8b55d3a`).
- Scripts that run the escrow paths against Mezo testnet: [`keeper/scripts/testnet-escrow-vote.ts`](keeper/scripts/testnet-escrow-vote.ts) and [`testnet-escrow-claims.ts`](keeper/scripts/testnet-escrow-claims.ts) (`9110685`), and the v2 lifecycle [`testnet-cycle-v2.ts`](keeper/scripts/testnet-cycle-v2.ts) (`a5c35ea`).

**On chain**

Mezo pays an epoch's fees and bribes only after the epoch has ended, so the claims follow the votes by one Mezo epoch. Both runs voted and bribed in the Mezo epoch that started on 2026-11-05, on the MUSD/mUSDC stable pool's gauge.

| Deployment and loan | Step | Transaction |
| --- | --- | --- |
| v1 testnet, loan #2 (veBTC #1731, escrow [`0x6d3E…66dE`](https://explorer.test.mezo.org/address/0x6d3E19D4612b059B05aC9E1Bc5F6BC0270f266dE)) | Escrow votes the NFT 100% on MUSD/mUSDC | [0x1b78…9612](https://explorer.test.mezo.org/tx/0x1b78236ede57063dedf03347ee23c1c4ccc3920f081495332b5d997f17c99612) |
| | 20 MUSD bribe on that gauge | [0xef7a…919b](https://explorer.test.mezo.org/tx/0xef7ab6f4f99ef53b81d568de533ddd140711f8d86685113e787bb0a220a7919b) |
| v2 testnet, loan #1 (veBTC #1732, escrow [`0xaC0B…9dC8`](https://explorer.test.mezo.org/address/0xaC0BB1C4afD4863e936A4aa9d15DB0f45f849dC8)) | Auto-repay on | [0x30a8…fc41](https://explorer.test.mezo.org/tx/0x30a85874117863e547421a90056a812bea381561e7200b8b8a87ddbf3e3efc41) |
| | Escrow votes the NFT 100% on MUSD/mUSDC | [0x1a50…0430](https://explorer.test.mezo.org/tx/0x1a50ee48bfa2a189fab44bbdccf936f6f630c4fe994766e0ce4d575529720430) |
| | 20 MUSD bribe on that gauge | [0x203f…ad0f](https://explorer.test.mezo.org/tx/0x203fd6fb5dfb44df73c952b5e99dbb6dc7330876861018df679d445e0594ad0f) |

Pending — the fee/bribe claim (`escrowClaim`) and the rebase claim (`escrowClaimRebase`) on v1 loan #2, and the auto-repay `harvest` of v2 loan #1, from the Mezo epoch flip on Thu 2026-11-12 00:00 UTC. Mezo's RewardsDistributor refuses rebase claims until it has booked the week, so the rebase claim may land later that day.

**Check it yourself**

- The escrows' votes on Mezo's PoolsVoter (non-zero; use 1731 for the v1 loan):
  `cast call 0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D "votes(uint256,address)(uint256)" 1732 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e --rpc-url https://rpc.test.mezo.org`
- What the NFT has earned from the gauge's bribe contract: zero until the flip, the claimable MUSD after it:
  `cast call 0xAD0a02013fb65C2bc6cAeb86aeDF16F1c5DCd95E "earned(address,uint256)(uint256)" 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 1732 --rpc-url https://rpc.test.mezo.org`
- In the app: `/app/borrow` on testnet, the loan's escrow panel lists its votes, what it has earned and the harvest a call would make.
- Tests: `forge test --match-contract 'HarvestTest|LoanEscrowTest'` in `contracts/`.

## 2. Real MUSD through the mainnet vault on Mezo's Morpho Blue

> put real MUSD through the mainnet vault on Mezo's own Morpho Blue (testnet used a self-deployed Morpho)
>
> — Wave 1 review

**What changed**

- v2 deploys on Mezo's own Morpho Blue on both chains ([`contracts/script/Deploy.s.sol`](contracts/script/Deploy.s.sol), `fd1f8c7`). On testnet that is Mezo's testnet Morpho Blue [`0xCe1d…5a73`](https://explorer.test.mezo.org/address/0xCe1da828cA15cb1FDAfa84C366A53C8106655a73) and AdaptiveCurveIrm [`0x0c97…7441`](https://explorer.test.mezo.org/address/0x0c97Fe017628636649ff374aD499529F91167441), both verified on Mezo's explorer, with a new BTC/MUSD market (`0xf0bb…e3ff`) at LLTV 77%, the LLTV it enables. The Morpho Blue that v1 deployed from pinned sources is no longer used. On mainnet, v1 already uses Mezo's Morpho Blue [`0x5658…A311`](https://explorer.mezo.org/address/0x565834cE7E40b8987BC20EbF83E2159467bDA311), and v2 keeps it.
- The v2 testnet deployment (`9a6f096`) and its run (`a5c35ea`, `f297265`).

**On chain**

- The first v2 rebalance takes 108 MUSD out of sMUSD and supplies 32.40 MUSD of it to the market on Mezo's testnet Morpho Blue: [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2).
- A borrower posts 0.001 BTC there and borrows 25 MUSD: [0xf9eb…589c](https://explorer.test.mezo.org/tx/0xf9eb091db4014a1cfb9f525e54ae5d2a9dec853cc27b33d72b1281ef4021589c), [0xcbb9…470c](https://explorer.test.mezo.org/tx/0xcbb985778ed1d8e71c4d7893dc172650048b30c31bbc755d852c35d69f4d470c).

Pending — v2 on Mezo mainnet, on Mezo's Morpho Blue `0x5658…A311`, before 2026-11-15. The dry run of that deployment is [`contracts/deployments/dry-run/31612.json`](contracts/deployments/dry-run/31612.json).

Pending — real MUSD through the mainnet vault, right after the v2 mainnet deployment and before 2026-11-15: a deposit, the rebalance that supplies the Morpho market and funds the veBTC line, and a veBTC loan. These use the team's own MUSD and veBTC, in small amounts under the 2,000 MUSD caps, signed through the app.

**Check it yourself**

- The market's parameters: `marketParams` of line 0 in [`contracts/deployments/31611.json`](contracts/deployments/31611.json) name Mezo's testnet Morpho Blue and IRM.
- The v1 mainnet vault today: `cast call 0x632d627b66F2b11C8d0Fc61790422B0931D145de "totalAssets()(uint256)" --rpc-url https://mezo.drpc.org` returns 0. Once v2 is on mainnet, the same call on the v2 vault shows the deposit.

## 3. Outside users borrowing against veBTC

> get outside users borrowing against veBTC
>
> — Wave 1 review

**What changed**

- `Sponsor` ([`contracts/src/testnet/Sponsor.sol`](contracts/src/testnet/Sponsor.sol), `48dbf5d`, `d038239`), testnet only: one starter kit per wallet, ever. A kit is 0.00005 BTC for gas, a 0.001 BTC veBTC lock created for the wallet (28 days) and 50 test MUSD; at most 100 kits a UTC day. Its constructor refuses Mezo mainnet.
- The relayer that hands kits out: `POST /api/starter` ([`apps/web/api/starter.ts`](apps/web/api/starter.ts), `92bfa24`), which checks the address and the Sponsor's limits before sending and allows three requests per IP per ten minutes.
- Try it (`/app/try`, `508edad`, `dbbc885`): creates a testnet key in the browser, claims the kit, borrows against the kit's veBTC, shows the loan and its escrow, turns on auto-repay, votes the escrowed veBTC on Mezo and repays. No extension, faucet or bridge.
- The users ledger (`/app/ledger`, `b7411f6`, `02a2fcf`): every wallet that sent a successful transaction to a Surety contract or received a starter kit, on both networks and every deployment. Team wallets are listed in [`apps/web/src/lib/ledger.ts`](apps/web/src/lib/ledger.ts) and labelled, not hidden.
- Wallets: injected EVM wallets, WalletConnect, and Mezo Passport's Bitcoin wallets (`c5656dd`, `5dab7e0`).

**On chain**

- The Sponsor, verified on Sourcify: [`0x085c…9BA8`](https://repo.sourcify.dev/31611/0x085c6e2a022363c8F8811C4242F32373055d9BA8).
- Starter kit #1, through the relayer, to a team test wallet and labelled as the team's: [0x823f…1477](https://explorer.test.mezo.org/tx/0x823f99fc7d1e6efb55facc06676708f48fc994ee111de45259847107e5321477).

Pending — outside users. No outside wallet has borrowed yet: every wallet on the ledger is the team's. Kits open to visitors with the v2 app's production deploy (before 2026-11-15); outside wallets then appear on `/app/ledger` and in the Sponsor's `StarterKit` events as they arrive, and this section will list the ones that borrowed.

**Check it yourself**

- `/app/ledger`, or the Sponsor's events on the explorer: [`0x085c…9BA8`](https://explorer.test.mezo.org/address/0x085c6e2a022363c8F8811C4242F32373055d9BA8).
- `cast call 0x085c6e2a022363c8F8811C4242F32373055d9BA8 "kitsLeft()(uint256)" --rpc-url https://rpc.test.mezo.org` (4 on 2026-11-09).
- Test: `SponsorSuretyTest.test_newWalletBorrowsAndRepaysWithAStarterKit`.

## 4. A MUSD/USD price instead of $1

> Add a MUSD/USD price feed or depeg check in place of the hard-coded $1
>
> — Wave 1 review

**What changed**

Mezo's Skip precompile serves BTC/USD only and Mezo has no live MUSD/USD feed, so v2 builds one from Mezo's own pools.

- `MusdPeg` ([`contracts/src/oracles/peg/MusdPeg.sol`](contracts/src/oracles/peg/MusdPeg.sol), `3576405`): the median of a fixed set of sources. `pegHealthy()` holds when at least `minSources` read, their spread is within `maxSpreadBps` of the median, and the median is within `bandBps` of $1. Mainnet: 4 sources, 2 needed, 1000 bps spread, 300 bps band. No owner.
- The sources ([`contracts/src/oracles/peg/`](contracts/src/oracles/peg/), `3576405`, `145329b`, `568c884`):
  - `ClTwapPegSource`: a 30-minute TWAP of CL mUSDC/MUSD, read only if the pool's harmonic-mean in-range liquidity over the window reaches a floor (1e19), so a pool pushed out of range drops out instead of moving the price;
  - `StableTwapPegSource`: basic mUSDC/MUSD and MUSD/mUSDT, read only while the pool's latest observation is under 6 hours old;
  - `BtcCrossPegSource`: Skip BTC/USD divided by the 30-minute TWAP of CL BTC/MUSD, with its own liquidity floor (2e20).
- `BtcMusdPriceSource` ([`contracts/src/oracles/BtcMusdPriceSource.sol`](contracts/src/oracles/BtcMusdPriceSource.sol), `84263b7`, `62b189c`): BTC in MUSD is BTC/USD divided by the peg's median clamped to [$1, $1.03] while the peg is healthy, and by exactly $1 otherwise. BTC is never valued above BTC/USD. Both lines price collateral through it, the veBTC line directly and the Morpho market through `MorphoPriceOracle`.
- The breaker: `open` and `borrowMore` revert with `PegUnhealthy` while the peg is unhealthy (`b7235b1`), and `rebalance` funds no line (`43c2a4e`). Repayments, harvests, auctions, bids, escrow actions and withdrawals never read the peg. The owner can switch the borrow check off with `setPegCheck(false)` or replace the allocator's peg if Mezo's pools thin out for good (`23a2dc4`).
- The keeper calls `sync()` on the two basic pools so their observations stay fresh (`c313935`, `7213957`).
- Testnet has no usable MUSD pool, so the testnet peg is one `StressedPegSource`: $1 unless someone overrides it, which anyone can do for up to 2 hours. The deploy script refuses it on mainnet.

**On chain**

- Override: MUSD at $0.94 for 10 minutes: [0xbed9…e316](https://explorer.test.mezo.org/tx/0xbed9c4b242677a105923c898d371f34afe68777a660bee7df665a1ae770be316).
- A `borrowMore` of 1 MUSD sent anyway, with an explicit gas limit, reverts on chain with `PegUnhealthy`: [0x6438…8e16](https://explorer.test.mezo.org/tx/0x6438e38d8cd1dfb4f522a6c72c25cf987e97e98201d2838d2f7a7942633f8e16).
- Override cleared, peg healthy again: [0x2bd2…ac38](https://explorer.test.mezo.org/tx/0x2bd278fb0737d24b7684c9e7fd95df097984843630b3e17e8aa7e9997f7bac38).
- MusdPeg on testnet, verified on Sourcify: [`0xd54D…60AB`](https://repo.sourcify.dev/31611/0xd54D93aa56B080df424847142A1aaac59bB760AB).

**On mainnet pools, by fork test**

`SURETY_FORK=true forge test --match-contract LivePeg -vv` builds the four mainnet sources on a fork of Mezo mainnet at block 13,100,532 (2026-11-09) and reads Mezo's live pools:

| Source | Reading |
| --- | --- |
| CL mUSDC/MUSD | 0.99144 |
| Basic mUSDC/MUSD | 0.99125 |
| Basic MUSD/mUSDT | 0.98604, but its latest observation is 13.9 hours old, so it is left out (0.98603 after a `sync`) |
| BTC cross (CL BTC/MUSD and Skip) | 1.00246 |
| Median | 0.99144: healthy, so borrowing is open; under $1, so BTC is priced at BTC/USD |

Pending — the mainnet MusdPeg, with the v2 mainnet deployment before 2026-11-15.

**Check it yourself**

- `/app/peg`: every source's reading, the median, health and the allocator's gate; on testnet, a control to push MUSD off its peg for a few minutes.
- `cast call 0xd54D93aa56B080df424847142A1aaac59bB760AB "pegHealthy()(bool)" --rpc-url https://rpc.test.mezo.org`
- Tests: `forge test --match-contract 'PegTest|OraclesTest|AuditV2'` in `contracts/`, and the fork test above.

## 5. The gap between the auction trigger and the floor

> widen the gap between the auction trigger and the floor
>
> — Wave 1 review

**What changed**

- The veBTC line's auction trigger moves from 70% to 65% LTV and its floor from 70% to 85% of the collateral value (`b7235b1`; deployed by `fd1f8c7`). In v1 an auction started at the trigger and decayed to the floor cleared below the debt by design.
- The constructor now refuses a floor that does not sit above debt plus fee at the trigger: `floorBps × 10,000 > liqLtvBps × (10,000 + liqFeeBps)`. With a 65% trigger and a 3% fee, debt plus fee is at most 66.95% of the collateral value, against an 85% floor: an 18-point cushion before any shortfall.

**On chain**

v2 testnet loan #2: 35 MUSD against 0.001 BTC of veBTC at 47.20% LTV ([0x539f…3265](https://explorer.test.mezo.org/tx/0x539f2e7a9d331870bc41cd1c99d86ea14d22b3fe18f52aeff8702e2317c03265)).

- BTC shocked by −32.59%, which puts the loan at 69.95%: [0xb206…d00f](https://explorer.test.mezo.org/tx/0xb2066af885c361d1c7bbd1a378bef126eed673254386871c129c4cbcbde4d00f).
- Auction started by the keeper wallet: [0x14d3…4643](https://explorer.test.mezo.org/tx/0x14d39883aa93586a82b2867b3bb4bdf51f5146361dc0c4092ee236a4a4344643).
- Bid after 300 s at 92.50% of the collateral value: 46.13 MUSD for a 35.00 debt, no shortfall, 10.08 MUSD back to the borrower: [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1). The floor at that moment, 42.57 MUSD, was above debt plus fee (36.05).

**Check it yourself**

- `cast call 0x390B074E003559Cc1868cac0D06A4364BdeDb6f1 "params()(uint16,uint16,uint16,uint16,uint16,uint32,uint32,uint16,uint16,uint16)" --rpc-url https://rpc.test.mezo.org` returns `5000 4000 6500 300 8500 600 3600 25 2000 5000`: max LTV timed and permanent, trigger, fee, floor, auction seconds, minimum term, origination fee, protocol share, keeper share.
- `/app/auctions` draws the price curve and shows where a bid goes.
- Tests: `VeBTCCreditLineTest.test_constructor_requiresFloorAboveDebtPlusFeeAtTrigger`, `LineInvariants.invariant_badDebtIsShortfalls`.

## 6. Who pays the team and how the protocol sustains itself

> State who pays the team and how the protocol sustains itself beyond sponsor incentives
>
> — Wave 1 review

**Who pays the team.** Nobody, yet. The team builds Surety on its own time and no fee goes to it today. Protocol fees go to one treasury, which pays running costs first: the keeper's gas, operations, then security reviews. Only income above those would pay the team, and at the current caps there is none. The treasury is the deployer key, [`0x37D5…C282`](https://explorer.test.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282), until a multisig takes over.

**How it sustains itself.** Four fees, none of them from sponsors:

| Fee | Rate | Where | Commit | On chain |
| --- | --- | --- | --- | --- |
| Origination | 0.25% of each veBTC borrow, to the treasury | `VeBTCCreditLine.open`, `borrowMore` | `b7235b1` | `OriginationFeePaid` 0.0625 MUSD on a 25 MUSD loan: [0x9f8d…99f9](https://explorer.test.mezo.org/tx/0x9f8decd8a5fa3e6944f3186d0d7f59f915627ee569558e4425da8858e2ea99f9) |
| Liquidation | 3% of the debt: 80% to lenders, 10% to the treasury, 10% to whoever started the auction | `VeBTCCreditLine.bid` | `b7235b1` | `LiquidationFeePaid` 0.84 / 0.105 / 0.105 MUSD: [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1) |
| Management | 0.20% of vault assets a year, minted as srMUSD to the treasury | VaultV2's own management fee | `fd1f8c7`, `cc9419d` | `managementFee()` = 63419583 (per second, WAD) and `managementFeeRecipient()` = the treasury on the v2 vault |
| Share market | 0.10% of each fill, from the seller's side | `ShareMarket.fill` | `a2c6fe5` | 0.0099 MUSD on a 9.90 MUSD fill: [0x741e…de8a](https://explorer.test.mezo.org/tx/0x741e1b596a09c35b382c5ef245c16a168ea6eb725f86e09b2ceb2088ecbfde8a) |

The voters' 10% performance fee is unchanged and is not protocol income: it is what lenders pay voters to stand first in line for losses. Sponsor incentives go to voters too.

What it adds up to ([docs/BUSINESS.md](docs/BUSINESS.md), `3999ac0`; assumptions stated there): about 20.5 MUSD a year at the mainnet caps, about 5,100 at $1M in the vault and 51,000 at $10M. Fees cover operations and one review a year from about 4.1M MUSD in the vault; below that the treasury runs at a loss and the team covers the difference.

**Check it yourself**

- `/app/business` (`b53a12a`): the same tables, with the fee rates read from the contracts.
- `cast call 0x52aD2746994a1BC318cDf09b81f7831fB9Af03b8 "managementFeeRecipient()(address)" --rpc-url https://rpc.test.mezo.org`
- Tests: `VeBTCCreditLineTest.test_originationFee_paidToTreasury_debtIsFullAmount`, `testFuzz_bid_splitsFeeExactly`, `LineInvariants.invariant_feeConservation`, `ShareMarketTest.test_fill_paysTheSellerAndTheTreasury`.

## 7. The live app loads quickly

> make sure the live app loads quickly; our headless browser timed out on it.
>
> — Wave 1 review

**What changed**

- First paint never waits on an RPC: [`apps/web/scripts/snapshot.ts`](apps/web/scripts/snapshot.ts) reads both chains through the SDK at build time, and the static pages render that snapshot with its "as of" time; live reads replace it as they arrive (`7dd3288`, `dd8b2eb`, `e54141e`).
- Every RPC request has a 4-second timeout and falls back across the public RPCs of each chain, mainnet by default (`59d5384`); calls the testnet node answers with "method handler crashed" are retried (`e8511a0`). Polling pauses while the tab is hidden.
- Route prefetches no longer 404 (`7e9a068`).
- Less script before the page is usable: the SDK client loads on the landing with its first live read, about 70 KB less (`71cf9e8`), and Mezo Passport's chunk, about 430 KB compressed, loads only when a Bitcoin wallet is installed or asked for (`2a77c84`).
- A load check in headless Chrome, [`apps/web/scripts/check-load.ts`](apps/web/scripts/check-load.ts) (`7e9a068`): the landing, `/app` and `/app/try` must show their content with every Mezo RPC host blocked, reach network idle within 5 s with the RPCs up, and a hidden tab must make no RPC request.

**Measured** on 2026-11-09 with `pnpm --filter web check:load`: the production build of `23f8596`, served locally, Chrome headless at 1366×900.

| Page | RPCs | DOMContentLoaded | load | network idle |
| --- | --- | ---: | ---: | ---: |
| `/` | blocked | 122 ms | 755 ms | 2,457 ms |
| `/app` | blocked | 171 ms | 240 ms | 1,948 ms |
| `/app/try` | blocked | 154 ms | 221 ms | 840 ms |
| `/` | up | 301 ms | 463 ms | 1,758 ms |
| `/app` | up | 167 ms | 250 ms | 1,489 ms |
| `/app/try` | up | 142 ms | 216 ms | 826 ms |

Every page showed its content with the RPCs blocked, with no 404 and no console error. A hidden `/app` tab made no RPC request in 20 s.

Pending — production deploy of the v2 app (the live site still serves the Wave 1 build), before 2026-11-15; this table then gets a row set for the live URL.

**Check it yourself**

```sh
pnpm install && pnpm --filter web build
pnpm --filter web check:load                                                      # the build, served locally
cd apps/web && node scripts/check-load.ts --url https://surety-credit.vercel.app  # the live site
```

## Other changes in v2

### Idle cash in sMUSD

The vault's idle MUSD, the 10% buffer included, now sits in Mezo's sMUSD instead of idle. `SavingsAdapter` ([`contracts/src/SavingsAdapter.sol`](contracts/src/SavingsAdapter.sol), `f943cfe`) is a VaultV2 adapter over sMUSD, and the VoteAllocator makes it the vault's liquidity adapter: deposits land in sMUSD, withdrawals pull from it, and each rebalance funds lines from it and parks what is left (`1d940b5`). The voters' fee on sMUSD yield goes to the pool's reserve, not to any line's cohort (`0f9767a`), and covers count what sits in sMUSD as available (`073b8b2`). sMUSD's yield has been about 0.05% a year lately, so this is about keeping cash productive, not a source of return.

- On chain: a 100 MUSD deposit lands in sMUSD, leaving no idle MUSD: [0xe25a…51f8](https://explorer.test.mezo.org/tx/0xe25a1e53b909718a19de0b74823a81c6ad68a66b596f950c1f4006f49c8d51f8); the rebalance moves 108 MUSD from sMUSD to the lines and leaves the 12 MUSD buffer parked: [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2). Testnet sMUSD paid no yield during the run, so no savings harvest was sent.
- Risk: Mezo's owner of sMUSD can upgrade it or switch its strategy, which could make withdrawals above idle revert; the allocator's owner then calls `setParking(false)` ([docs/SECURITY.md](docs/SECURITY.md#residual-risks)).
- Tests: `SavingsAdapterTest`, `VoteAllocatorSavingsTest`, `LifecycleSavingsTest`, `SuretyInvariantsWithSavings` (`2493b7f`, `912140f`), and the fork suite `LiveSavings` against live sMUSD on mainnet (`33233f6`).

### ShareMarket

A lender can sell srMUSD at a discount to the live share price when the vault's cash is lent out and `redeem` would fail ([`contracts/src/ShareMarket.sol`](contracts/src/ShareMarket.sol), `a2c6fe5`; page `/app/market`, `4d13079`). Fills price at the share price when they happen; the market has no owner and holds only the shares of open listings. It follows the deposit gate: while deposits are paused after a loss, listings and fills wait, and `cancelAndRedeem` stays open.

- On chain: list 20 srMUSD at 1% below the share price [0x7021…af2f](https://explorer.test.mezo.org/tx/0x70219e3e4abba568bfbb11780a873b52207aca822593858c283c09002c23af2f), a 10 srMUSD fill for 9.9004 MUSD [0x741e…de8a](https://explorer.test.mezo.org/tx/0x741e1b596a09c35b382c5ef245c16a168ea6eb725f86e09b2ceb2088ecbfde8a), cancel the rest [0x9995…e828](https://explorer.test.mezo.org/tx/0x99951f4ae7ce88ea016493bc872c908eea30f51c11930cd20b4ee86b3a4ee828).
- Tests: `ShareMarketTest`, `ShareMarketFuzzTest` (`1f1d86c`), `ShareMarketSuretyTest` through a loss and its cover (`d450731`).

### Security review of the v2 changes

An independent review of the v2 diff, at `d33193c`, found 1 high, 2 medium and 2 low issues, plus 8 informational notes. All five issues are fixed, each with regression tests, merged in `10b1114`:

| ID | Finding | Fix |
| --- | --- | --- |
| V2-H-01 | Two thin CL pools could lift the peg's median to about $1.47 for about $78 in fees, pricing BTC 32% low and making healthy loans liquidatable | `62b189c` clamp; `145329b` window-liquidity floor |
| V2-M-01 | One pushed CL pool tripped the borrow breaker for 30 minutes, for about $7 | `145329b`, `b47d831` |
| V2-M-02 | The management fee to the treasury made the vault's accrual recurse through the deposit gate after a cover, burning all gas | `59ab3e9` |
| V2-L-01 | A peg tripped for good had no way out | `23a2dc4` |
| V2-L-02 | Stale stable-pool sources could hide a 4% depeg | `145329b` |

Each finding with its impact, fix, regression tests and the risks that remain: [docs/SECURITY.md](docs/SECURITY.md#v2-review-the-wave-2-changes).

### Verification

All 18 Surety contracts of the v2 testnet deployment are an exact match on Sourcify (runtime bytecode); links in the [README](README.md#deployments). Mezo's Blockscout verifier currently lists no Solidity compiler versions (`GET https://api.explorer.test.mezo.org/api/v2/smart-contracts/verification/config` returns `"solidity_compiler_versions":[]`, and the same on mainnet), so contracts cannot be verified there for now; Sourcify is where the sources are.

### Tests

- `forge test` in `contracts/`: 379 passed, 4 skipped (the opt-in fork suites); v1 had 197 passed and 1 skipped.
- `pnpm test`: 173 passed (sdk 83, keeper 56, mcp 13, web 21); v1 had 99.

### Keeper, SDK and MCP

- Keeper (`8b55d3a`, `c313935`): new actions `harvest` for auto-repay loans after each Mezo epoch flip, `harvest` on the savings adapter after each rebalance, and `sync` of the peg's two basic pools.
- SDK (`8145298`, `38ac9e9`): reads the peg, fees, savings, ShareMarket, the Sponsor's ledger and a loan's harvest plan, and builds every new transaction.
- MCP server (`2d2b61d`, `500ff5f`): tools for the peg, the fee schedule and ShareMarket.
