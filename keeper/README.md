# @surety/keeper

Permissionless keeper for Surety on Mezo. Every call it makes is open to anyone; it holds no admin role and only pays gas.

## What it does

Each pass reads a snapshot of the chain and decides, in this order:

1. **Auctions**: `startAuction(loanId)` for every active veBTC loan at or past the liquidation LTV, or past its lock end.
2. **Losses**: for each line, simulates `checkpoint(lineId)` to see whether a new loss would be recorded. When a line has a recorded or pending loss and the pool has cover capacity (and the vault has idle MUSD), it sends `cover(lineId)`, which checkpoints first; a cover the simulation shows would pay nothing is skipped. Otherwise it sends `checkpoint(lineId)` alone, so the loss is recorded. Morpho lines are also checkpointed when SuretyPool has no supply-price high-water mark for them yet (a loss before the first checkpoint would go unmeasured) and right before each rebalance, which ratchets the mark up with interest once per epoch.
3. **Pokes**: `poke(tokenId)` for every ballot (token ids collected from `Voted` logs) still stored in an earlier epoch, skipping burned, escrowed and powerless NFTs. Pokes start one second after the flip, when the veBTC snapshot is final.
4. **Rebalance**: `rebalance()` once per epoch, at least 5 seconds after the flip.
5. **Morpho backstop** (off by default): liquidates unhealthy positions in the Morpho lines' markets, found from `Borrow` logs. The keeper account needs MUSD and a MUSD approval to Morpho for this.

Every action is simulated first; a simulated revert is logged and not sent. Gas limit is the estimate plus 15% (Mezo charges at least half of the gas limit, so limits are kept tight). RPC reads retry with exponential backoff; a failed pass backs off before the next one. Between passes the keeper sleeps for the interval, waking early to land just after the next epoch flip.

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
