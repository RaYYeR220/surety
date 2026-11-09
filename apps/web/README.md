# Surety web app

Next.js static export (`out/`) plus one serverless function, `POST /api/starter`. Live at
[surety-credit.vercel.app](https://surety-credit.vercel.app).

## Commands

```sh
pnpm --filter web dev          # SDK build, snapshot if missing, next dev
pnpm --filter web build        # SDK, snapshot, next build, prefetch fix, function bundle
pnpm --filter web test         # starter-kit handler and RPC retry tests (node --test, no network)
pnpm --filter web check:load   # headless Chrome load check against out/ (or --url https://…)
pnpm --filter web stage        # assemble the Vercel upload folder
pnpm --filter web lint
pnpm --filter web typecheck
```

## How a page loads

- `scripts/snapshot.ts` reads both chains through the SDK at build time (board, reserve, line parameters, peg,
  proof transactions, and the users ledger) into `.snapshot/snapshot.json`. The static pages render it with an
  "as of" time, so first paint never waits on an RPC. A chain that cannot be read keeps its previous entry.
- Live reads replace the snapshot as they arrive: `lib/rpc.ts` gives every request a 4 s timeout and falls back
  across the public RPCs of each chain; testnet calls the node answers with -32603 are retried. Polling pauses
  while the tab is hidden.
- `scripts/fix-export.ts` puts the router's segment prefetch files where the client asks for them (the export
  nests them on Windows, which made every `<Link>` prefetch 404).

## Wallets

- Injected wallets (EIP-6963), always.
- WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set **at build time** (the site is static).
- Mezo Passport's Bitcoin wallets (Unisat, OKX, Xverse), loaded in their own chunk from the wallet dialog.
- A testnet key kept in the browser (`lib/burner.ts`), used by `/app/try`.

## Deploy

```sh
pnpm --filter web build
pnpm --filter web stage                     # writes apps/web/.deploy/surety-credit/
cd apps/web/.deploy/surety-credit
vercel link --yes --project surety-credit --scope rayyer220s-projects   # first time only
vercel deploy --prod --yes --scope rayyer220s-projects
```

The staged folder:

```
surety-credit/
  index.html, app/, _next/, …   everything in out/
  api/starter.js                the starter-kit function (self-contained CommonJS, Node runtime)
  vercel.json                   {"cleanUrls": true, "functions": {"api/starter.js": {"maxDuration": 30}}}
  .vercel/                      project link, kept between stagings
```

The function reads `RELAYER_PRIVATE_KEY` (the testnet relayer the Sponsor allows) from the Vercel environment.
Set it once, before deploying, from the folder linked to the project; the value is read from stdin and never
printed:

```sh
printf '%s' "<relayer key>" | vercel env add RELAYER_PRIVATE_KEY production --scope rayyer220s-projects
```

Without it, `/api/starter` answers that the service is not configured; without a Sponsor in the testnet
deployment, that kits open with the next deployment.
