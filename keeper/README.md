# @surety/keeper

Permissionless keeper for Surety on Mezo. Every call it makes is open to anyone; it holds no admin role and only pays gas.

## What it does

Each pass reads a snapshot of the chain and decides, in this order:

1. **Auctions**: `startAuction(loanId)` for every active veBTC loan at or past the liquidation LTV, or past its lock end.
2. **Losses**: for each line, simulates `checkpoint(lineId)` to see whether a new loss would be recorded. When a line has a recorded or pending loss and the pool has cover capacity (and the vault has idle MUSD, counting what is parked in sMUSD), it sends `cover(lineId)`, which checkpoints first; a cover the simulation shows would pay nothing is skipped. Otherwise it sends `checkpoint(lineId)` alone, so the loss is recorded. Morpho lines are also checkpointed when SuretyPool has no supply-price high-water mark for them yet (a loss before the first checkpoint would go unmeasured) and right before each rebalance, which ratchets the mark up with interest once per epoch.
3. **Pokes**: `poke(tokenId)` for every ballot (token ids collected from `Voted` logs) still stored in an earlier epoch, skipping burned, escrowed and powerless NFTs. Pokes start one second after the flip, when the veBTC snapshot is final.
4. **Peg pool syncs** (v2 mainnet): `sync()` on each basic pool behind the MUSD peg's StableTwap sources (sAMM mUSDC/MUSD `0xEd81…c356` and sAMM MUSD/mUSDT `0x1090…031A`) once its latest observation is about 50 minutes old, at most hourly per pool. Those sources read only while the pool's latest observation is under 6 hours old, and the pools observe only when someone trades or syncs (organically every few hours to days); hourly syncs keep both sources reading, which kept the peg breaker open in every sample of the measured period. Testnet has no peg pools, so nothing is synced there. A sync uses about 154k gas (it stores the new observation), so hourly syncs of both pools come to about 7.4M gas a day; `--pool-sync-interval` lengthens the interval (anything under the sources' 6-hour limit keeps them reading, with a longer window for a quiet pool to hide a move) or turns syncs off with 0.
5. **Rebalance**: `rebalance()` once per epoch, at least 5 seconds after the flip. Never skip a flip: besides moving capital to the new tally, the rebalance refills the veBTC line after anyone drains its cash with VaultV2's permissionless `forceDeallocate`, which leaves its utilisation at 100% (every borrower at the IRM's max APR, no new loans) until then. A rebalance is permissionless and safe to repeat, so an operator may also run it mid-epoch when the line's cash falls well below its target.
6. **Savings** (v2): right after the epoch's rebalance, `harvest()` on the savings adapter when it has sMUSD yield to claim, which parks the yield again.
7. **Auto-repay harvests** (v2): `harvest(loanId, rewards, tokens)` for every veBTC loan with auto-repay on, once per Mezo epoch (weeks from Thursday 00:00 UTC), as soon as the escrowed NFT has fees, bribes or a rebase to claim. The reward contracts and tokens come from the NFT's PoolsVoter votes: each voted pool's gauge, its fee and bribe contracts, and the tokens each has earned for the NFT. MUSD repays the loan; other tokens go to the borrower.
8. **Morpho backstop** (off by default): liquidates unhealthy positions in the Morpho lines' markets, found from `Borrow` logs. The keeper account needs MUSD and a MUSD approval to Morpho for this.

Every action is simulated first; a simulated revert is logged and not sent. Gas limit is the estimate plus 30%: Mezo's gas estimates can come in low (a veBTC lock estimated at ~424k used 551k), and Mezo charges at least half of the gas limit, so the buffer stays modest. Before sending, the call is simulated again at that limit; if it fails there, the keeper retries the simulation at a 3,000,000 fallback and sends only if it passes. On v2 the heaviest calls read the MUSD peg: a rebalance with savings uses about 1.25M gas (limit about 1.63M) and a veBTC loan opening about 980k, both well under the fallback and Mezo's 10M block. RPC reads retry with exponential backoff; a failed pass backs off before the next one. Between passes the keeper sleeps for the interval, waking early to land just after the next epoch flip.

## Run

```sh
pnpm install && pnpm -r build
KEEPER_PRIVATE_KEY=0x... pnpm keeper --chain 31611
pnpm keeper --chain 31611 --dry-run --once     # simulate one pass, send nothing
```

| Flag | Default | |
| --- | --- | --- |
| `--chain <id>` | required | 31611 (testnet) or 31612 (mainnet) |
| `--dry-run` | off | simulate only; no key needed |
| `--once` | off | one pass, then exit |
| `--interval <s>` | 60 testnet, 600 mainnet | time between passes |
| `--flip-delay <s>` | 5 | wait after the flip before `rebalance` |
| `--rpc <url>` | chain defaults | repeatable or comma-separated; tried in order |
| `--deployment <path>` | bundled | deployment JSON to use instead of the one in `@surety/sdk` |
| `--morpho-liquidations` | off | enable the Morpho backstop |
| `--pool-sync-interval <s>` | 3600 | least time between syncs of one peg pool; 0 turns them off |
| `--log-level <level>` | info | debug, info, warn, error |

| Environment | |
| --- | --- |
| `KEEPER_PRIVATE_KEY` | sending account; required unless `--dry-run`. Never logged: every log line is scrubbed of it. |
| `KEEPER_ADDRESS` | simulation sender in `--dry-run` without a key |
| `KEEPER_RPC_URL` | RPC URL(s), comma-separated |

Keep the key in an `.env` file outside the repository (or your secret store), never in the repo, and load it with Node's env-file flag:

```sh
node --env-file=/path/outside/repo/.env keeper/dist/cli.js --chain 31611
```

## Logs

One JSON object per line on stdout (warnings and errors on stderr): `ts`, `level`, `msg`, `chainId` and the action's fields. A pass logs `tick` with the epoch, seconds to the flip and the planned actions; each sent transaction logs `sent` and `mined` with hash, gas limit and gas used.

## Tests

```sh
pnpm --filter @surety/keeper test
```

The decision logic (`src/decide.ts`) is pure and tested over hand-built snapshots; the snapshot reader and a full pass are tested against the SDK's mocked chain.
