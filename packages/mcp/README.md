# @surety/mcp

An MCP server that lets agents read Surety on Mezo and prepare transactions for it. It reads the chain through `@surety/sdk` and returns unsigned calldata; it holds no keys and never signs or sends.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `surety_board` | none | vault TVL, share price, idle MUSD and estimated APY; per line: vote share (this and last epoch), allocation, target, utilisation, supply and borrow APY, incentives, cover capacity, uncovered loss |
| `surety_epoch` | none | epoch start, next flip, seconds to flip, active tally epoch, last rebalance, whether a rebalance is due |
| `surety_quote_vebtc_borrow` | `tokenId`, optional `amount` (MUSD) | eligibility and reasons, collateral value, max LTV, max borrow, LTV and BTC liquidation price, maturity, borrow APR before and after |
| `surety_loan_health` | `loanId`, or `borrower`, or nothing (all auctions) | debt, LTV against max and liquidation LTV, liquidation price, maturity, whether it can be auctioned, live auction price |
| `surety_cohorts` | `tokenId` | the NFT's reward cohorts (claimable, maturing, at risk) and its current ballot |
| `surety_build_tx` | `action`, `params` | unsigned transactions to send in order, with token approvals first |

Inputs are validated with zod; amounts are decimal strings in token units (MUSD, BTC and srMUSD use 18 decimals), ids are decimal strings. Outputs are compact JSON with amounts in MUSD and rates in percent.

`surety_build_tx` actions: `vote`, `poke`, `deposit`, `withdraw`, `redeem`, `approve`, `open_loan`, `borrow_more`, `repay`, `extend`, `add_collateral`, `post_incentive`, `start_auction`, `bid`, `rebalance`, `checkpoint`, `cover`, `claim`, `supply_collateral`, `borrow_morpho`, `repay_morpho`. Example:

```json
{ "action": "repay", "params": { "loanId": "3", "amount": "250" } }
```

returns a MUSD approve to the veBTC line followed by `repay(3, 250e18)`. Pass `"includeApproval": false` to skip the approve.

## Run

```sh
pnpm install && pnpm -r build
pnpm mcp                          # stdio, testnet
pnpm mcp --http --port 3333       # streamable HTTP at http://127.0.0.1:3333/mcp
```

Any MCP client that launches stdio servers takes the same command, for example in a JSON client config:

```json
{
  "mcpServers": {
    "surety": { "command": "node", "args": ["/path/to/surety/packages/mcp/dist/cli.js", "--chain", "31611"] }
  }
}
```

The HTTP server is stateless: each POST to `/mcp` gets its own server instance, so it scales horizontally and needs no sessions. `GET /healthz` returns 200.

| Option / env | Default | |
| --- | --- | --- |
| `--chain` / `SURETY_CHAIN_ID` | 31611 | 31611 testnet or 31612 mainnet |
| `--rpc` / `SURETY_RPC_URL` | chain defaults | RPC URL(s), comma-separated, tried in order |
| `--deployment` / `SURETY_DEPLOYMENT` | bundled | deployment JSON to use instead of the one in `@surety/sdk` |
| `--http` | off | serve streamable HTTP instead of stdio |
| `--port` / `PORT` | 3333 | HTTP port |
| `--host` / `HOST` | 127.0.0.1 | HTTP bind address |

## Tests

```sh
pnpm --filter @surety/mcp test
```

The tests connect an MCP client over an in-memory transport and over HTTP, list the tools, and call each one against the SDK's mocked chain.
