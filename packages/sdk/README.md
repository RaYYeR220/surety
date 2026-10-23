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
| `getVault()` | TVL, share price, idle MUSD, fees, estimated depositor APY |
| `getBallot(tokenId)` | stored ballot, whether it counts this epoch or can be poked, power at epoch start |
| `getVeBTCPositions(owner)` | owned NFTs and NFTs in the owner's Surety loans: lock, power at epoch start, max borrow |
| `getCohorts(tokenId)` | the NFT's reward cohorts per line and epoch: claimable, maturing, at risk |
| `getLoans(borrower)` | loans found from `Opened` logs (10 000-block windows), with debt, LTV, maturity, liquidation price |
| `getLoan(loanId)`, `listLoans({ states })`, `getAuctions()` | loan views by id or state; auctions carry the live Dutch price |
| `quoteVeBTCBorrow(tokenId, amount?)` | max borrow, LTV, maturity, rate before and after, reasons an NFT is ineligible |

Amounts are `bigint` in token units (18 decimals). Shares and APYs are plain numbers (0.05 = 5%). APYs are estimates: Morpho lines use the AdaptiveCurveIrm `borrowRateView` (or the curve at the stored rate at target if that view is unavailable); the veBTC line uses its LinearKinkIrm at the current utilisation.

## Transaction builders

Each builder returns `{ to, data, value }` for the user's wallet to send: `buildVote`, `buildPoke`, `buildDeposit`, `buildWithdraw`, `buildRedeem`, `buildApprove`, `buildApproveVeBTC`, `buildOpenLoan` (veBTC approve + open), `buildBorrowMore`, `buildRepay`, `buildExtend`, `buildAddCollateral`, `buildPostIncentive`, `buildRefundIncentive`, `buildStartAuction`, `buildBid`, `buildRebalance`, `buildCheckpoint`, `buildCover`, `buildClaim`, and for Morpho lines `buildSupplyCollateral`, `buildBorrow`, `buildRepayMorpho`, `buildWithdrawCollateral`, `buildLiquidateMorpho`. The builders are also exported as plain functions taking a deployment.

## Deployments

Addresses come from `contracts/deployments/<chainId>.json`. `pnpm build` copies those files into `src/deployments/chains/` and bundles them; `getDeployment(chainId)` returns `undefined` for a chain without one. `src/deployments/example.31611.json` shows the schema with zero addresses.

## ABIs

`src/abis/*.ts` are generated from the Foundry artifacts and committed, so the package builds without Foundry. After changing contracts:

```sh
cd contracts && forge build
pnpm --filter @surety/sdk gen:abis
```

veBTC and ERC-20 ABIs are hand-written in `src/abis/veBTC.ts` and `src/abis/erc20.ts`.

## Testing helpers

`@surety/sdk/testing` exports a mocked chain (`createMockChain`, a viem `custom` transport that answers `eth_call`, Multicall3 and `eth_getLogs` from mocked contracts) and `createSuretyFixture()`, a two-line Surety system used by the tests of this package, the keeper and the MCP server.

## Scripts

```sh
pnpm --filter @surety/sdk build      # sync deployments, bundle with tsup
pnpm --filter @surety/sdk test       # vitest
pnpm --filter @surety/sdk typecheck
```
