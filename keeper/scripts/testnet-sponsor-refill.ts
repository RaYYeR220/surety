/**
 * Refills the starter-kit Sponsor on Mezo testnet (31611), so visitors to the app's "Try it" page can keep claiming
 * kits: BTC for gas, a veBTC lock to borrow against, and test MUSD to lend.
 *
 *   read   the Sponsor's kit, kits left, today's kits against the daily limit, its balances and the relayer's gas
 *   swap   when the sender's MUSD cannot cover the top-up: --swap-btc of BTC for MUSD on Mezo's Tigris router
 *          (BTC/MUSD volatile pool), at most --slippage-bps under the router's quote
 *   kit    setKit, when --gas, --lock, --musd or --days differ from the kit on chain
 *   fund   the BTC and MUSD the Sponsor lacks for --kits kits; the sender keeps at least --keep-btc for gas
 *
 * The sender is the Sponsor's owner. The keeper sends from the same address, so every send waits until the keeper is
 * idle. Amounts are worked out from the balances on chain: a re-run sends only what is still missing, and nothing is
 * sent unless the whole refill fits the sender's balances. Every transaction is recorded in the deployment file under
 * `proof.txs`.
 *
 * Build and run from the repo root:
 *
 *   pnpm --filter @surety/keeper build:scripts
 *   node keeper/dist/scripts/testnet-sponsor-refill.js --env-file /path/outside/repo/.env --kits 30 \
 *     [--musd 30] [--swap-btc 0.01] [--dry-run]
 */
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { erc20Abi, sponsorAbi } from "@surety/sdk";
import { formatUnits, getAddress, parseAbi, parseEventLogs, parseUnits, type Address } from "viem";

import {
  BPS,
  CHAIN_ID,
  chainNow,
  ensureAllowance,
  musd,
  openContext,
  rd,
  runMain,
  say,
  send,
  type Ctx,
} from "./lib/testnet.js";

/** Mezo testnet's Tigris (Velodrome v2) router. Its default factory holds the BTC/MUSD volatile pool. */
const TIGRIS_ROUTER: Address = "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9";
const routerAbi = parseAbi([
  "struct Route { address from; address to; bool stable; address factory; }",
  "function defaultFactory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

/** The v2 testnet deployment, where the Sponsor lives, resolved from keeper/dist/scripts. */
const DEPLOYMENT = fileURLToPath(new URL("../../../contracts/deployments/31611.json", import.meta.url));
const DAY = 86_400n;
/** The Executor's fallback gas limit: a ceiling on what one kit costs the relayer. */
const KIT_GAS_CEILING = 3_000_000n;
/** Gas set aside for this run's own sends (approve, swap, setKit, two transfers), at the fallback limit each. */
const RUN_GAS = 5n * 3_000_000n;
const SWAP_DEADLINE = 600n;

const btc = (x: bigint) => `${formatUnits(x, 18)} BTC`;
const pos = (x: bigint) => (x > 0n ? x : 0n);

interface Kit {
  btcGas: bigint;
  lockAmount: bigint;
  musd: bigint;
  lockDuration: bigint;
}

interface SponsorState {
  kit: Kit;
  kitsLeft: bigint;
  kitsIssued: bigint;
  kitsToday: bigint;
  dailyLimit: bigint;
  btc: bigint;
  musd: bigint;
}

const kitText = (k: Kit) =>
  `${btc(k.btcGas)} for gas, ${btc(k.lockAmount)} veBTC lock, ${musd(k.musd)}, ${Number(k.lockDuration) / 86_400} days`;

async function readSponsor(c: Ctx, sponsor: Address): Promise<SponsorState> {
  const read = (fn: string, args: readonly unknown[] = []) => rd<bigint>(c, sponsor, sponsorAbi, fn, args);
  const day = (await chainNow(c)) / DAY;
  const [btcGas, lockAmount, musdAmount, lockDuration, kitsLeft, kitsIssued, kitsToday, dailyLimit, btcBal, musdBal] =
    await Promise.all([
      read("btcGas"),
      read("lockAmount"),
      read("musdAmount"),
      read("lockDuration"),
      read("kitsLeft"),
      read("kitsIssued"),
      read("kitsOnDay", [day]),
      read("dailyLimit"),
      rd<bigint>(c, c.d.external.btc, erc20Abi, "balanceOf", [sponsor]),
      rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [sponsor]),
    ]);
  return {
    kit: { btcGas, lockAmount, musd: musdAmount, lockDuration },
    kitsLeft,
    kitsIssued,
    kitsToday,
    dailyLimit,
    btc: btcBal,
    musd: musdBal,
  };
}

function showSponsor(s: SponsorState): void {
  say(`    kit         ${kitText(s.kit)}`);
  say(`    kits left   ${s.kitsLeft} (${s.kitsIssued} handed out so far, ${s.kitsToday} of ${s.dailyLimit} today)`);
  say(`    holds       ${btc(s.btc)}, ${musd(s.musd)}`);
}

async function senderBalances(c: Ctx): Promise<{ btc: bigint; musd: bigint }> {
  const [b, m] = await Promise.all([
    c.pc.getBalance({ address: c.me }),
    rd<bigint>(c, c.d.external.musd, erc20Abi, "balanceOf", [c.me]),
  ]);
  return { btc: b, musd: m };
}

/** BTC and MUSD the Sponsor lacks for `kits` kits of `kit`. */
function shortfall(s: SponsorState, kit: Kit, kits: bigint): { btc: bigint; musd: bigint } {
  return { btc: pos(kits * (kit.btcGas + kit.lockAmount) - s.btc), musd: pos(kits * kit.musd - s.musd) };
}

/* Main */

const USAGE = `Usage: node keeper/dist/scripts/testnet-sponsor-refill.js [options]

Tops up the starter-kit Sponsor until it holds --kits kits for wallets that claim one on the app's "Try it" page,
swapping BTC for MUSD on Tigris first when the sender's MUSD falls short. Testnet (${CHAIN_ID}) only.

Options:
  --env-file <path>       .env file holding DEPLOYER_PRIVATE_KEY, the Sponsor's owner (keep it outside the repository)
  --deployment <path>     deployment JSON to read and record proof into (default contracts/deployments/31611.json)
  --rpc <url>             RPC URL (default https://rpc.test.mezo.org)
  --kits <n>              kits the Sponsor should hold after the refill (required)
  --gas <btc>             BTC each kit sends for gas (default: the kit on chain)
  --lock <btc>            BTC each kit locks in veBTC (default: the kit on chain)
  --musd <musd>           MUSD each kit sends (default: the kit on chain)
  --days <n>              veBTC lock length asked for, in days (default: the kit on chain)
  --swap-btc <btc>        BTC to swap for MUSD when the sender's MUSD cannot cover the top-up (default 0: no swap)
  --slippage-bps <bps>    lowest swap output accepted, in bps under the router's quote (default 300)
  --keep-btc <btc>        BTC the sender keeps for the keeper's gas (default 0.005)
  --dry-run               print the plan, send nothing
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      deployment: { type: "string" },
      rpc: { type: "string" },
      kits: { type: "string" },
      gas: { type: "string" },
      lock: { type: "string" },
      musd: { type: "string" },
      days: { type: "string" },
      "swap-btc": { type: "string", default: "0" },
      "slippage-bps": { type: "string", default: "300" },
      "keep-btc": { type: "string", default: "0.005" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!values.kits || !/^[1-9]\d*$/.test(values.kits)) throw new Error("--kits must be a whole number above 0");
  if (values.days !== undefined && !/^[1-9]\d*$/.test(values.days)) throw new Error("--days must be a whole number");
  const kits = BigInt(values.kits);
  const swapBtc = parseUnits(values["swap-btc"], 18);
  const slippage = BigInt(values["slippage-bps"]);
  if (slippage < 0n || slippage >= BPS) throw new Error("--slippage-bps must be under 10000");
  const keepBtc = parseUnits(values["keep-btc"], 18);

  const c = openContext({
    envFile: values["env-file"],
    deployment: values.deployment ?? DEPLOYMENT,
    rpc: values.rpc,
    dryRun: values["dry-run"],
    quiet: true,
    logFields: { script: "sponsor-refill" },
  });
  const chainId = await c.pc.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`the RPC serves chain ${chainId}, not Mezo testnet ${CHAIN_ID}`);
  const sponsor = c.d.contracts.sponsor;
  if (!sponsor) throw new Error(`${c.deploymentPath} has no Sponsor (contracts.sponsor)`);
  const owner = await rd<Address>(c, sponsor, sponsorAbi, "owner");
  if (getAddress(owner) !== getAddress(c.me)) throw new Error(`the Sponsor's owner is ${owner}, not the sender ${c.me}`);

  say(`Surety starter-kit refill: chain ${CHAIN_ID}, Sponsor ${sponsor}, sender ${c.me}${c.dryRun ? " (dry run)" : ""}`);
  say(`  proof file ${c.deploymentPath}`);

  const before = await readSponsor(c, sponsor);
  const gasPrice = await c.pc.getGasPrice();
  say("== before");
  showSponsor(before);
  const relayer = c.d.sponsorKit?.relayer;
  if (relayer) {
    const [allowed, gasBal] = await Promise.all([
      rd<boolean>(c, sponsor, sponsorAbi, "isRelayer", [relayer]),
      c.pc.getBalance({ address: relayer }),
    ]);
    const perKit = KIT_GAS_CEILING * gasPrice;
    const covers = perKit === 0n ? "any number of" : `${gasBal / perKit}`;
    say(`    relayer     ${relayer} ${allowed ? "allowed" : "NOT ALLOWED"}, ${btc(gasBal)} (gas for ${covers} kits)`);
    if (!allowed) say("  ! the relayer is not allowed on the Sponsor: kits cannot be claimed until setRelayer");
    if (gasBal < kits * perKit) say(`  ! the relayer cannot pay gas for ${kits} kits: send it BTC`);
  }

  // The plan, checked against the sender's balances before anything is sent.
  const kit: Kit = {
    btcGas: values.gas === undefined ? before.kit.btcGas : parseUnits(values.gas, 18),
    lockAmount: values.lock === undefined ? before.kit.lockAmount : parseUnits(values.lock, 18),
    musd: values.musd === undefined ? before.kit.musd : parseUnits(values.musd, 18),
    lockDuration: values.days === undefined ? before.kit.lockDuration : BigInt(values.days) * DAY,
  };
  const kitChanges = (Object.keys(kit) as (keyof Kit)[]).some((k) => kit[k] !== before.kit[k]);
  const need = shortfall(before, kit, kits);
  const sender = await senderBalances(c);
  const swapIn = sender.musd < need.musd ? swapBtc : 0n;
  if (sender.musd < need.musd && swapIn === 0n) {
    throw new Error(`the sender holds ${musd(sender.musd)} and the refill needs ${musd(need.musd)}: pass --swap-btc`);
  }
  let route: { from: Address; to: Address; stable: boolean; factory: Address }[] = [];
  let quote = 0n;
  let minOut = 0n;
  if (swapIn > 0n) {
    const factory = await rd<Address>(c, TIGRIS_ROUTER, routerAbi, "defaultFactory");
    route = [{ from: c.d.external.btc, to: c.d.external.musd, stable: false, factory }];
    quote = (await rd<readonly bigint[]>(c, TIGRIS_ROUTER, routerAbi, "getAmountsOut", [swapIn, route])).at(-1)!;
    minOut = (quote * (BPS - slippage)) / BPS;
    if (sender.musd + minOut < need.musd) {
      throw new Error(
        `${btc(swapIn)} buys about ${musd(quote)} on Tigris, short of the ${musd(need.musd - sender.musd)} ` +
          "the refill still needs: raise --swap-btc",
      );
    }
  }
  const runGas = RUN_GAS * gasPrice;
  const senderLeft = sender.btc - swapIn - need.btc - runGas;
  if (senderLeft < keepBtc) {
    throw new Error(
      `the refill needs ${btc(swapIn + need.btc)} and would leave the sender ${btc(pos(senderLeft))}, ` +
        `under --keep-btc ${btc(keepBtc)}`,
    );
  }

  say("== plan");
  say(`    sender      ${btc(sender.btc)}, ${musd(sender.musd)}`);
  if (swapIn > 0n) say(`    swap        ${btc(swapIn)} for about ${musd(quote)} on Tigris (at least ${musd(minOut)})`);
  say(`    kit         ${kitChanges ? `set to ${kitText(kit)}` : "unchanged"}`);
  say(`    fund        ${btc(need.btc)} and ${musd(need.musd)}, for ${kits} kits`);
  say(`    sender then about ${btc(senderLeft)} (keeps at least ${btc(keepBtc)} for gas)`);
  if (before.dailyLimit - before.kitsToday < kits) {
    const today = pos(before.dailyLimit - before.kitsToday);
    say(`  ! the daily limit lets ${today} more kits out today, then ${before.dailyLimit} a day`);
  }
  if (c.dryRun) {
    say("  dry run: nothing sent");
    return;
  }

  say("== send");
  if (swapIn > 0n) {
    const approveLabel = `sponsor refill: approve ${btc(swapIn)} to the Tigris router`;
    await ensureAllowance(c, c.d.external.btc, TIGRIS_ROUTER, swapIn, approveLabel);
    const deadline = (await chainNow(c)) + SWAP_DEADLINE;
    const swapLabel = `sponsor refill: swap ${btc(swapIn)} for MUSD on Tigris (at least ${musd(minOut)})`;
    const swapped = await send(c, swapLabel, {
      address: TIGRIS_ROUTER,
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [swapIn, minOut, route, c.me, deadline],
    });
    if (swapped) {
      const got = parseEventLogs({ abi: erc20Abi, logs: swapped.receipt.logs, eventName: "Transfer" })
        .filter((e) => getAddress(e.address) === getAddress(c.d.external.musd))
        .filter((e) => getAddress(e.args.to) === getAddress(c.me))
        .reduce((s, e) => s + e.args.value, 0n);
      say(`      received ${musd(got)} (quoted ${musd(quote)})`);
    }
  }

  if (kitChanges) {
    await send(c, `sponsor: kit set to ${kitText(kit)}`, {
      address: sponsor,
      abi: sponsorAbi,
      functionName: "setKit",
      args: [kit.btcGas, kit.lockAmount, kit.musd, kit.lockDuration],
    });
  }

  // Worked out again from the balances now, in case a visitor claimed a kit while this ran.
  const top = shortfall(await readSponsor(c, sponsor), kit, kits);
  const now = await senderBalances(c);
  if (now.musd < top.musd) throw new Error(`the sender holds ${musd(now.musd)}, the top-up needs ${musd(top.musd)}`);
  if (now.btc - top.btc - runGas < keepBtc) {
    throw new Error(`sending ${btc(top.btc)} would leave the sender under --keep-btc ${btc(keepBtc)}`);
  }
  if (top.btc > 0n) {
    await send(c, `fund sponsor: ${btc(top.btc)} for ${kits} starter kits`, {
      address: c.d.external.btc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [sponsor, top.btc],
    });
  }
  if (top.musd > 0n) {
    await send(c, `fund sponsor: ${musd(top.musd)} for ${kits} starter kits`, {
      address: c.d.external.musd,
      abi: erc20Abi,
      functionName: "transfer",
      args: [sponsor, top.musd],
    });
  }

  const after = await readSponsor(c, sponsor);
  const left = await senderBalances(c);
  say("== after");
  showSponsor(after);
  say(`    sender      ${btc(left.btc)}, ${musd(left.musd)}`);
  if (after.kitsLeft < kits) throw new Error(`the Sponsor holds ${after.kitsLeft} kits, under the ${kits} asked for`);
}

runMain(main);
