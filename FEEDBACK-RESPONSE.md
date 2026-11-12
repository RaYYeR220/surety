# What changed since Wave 1

Surety v2 is a redeployment built around the Wave 1 review. This page takes the review point by point: what changed (contract, file and commit), the evidence on chain, and how to check it yourself. Where something is not finished, a **Pending —** line says what is left and when it lands; it is replaced with the transaction once it exists.

> Your integration is deep on the veBTC side (voting power, veBTC custody as collateral, PoolsVoter and RewardsDistributor pass-through, the Skip oracle), but on-chain only the veBTC escrow transfer and auction release were exercised, and the mainnet vault holds no MUSD. For Wave 2, run the escrow vote, fee/bribe and rebase claim paths on chain, put real MUSD through the mainnet vault on Mezo's own Morpho Blue (testnet used a self-deployed Morpho), and get outside users borrowing against veBTC. Add a MUSD/USD price feed or depeg check in place of the hard-coded $1, and widen the gap between the auction trigger and the floor. State who pays the team and how the protocol sustains itself beyond sponsor incentives, and make sure the live app loads quickly; our headless browser timed out on it.
>
> — Wave 1 review

The v2 deployment on Mezo mainnet is [`contracts/deployments/31612.json`](contracts/deployments/31612.json) (blocks 13,118,781 to 13,118,934, 2026-11-09), and on Mezo testnet [`contracts/deployments/31611.json`](contracts/deployments/31611.json) (block 16,667,109, 2026-11-09); v1 is kept in [`contracts/deployments/v1/`](contracts/deployments/v1/). Every transaction below is also listed in [docs/PROOF.md](docs/PROOF.md), and every claim is graded in [docs/CLAIMS.md](docs/CLAIMS.md). App pages are on [surety-credit.vercel.app](https://surety-credit.vercel.app).

The v2 app is live at [surety-credit.vercel.app](https://surety-credit.vercel.app) since 2026-11-09, with the pages named below (`/app/try`, `/app/peg`, `/app/ledger`, `/app/business`, `/app/market`, `/app/review`).

## At a glance

| Wave 1 review point | Status on 2026-11-12 |
| --- | --- |
| [Escrow vote, fee/bribe and rebase claims on chain](#1-escrow-vote-feebribe-and-rebase-claims) | Done on testnet: escrow votes, bribes, the fee/bribe claim, the rebase claim and an auto-repay harvest that repaid a loan. On mainnet a loan's escrow votes on Mezo; its first harvest follows the Mezo flip on 2026-11-19 |
| [Real MUSD through the mainnet vault on Mezo's Morpho Blue](#2-real-musd-through-the-mainnet-vault-on-mezos-morpho-blue) | Done: 2.5 MUSD in the v2 mainnet vault, 1.125 MUSD of it supplied to Surety's market on Mezo's Morpho Blue (1 MUSD borrowed there) and 1 MUSD lent against veBTC; every contract verified |
| [Outside users borrowing against veBTC](#3-outside-users-borrowing-against-vebtc) | Starter kits, Try it and the users ledger built and run on chain; no outside users yet |
| [MUSD/USD price or depeg check](#4-a-musdusd-price-instead-of-1) | Done: MusdPeg, BtcMusdPriceSource, borrow breaker; a `PegUnhealthy` revert on testnet; the mainnet MusdPeg live on Mezo's pools and healthy |
| [Gap between auction trigger and floor](#5-the-gap-between-the-auction-trigger-and-the-floor) | Done: trigger 65% LTV, floor 85% (was 70% and 70%); an auction with no shortfall on chain |
| [Who pays the team, how the protocol sustains itself](#6-who-pays-the-team-and-how-the-protocol-sustains-itself) | Done: four protocol fees to a treasury, each exercised on chain; [docs/BUSINESS.md](docs/BUSINESS.md) |
| [The live app loads quickly](#7-the-live-app-loads-quickly) | Done: live since 2026-11-09, measured in headless Chrome with the RPCs up and blocked |

## 1. Escrow vote, fee/bribe and rebase claims

> run the escrow vote, fee/bribe and rebase claim paths on chain
>
> — Wave 1 review

**What changed**

- `VeBTCCreditLine.setAutoRepay` and `harvest` ([`contracts/src/lines/VeBTCCreditLine.sol`](contracts/src/lines/VeBTCCreditLine.sol), `b206f68`). With auto-repay on, anyone may harvest a loan's escrowed NFT: its fees and bribes are claimed to the line, the MUSD among them repays the debt (any excess goes to the borrower), other tokens go to the borrower, and the veBTC rebase compounds into the lock. Off, only the borrower can harvest. Harvests never read the oracle or the peg.
- The keeper harvests every auto-repay loan once per Mezo epoch, as soon as its NFT has something to claim (`keeper/src`, `8b55d3a`).
- Scripts that run the escrow paths against Mezo testnet: [`keeper/scripts/testnet-escrow-vote.ts`](keeper/scripts/testnet-escrow-vote.ts) and [`testnet-escrow-claims.ts`](keeper/scripts/testnet-escrow-claims.ts) (`9110685`), and the v2 lifecycle [`testnet-cycle-v2.ts`](keeper/scripts/testnet-cycle-v2.ts) (`a5c35ea`).

**On chain**

Mezo pays an epoch's fees and bribes only after the epoch has ended, so the claims follow the votes by one Mezo epoch. Both testnet runs voted and bribed in the Mezo epoch that started on 2026-11-05, on the MUSD/mUSDC stable pool's gauge, and claimed after the flip on 2026-11-12 00:00 UTC. The mainnet loan's escrow voted in the epoch that started on 2026-11-12, so its rewards are paid from the flip on 2026-11-19.

| Deployment and loan | Step | Transaction |
| --- | --- | --- |
| v1 testnet, loan #2 (veBTC #1731, escrow [`0x6d3E…66dE`](https://explorer.test.mezo.org/address/0x6d3E19D4612b059B05aC9E1Bc5F6BC0270f266dE)) | Escrow votes the NFT 100% on MUSD/mUSDC | [0x1b78…9612](https://explorer.test.mezo.org/tx/0x1b78236ede57063dedf03347ee23c1c4ccc3920f081495332b5d997f17c99612) |
| | 20 MUSD bribe on that gauge | [0xef7a…919b](https://explorer.test.mezo.org/tx/0xef7ab6f4f99ef53b81d568de533ddd140711f8d86685113e787bb0a220a7919b) |
| | Fee/bribe claim (`escrowClaim`): 0.28029 MUSD of bribe and 0.00070 of fees, 0.28099 MUSD forwarded to the borrower | [0x4c69…057a](https://explorer.test.mezo.org/tx/0x4c69cd096ea6a5123de7357268541bb0bfd7ffaa9ac1565db00cf899cc3d057a) |
| | Rebase claim (`escrowClaimRebase`): 9.69e-10 BTC compounded into lock #1731 | [0x5fd3…76d0](https://explorer.test.mezo.org/tx/0x5fd3f2f9e1d7ef3a6ad70b6151bc94b98dcdf9f0fef89c3a0c639172c29e76d0) |
| v2 testnet, loan #1 (veBTC #1732, escrow [`0xaC0B…9dC8`](https://explorer.test.mezo.org/address/0xaC0BB1C4afD4863e936A4aa9d15DB0f45f849dC8)) | Auto-repay on | [0x30a8…fc41](https://explorer.test.mezo.org/tx/0x30a85874117863e547421a90056a812bea381561e7200b8b8a87ddbf3e3efc41) |
| | Escrow votes the NFT 100% on MUSD/mUSDC | [0x1a50…0430](https://explorer.test.mezo.org/tx/0x1a50ee48bfa2a189fab44bbdccf936f6f630c4fe994766e0ce4d575529720430) |
| | 20 MUSD bribe on that gauge | [0x203f…ad0f](https://explorer.test.mezo.org/tx/0x203fd6fb5dfb44df73c952b5e99dbb6dc7330876861018df679d445e0594ad0f) |
| | Auto-repay `harvest` by the keeper, in the first minute after the flip: 0.16722 MUSD of bribe and 0.00042 of fees, all 0.16764 MUSD used to repay the loan (`Harvested`) | [0x04be…09e6](https://explorer.test.mezo.org/tx/0x04bef77906dbad8690ea3a6a2a9d2dfa1b8ce5ff782236280976dcc4b36509e6) |
| v2 mainnet, loan #1 (veBTC #6178, escrow [`0xe991…Dc6c`](https://explorer.mezo.org/address/0xe9911556cF6AdFF73EeFD949530eFc6bC0B3Dc6c)), the team's own wallet | Auto-repay on | [0x7374…89cf](https://explorer.mezo.org/tx/0x7374c42dd721688d57472b285659d6823b3ea6817267372e87a1d250e28e89cf) |
| | Escrow votes the NFT 100% on Mezo's CL mUSDC/MUSD pool | [0x2706…1574](https://explorer.mezo.org/tx/0x2706f059e6e99d9c2fc19c1b7ebf6972ba067f581e9f9fff486d9e333bfc1574) |

Recorded in the deployment files in `01119a3` (testnet) and `0a46ca8` (mainnet).

Pending — mainnet harvest after 19 Nov: the auto-repay `harvest` of mainnet loan #1, from the Mezo epoch flip on Thu 2026-11-19 00:00 UTC. With auto-repay on, anyone may send it.

**Check it yourself**

- The escrows' votes on Mezo's PoolsVoter (non-zero; use 1731 for the v1 loan):
  `cast call 0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D "votes(uint256,address)(uint256)" 1732 0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e --rpc-url https://rpc.test.mezo.org`
- What the NFT has earned from the gauge's bribe contract; zero again since the harvest claimed it:
  `cast call 0xAD0a02013fb65C2bc6cAeb86aeDF16F1c5DCd95E "earned(address,uint256)(uint256)" 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 1732 --rpc-url https://rpc.test.mezo.org`
- The mainnet escrow's vote on Mezo's PoolsVoter, the CL mUSDC/MUSD pool:
  `cast call 0x48233cCC97B87Ba93bCA212cbEe48e3210211f03 "poolVote(uint256,uint256)(address)" 6178 0 --rpc-url https://mezo.drpc.org`
- In the app: `/app/borrow` on testnet, the loan's escrow panel lists its votes, what it has earned and the harvest a call would make.
- Tests: `forge test --match-contract 'HarvestTest|LoanEscrowTest'` in `contracts/`.

## 2. Real MUSD through the mainnet vault on Mezo's Morpho Blue

> put real MUSD through the mainnet vault on Mezo's own Morpho Blue (testnet used a self-deployed Morpho)
>
> — Wave 1 review

**What changed**

- v2 deploys on Mezo's own Morpho Blue on both chains ([`contracts/script/Deploy.s.sol`](contracts/script/Deploy.s.sol), `fd1f8c7`). On testnet that is Mezo's testnet Morpho Blue [`0xCe1d…5a73`](https://explorer.test.mezo.org/address/0xCe1da828cA15cb1FDAfa84C366A53C8106655a73) and AdaptiveCurveIrm [`0x0c97…7441`](https://explorer.test.mezo.org/address/0x0c97Fe017628636649ff374aD499529F91167441), both verified on Mezo's explorer, with a new BTC/MUSD market (`0xf0bb…e3ff`) at LLTV 77%, the LLTV it enables. The Morpho Blue that v1 deployed from pinned sources is no longer used. On mainnet, v1 already uses Mezo's Morpho Blue [`0x5658…A311`](https://explorer.mezo.org/address/0x565834cE7E40b8987BC20EbF83E2159467bDA311), and v2 keeps it.
- The v2 testnet deployment (`9a6f096`) and its run (`a5c35ea`, `f297265`).
- The v2 mainnet deployment (`233591f`), bundled in the SDK (`21d038c`).
- Its first real MUSD, recorded in [`contracts/deployments/31612.json`](contracts/deployments/31612.json) (`0a46ca8`) and rendered in [docs/PROOF.md](docs/PROOF.md#live-on-mainnet-v2) (`7448002`).

**On chain**

- v2 on Mezo mainnet, 2026-11-09: 124 transactions in blocks 13,118,781 to 13,118,934, all successful, for 0.0000482 BTC of gas ([`run-latest.json`](contracts/broadcast/Deploy.s.sol/31612/run-latest.json)). It opens a BTC/MUSD market on Mezo's Morpho Blue `0x5658…A311`, id `0x4bff245ddc101cd43e365aa1faff97351ab36a225e43d9a76aab82ff763030b8`, at LLTV 86%, priced by Surety's MorphoPriceOracle with Mezo's AdaptiveCurveIrm. Mezo's sMUSD [`0xb4D4…51CC`](https://explorer.mezo.org/address/0xb4D498029af77680cD1eF828b967f010d06C51CC) is the vault's liquidity adapter, and the Morpho line and the veBTC line are capped at 2,000 MUSD each. All 19 Surety contracts are an exact match on Sourcify (the LoanEscrow implementation, created by the line's constructor, on runtime bytecode); the addresses are in the [README](README.md#deployments) and in [`contracts/deployments/31612.json`](contracts/deployments/31612.json), the configuration read on chain in [docs/PROOF.md](docs/PROOF.md#configuration-on-chain-v2-mainnet).
- The first v2 rebalance takes 108 MUSD out of sMUSD and supplies 32.40 MUSD of it to the market on Mezo's testnet Morpho Blue: [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2).
- A borrower posts 0.001 BTC there and borrows 25 MUSD: [0xf9eb…589c](https://explorer.test.mezo.org/tx/0xf9eb091db4014a1cfb9f525e54ae5d2a9dec853cc27b33d72b1281ef4021589c), [0xcbb9…470c](https://explorer.test.mezo.org/tx/0xcbb985778ed1d8e71c4d7893dc172650048b30c31bbc755d852c35d69f4d470c).

Real MUSD through the mainnet vault, 2026-11-10 to 2026-11-12, from the team's own wallet [`0xF3B0…bC37`](https://explorer.mezo.org/address/0xF3B025ed707A50704f93658CA10797230AaFbC37) and the keeper [`0x37D5…C282`](https://explorer.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282). Small amounts, well under the 2,000 MUSD caps; no outside user is involved. Every transaction is in [docs/PROOF.md](docs/PROOF.md#live-on-mainnet-v2).

| Step | Transaction |
| --- | --- |
| Swap 0.0000334 BTC for 2.5076 MUSD on Tigris; lock 0.00003 BTC as veBTC #6178 | [0x6eb1…9a2a](https://explorer.mezo.org/tx/0x6eb10d6e0f2e4dbc09769d170d52a620bae30923af597c47477dddd6cf539a2a), [0xa528…a24e](https://explorer.mezo.org/tx/0xa528bd9a5fefa037d54be1c66a2a3c782a2f0a136de9739a3659e18021f8a24e) |
| Deposit 2.5 MUSD into the vault; it parks in Mezo's sMUSD | [0x7d97…213d](https://explorer.mezo.org/tx/0x7d975656b297ad55730cf9f77ca3cf5a8e7d16711051d162bc78c5ee0eea213d) |
| veBTC #6178 votes 50/50 for the Morpho line and the veBTC line | [0xba08…8554](https://explorer.mezo.org/tx/0xba084ecd540992f9b9c75422643ea4ea1de1ad1eeaeae26fdf2819fddf6d8554) |
| Keeper: savings harvest, 0.00086 MUSD of real sMUSD yield deposited back; sync of the basic MUSD/mUSDT pool for the peg | [0x9219…488c](https://explorer.mezo.org/tx/0x9219e7e7a4affd1c13e1c7d2be6f5ba0e366face879e7e85d4e0b49b4190488c), [0x1c64…2f3f](https://explorer.mezo.org/tx/0x1c6400adb016dbb8dcde59ca45350dbda8667d90c4299889c5aaddbdcd282f3f) |
| Rebalance by the votes: 1.1254 MUSD supplied to Surety's market on Mezo's Morpho Blue, 1.1254 MUSD to the veBTC line, the 0.25 MUSD buffer left in sMUSD | [0x4bc7…65d4](https://explorer.mezo.org/tx/0x4bc72f1a50a1e6999e83a3a18616438f177fdafd10bf4870587be4df77bd65d4) |
| veBTC loan #1: 1 MUSD against #6178 at 45.94% LTV, 0.0025 MUSD origination fee to the treasury; auto-repay on | [0x26ba…f719](https://explorer.mezo.org/tx/0x26ba1c58ca6735a33d9b65f77f01758ef88bd9833e67373d30ca9422419ef719), [0x7374…89cf](https://explorer.mezo.org/tx/0x7374c42dd721688d57472b285659d6823b3ea6817267372e87a1d250e28e89cf) |
| The loan's escrow votes #6178 on Mezo's PoolsVoter, 100% on CL mUSDC/MUSD | [0x2706…1574](https://explorer.mezo.org/tx/0x2706f059e6e99d9c2fc19c1b7ebf6972ba067f581e9f9fff486d9e333bfc1574) |
| 0.00003 BTC posted on Surety's market on Mezo's Morpho Blue, 1 MUSD borrowed (LTV 45.98%) | [0xa65f…840a](https://explorer.mezo.org/tx/0xa65f886e80bfc5dc42798029250cb719d077da6853f8a87fe96124d09b78840a), [0xfeb5…b999](https://explorer.mezo.org/tx/0xfeb519ffd962f04f8d3a710595917f2f2d57d01cf0b1c6dc0f7f2b60827cb999) |

Read on chain at block 13,178,340 (2026-11-12 13:41:56 UTC): the market on Mezo's Morpho Blue has 1.1254 MUSD supplied by the vault and 1.0000 borrowed, 88.86% utilisation; the veBTC line holds 1.1254 MUSD, 1.0000 of it lent and 0.1254 in cash; 0.2501 MUSD sits in sMUSD; Mezo's PoolsVoter shows `usedWeights(6178)` above zero and `poolVote(6178, 0)` = CL mUSDC/MUSD; the line's `loan(1)` shows the founder wallet as borrower with auto-repay on.

**Check it yourself**

- The mainnet market on Mezo's Morpho Blue: `cast call 0x565834cE7E40b8987BC20EbF83E2159467bDA311 "idToMarketParams(bytes32)(address,address,address,address,uint256)" 0x4bff245ddc101cd43e365aa1faff97351ab36a225e43d9a76aab82ff763030b8 --rpc-url https://mezo.drpc.org` returns MUSD, BTC, Surety's MorphoPriceOracle `0xE3C7…bb51`, Mezo's AdaptiveCurveIrm `0x3760…C1e7` and an LLTV of 0.86e18.
- The testnet market: `marketParams` of line 0 in [`contracts/deployments/31611.json`](contracts/deployments/31611.json) name Mezo's testnet Morpho Blue and IRM.
- The v2 mainnet vault: `cast call 0xFB1226A2C58168044d457b226528236a1F847bE1 "totalAssets()(uint256)" --rpc-url https://mezo.drpc.org` returns about 2.5e18 (2.5009 MUSD at block 13,178,340).
- What the vault supplied to the market and what is borrowed there: `cast call 0x565834cE7E40b8987BC20EbF83E2159467bDA311 "market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)" 0x4bff245ddc101cd43e365aa1faff97351ab36a225e43d9a76aab82ff763030b8 --rpc-url https://mezo.drpc.org`, the first and third values (1.1254e18 and 1e18 at block 13,178,340).
- The veBTC loan: `cast call 0x690C2F3Db0FAC14281c2a000CA3214C36516d87D "loan(uint256)((address,address,uint256,uint256,uint8,uint64,address,bool))" 1 --rpc-url https://mezo.drpc.org` names the borrower, the escrow, veBTC #6178 and auto-repay `true`.
- In the app, on mainnet: `/app` shows what each line holds and the idle MUSD, `/app/proof` lists every transaction above, and `/app/review` shows the key ones.

## 3. Outside users borrowing against veBTC

> get outside users borrowing against veBTC
>
> — Wave 1 review

**What changed**

- `Sponsor` ([`contracts/src/testnet/Sponsor.sol`](contracts/src/testnet/Sponsor.sol), `48dbf5d`, `d038239`), testnet only: one starter kit per wallet, ever. A kit is 0.00005 BTC for gas, a 0.001 BTC veBTC lock created for the wallet (28 days) and 30 test MUSD (50 for the first two kits, before the Sponsor was refilled with 30 kits on 2026-11-09: [0x2c14…c3d9](https://explorer.test.mezo.org/tx/0x2c14404a75df34f412cbde09989a249c40afe7a928c885924d6932ad8691c3d9)); at most 100 kits a UTC day. Its constructor refuses Mezo mainnet.
- The relayer that hands kits out: `POST /api/starter` ([`apps/web/api/starter.ts`](apps/web/api/starter.ts), `92bfa24`), which checks the address and the Sponsor's limits before sending and allows three requests per IP per ten minutes.
- Try it (`/app/try`, `508edad`, `dbbc885`): creates a testnet key in the browser, claims the kit, borrows against the kit's veBTC, shows the loan and its escrow, turns on auto-repay, votes the escrowed veBTC on Mezo and repays. No extension, faucet or bridge.
- The users ledger (`/app/ledger`, `b7411f6`, `02a2fcf`): every wallet that sent a successful transaction to a Surety contract or received a starter kit, on both networks and every deployment. Team wallets are listed in [`apps/web/src/lib/ledger.ts`](apps/web/src/lib/ledger.ts) and labelled, not hidden.
- Wallets: injected EVM wallets, WalletConnect, and Mezo Passport's Bitcoin wallets (`c5656dd`, `5dab7e0`).

**On chain**

- The Sponsor, verified on Sourcify: [`0x085c…9BA8`](https://repo.sourcify.dev/31611/0x085c6e2a022363c8F8811C4242F32373055d9BA8).
- Starter kit #1, through the relayer, to a team test wallet and labelled as the team's: [0x823f…1477](https://explorer.test.mezo.org/tx/0x823f99fc7d1e6efb55facc06676708f48fc994ee111de45259847107e5321477).

Pending — outside users. No outside wallet has borrowed yet: every wallet on the ledger is the team's, the founder's mainnet wallet of section 2 included, and each is labelled. Kits are open to visitors since the v2 app went live on 2026-11-09; outside wallets appear on `/app/ledger` and in the Sponsor's `StarterKit` events as they arrive, and this section will list the ones that borrowed.

**Check it yourself**

- `/app/ledger`, or the Sponsor's events on the explorer: [`0x085c…9BA8`](https://explorer.test.mezo.org/address/0x085c6e2a022363c8F8811C4242F32373055d9BA8).
- `cast call 0x085c6e2a022363c8F8811C4242F32373055d9BA8 "kitsLeft()(uint256)" --rpc-url https://rpc.test.mezo.org` (30 after the refill on 2026-11-09; 2 kits issued, both to team wallets).
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

**On mainnet, live**

The mainnet MusdPeg, [`0x0777…9a5F`](https://repo.sourcify.dev/31612/0x07777966126dBf0f3919E217D0A2247156879a5F) on Sourcify, went live with the v2 deployment on 2026-11-09, with 4 sources, 2 needed, a 1000 bps spread and a 300 bps band. Read at block 13,118,945, eleven blocks after the deployment's last transaction:

| Source | Reading |
| --- | --- |
| CL mUSDC/MUSD | not counted: the pool's in-range liquidity over the window, about 3.1e17, is under the 1e19 floor |
| Basic mUSDC/MUSD | 0.991271 |
| Basic MUSD/mUSDT | not counted: its latest observation was 13.8 hours old, past the 6-hour bound |
| BTC cross (CL BTC/MUSD and Skip) | 0.999005 |
| `musdUsdWad()` | 0.995137812070612232, the mean of the two sources that read |
| `pegHealthy()` | `true`: 2 sources, the minimum, 78 bps apart and 49 bps under $1, so borrowing is open |
| `BtcMusdPriceSource.priceWad()` | 75,150.1 MUSD per BTC, Skip's BTC/USD itself: under $1 the clamp divides by exactly $1 |

Every source and its pool: [docs/PROOF.md](docs/PROOF.md#the-mainnet-musd-peg-at-launch).

**Check it yourself**

- `/app/peg`: every source's reading, the median, health and the allocator's gate; on testnet, a control to push MUSD off its peg for a few minutes.
- The mainnet peg, today's reading; add `--block 13118945` for the values above:
  `cast call 0x07777966126dBf0f3919E217D0A2247156879a5F "pegHealthy()(bool)" --rpc-url https://mezo.drpc.org`
  `cast call 0x07777966126dBf0f3919E217D0A2247156879a5F "musdUsdWad()(uint256)" --rpc-url https://mezo.drpc.org`
  `cast call 0x6C97a90B2D49D6a6D67177F2D250942A2B4e1279 "priceWad()(uint256)" --rpc-url https://mezo.drpc.org`
- The testnet peg: `cast call 0xd54D93aa56B080df424847142A1aaac59bB760AB "pegHealthy()(bool)" --rpc-url https://rpc.test.mezo.org`
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

The live site, measured on 2026-11-09 against surety-credit.vercel.app from a headless Chrome in Europe:

| Page | Mezo RPCs | DOMContentLoaded | load | network idle |
| --- | --- | ---: | ---: | ---: |
| `/` | blocked | 432 ms | 789 ms | 2,313 ms |
| `/app` | blocked | 236 ms | 458 ms | 2,076 ms |
| `/app/try` | blocked | 227 ms | 456 ms | 1,453 ms |
| `/` | up | 215 ms | 544 ms | 2,136 ms |
| `/app` | up | 552 ms | 998 ms | 2,263 ms |
| `/app/try` | up | 851 ms | 995 ms | 1,830 ms |

A hidden tab on the live site made no RPC request in 20 s.

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

All 19 Surety contracts of the v2 mainnet deployment are an exact match on Sourcify, creation and runtime bytecode (the LoanEscrow implementation, created by the line's constructor, on runtime bytecode), and so are all 18 of the v2 testnet deployment (runtime bytecode); links in the [README](README.md#deployments). Mezo's Blockscout verifier currently lists no Solidity compiler versions (`GET https://api.explorer.test.mezo.org/api/v2/smart-contracts/verification/config` returns `"solidity_compiler_versions":[]`, and the same on mainnet), so contracts cannot be verified there for now; Sourcify is where the sources are.

### Tests

- `forge test` in `contracts/`: 379 passed, 4 skipped (the opt-in fork suites); v1 had 197 passed and 1 skipped.
- `pnpm test`: 173 passed (sdk 83, keeper 56, mcp 13, web 21); v1 had 99.

### Keeper, SDK and MCP

- Keeper (`8b55d3a`, `c313935`): new actions `harvest` for auto-repay loans after each Mezo epoch flip, `harvest` on the savings adapter after each rebalance, and `sync` of the peg's two basic pools.
- SDK (`8145298`, `38ac9e9`): reads the peg, fees, savings, ShareMarket, the Sponsor's ledger and a loan's harvest plan, and builds every new transaction.
- MCP server (`2d2b61d`, `500ff5f`): tools for the peg, the fee schedule and ShareMarket.
