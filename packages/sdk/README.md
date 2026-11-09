# @surety/sdk

TypeScript SDK for Surety on Mezo. It reads the credit board, epochs, ballots, veBTC positions, reward cohorts, loans and auctions, and builds unsigned transactions for every user and keeper action. Built on viem 2; it never holds keys.

## Install

Inside this workspace the package is `workspace:*`. It has `viem` as a peer dependency.

```ts
import { createMezoPublicClient, createSuretyClient } from "@surety/sdk";

const publicClient = createMezoPublicClient(31611); // or 31612 for mainnet
const surety = createSuretyClient({ chainId: 31611, publicClient });

const board = await surety.getBoard();
const quote = await surety.quoteVeBTCBorrow(42n);
const [approve, open] = surety.buildOpenLoan({ tokenId: 42n, amount: quote.maxBorrow });
```

Pass `deployment` to `createSuretyClient` to use addresses that are not bundled (a local Anvil run, a fork).

## Reads

All reads of one call are pinned to the same block and batched through Multicall3 (`0xcA11…CA11`, deployed on both Mezo chains). Pass `multicall: false` to send individual `eth_call`s instead. A revert in one read (a stale oracle, for example) yields `null` for that field instead of failing the whole view.

| Method | Returns |
| --- | --- |
| `getEpoch()` | current epoch start, next flip, epoch length, active tally epoch, last rebalance epoch, season |
| `getBoard()` | per line: kind, active, vote share this epoch and last closed epoch, allocation, target, utilisation, supply and borrow APY, incentives this epoch, cover capacity, uncovered loss; plus vault stats |
| `getVault()` | TVL, share price, idle MUSD (the vault's own plus what is parked in sMUSD), fees, estimated depositor APY |
| `getBallot(tokenId)` | stored ballot, whether it counts this epoch or can be poked, power at epoch start |
| `getVeBTCPositions(owner)` | owned NFTs and NFTs in the owner's Surety loans: lock, power at epoch start, max borrow |
| `getCohorts(tokenId)` | the NFT's reward cohorts per line and epoch: claimable, maturing, at risk |
| `getLoans(borrower)` | loans found from `Opened` logs (10 000-block windows), with debt, LTV, maturity, liquidation price |
| `getLoan(loanId)`, `listLoans({ states })`, `getAuctions()` | loan views by id or state; auctions carry the live Dutch price |
| `quoteVeBTCBorrow(tokenId, amount?)` | max borrow, LTV, maturity, rate before and after, origination fee and what the borrower receives, reasons an NFT is ineligible (the MUSD peg among them) |
| `getFees()` | the line's origination fee and liquidation fee split, the vault's performance and management fees, the ShareMarket fee, the treasury |
| `getPeg()` (v2) | every MUSD/USD source's reading, the median, spread and distance from $1, `pegHealthy`, the allocator's gate, BTC/USD and BTC in MUSD |
| `getSavings()` (v2) | MUSD idle in the vault, parked in sMUSD, the total, claimable and claimed yield |
| `getShareMarket()`, `getShareListingsOf(seller)`, `quoteShareFill(id, shares)` (v2) | open srMUSD listings priced at the live share price, the best offer, a fill quote |
| `getSponsorLedger()` (v2 testnet) | the starter kit and every kit handed out (`StarterKit` events) |
| `getHarvestPlan(loanId)` (v2) | the pools the escrowed NFT votes on, what each fee and bribe contract has earned for it, the rebase, and `harvest`'s arguments |

Amounts are `bigint` in token units (18 decimals). Shares and APYs are plain numbers (0.05 = 5%). APYs are estimates: Morpho lines use the AdaptiveCurveIrm `borrowRateView` (or the curve at the stored rate at target if that view is unavailable); the veBTC line uses its LinearKinkIrm at the current utilisation.

## Transaction builders

Each builder returns `{ to, data, value }` for the user's wallet to send: `buildVote`, `buildPoke`, `buildDeposit`, `buildWithdraw`, `buildRedeem`, `buildApprove`, `buildApproveVeBTC`, `buildOpenLoan` (veBTC approve + open), `buildBorrowMore`, `buildRepay`, `buildExtend`, `buildAddCollateral`, `buildPostIncentive`, `buildRefundIncentive`, `buildStartAuction`, `buildBid`, `buildRebalance`, `buildCheckpoint`, `buildCover`, `buildClaim`, `buildSetAutoRepay`, `buildHarvest`, `buildSavingsHarvest`, `buildListShares` / `buildFillListing` (each with its approval), `buildCancelListing`, `buildCancelAndRedeem`, `buildStressPeg` (testnet), and for Morpho lines `buildSupplyCollateral`, `buildBorrow`, `buildRepayMorpho`, `buildWithdrawCollateral`, `buildLiquidateMorpho`. The builders are also exported as plain functions taking a deployment.

## Deployments

Addresses come from `contracts/deployments/<chainId>.json` (schema version 2) and the earlier deployments kept in `contracts/deployments/v<N>/` (v1). `pnpm build` copies both into `src/deployments/chains/` and bundles them. `getDeployment(chainId)` returns the current deployment, or the newest archived one while a chain has none yet; `getDeployment(chainId, { version: 1 })` and `getDeployments(chainId)` reach the archived ones, whose proof transactions keep resolving. It returns `undefined` for a chain without any. Reads pick the right VeBTCCreditLine ABI per deployment (`veBTCCreditLineAbiFor`). `src/deployments/example.31611.json` shows the v1 schema with zero addresses and `example.v2.31611.json` the v2 schema (a testnet dry run with placeholder addresses).

## ABIs

`src/abis/*.ts` are generated from the Foundry artifacts and committed, so the package builds without Foundry. After changing contracts:

```sh
cd contracts && forge build
pnpm --filter @surety/sdk gen:abis
```

veBTC, ERC-20 and Mezo's vote-reward ABIs are hand-written in `src/abis/veBTC.ts`, `src/abis/erc20.ts` and `src/abis/mezo.ts`. `src/abis/veBTCCreditLineV1.ts` is the v1 line's ABI, kept for the v1 deployments.

## Testing helpers

`@surety/sdk/testing` exports a mocked chain (`createMockChain`, a viem `custom` transport that answers `eth_call`, Multicall3 and `eth_getLogs` from mocked contracts) and `createSuretyFixture()`, a two-line Surety system used by the tests of this package, the keeper and the MCP server. `createSuretyFixture({ version: 2 })` adds the peg, savings, ShareMarket, Sponsor and Mezo's vote-reward contracts.

## Scripts

```sh
pnpm --filter @surety/sdk build      # sync deployments, bundle with tsup
pnpm --filter @surety/sdk test       # vitest
pnpm --filter @surety/sdk typecheck
```
