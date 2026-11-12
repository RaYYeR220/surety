#!/usr/bin/env node
// Renders the proof blocks of the docs from the deployment files as Markdown: the live lifecycles from a testnet
// file's `proof.txs`, the v1 run (written by keeper/scripts/testnet-cycle.ts) and the v2 run
// (keeper/scripts/testnet-cycle-v2.ts), and for the v2 mainnet deployment its contracts with their Sourcify links
// and the transactions that put real MUSD through it.
//
//   node docs/proof-table.mjs                     print the v1 and v2 lifecycle blocks for
//                                                 contracts/deployments/v1/31611.json and
//                                                 contracts/deployments/31611.json, and the v2 mainnet contracts and
//                                                 transactions of contracts/deployments/31612.json
//   node docs/proof-table.mjs <deployment.json>   print the blocks for one deployment file (v1 or v2 by its schema;
//                                                 a v2 mainnet file renders its contracts and transactions)
//   node docs/proof-table.mjs --write             also replace the rendered blocks in README.md and docs/PROOF.md
//
// Every expected step that is not in a file yet is rendered as a PENDING row, so the tables show what is still
// missing instead of silently leaving it out. A transaction sent to be refused on chain (`status: "reverted"`) is
// shown with its reason.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPLORERS = { 31611: "https://explorer.test.mezo.org", 31612: "https://explorer.mezo.org" };
const SOURCIFY = "https://repo.sourcify.dev";
const MAINNET = 31612;
const V1_FILE = join(ROOT, "contracts/deployments/v1/31611.json");
const V2_FILE = join(ROOT, "contracts/deployments/31611.json");
const MAINNET_FILE = join(ROOT, "contracts/deployments/31612.json");

/* v1: steps of testnet-cycle.ts in order */

// `match` is a label prefix; `optional` steps (approvals) are skipped by the script when an allowance already
// exists, so they get no PENDING row.
const STEPS = [
  ["setup", "approve 1,000 MUSD to vault", { optional: true }],
  ["setup", "deposit 1,000 MUSD"],
  ["setup", "vote #1711 "],
  ["setup", "vote #1712 "],
  ["setup", "rebalance (bootstrap)"],
  ["setup", "approve 250 MUSD to SuretyPool", { optional: true }],
  ["setup", "incentive 100 MUSD to line 0"],
  ["setup", "incentive 150 MUSD to line 1"],
  ["setup", "approve veBTC #1712 to credit line", { optional: true }],
  ["setup", "veBTC loan opened #1712"],
  ["setup", "approve 0.004 BTC to Morpho", { optional: true }],
  ["setup", "Morpho supplyCollateral"],
  ["setup", "Morpho borrow "],
  ["stress", "checkpoint Morpho line (pre-shock high-water mark)"],
  ["stress", "shock "],
  ["stress", "approve MUSD to Morpho (liquidation)", { optional: true }],
  ["stress", "Morpho liquidation with bad debt", { key: "Morpho liquidation leaves bad debt" }],
  ["stress", "veBTC auction started"],
  ["stress", "approve MUSD to credit line (bid)", { optional: true }],
  ["stress", "veBTC auction bid at floor", { key: "veBTC auction settles below the debt (shortfall)" }],
  ["settle", "checkpoint Morpho line (loss recorded)", { key: "Loss recorded on the Morpho line" }],
  ["settle", "checkpoint veBTC line (loss recorded)", { key: "Loss recorded on the veBTC line" }],
  ["settle", "cover Morpho line", { key: "Cover: voter cohort slashed, MUSD returned to the vault" }],
  ["settle", "cover veBTC line", { key: "Cover: voter cohort slashed, MUSD paid into the veBTC line" }],
];
// Epoch flips after the settle: [label prefix, how a missing one is shown].
const EPOCH_STEPS = [
  ["poke #1711 (epoch", "poke #1711 into the next epoch"],
  ["poke #1712 (epoch", "poke #1712 into the next epoch"],
  ["rebalance (epoch", "first rebalance of the next epoch"],
];
const EPOCH_KEY = "Next epoch: rebalance attributes interest to the cohorts";

/* v2: phases of testnet-cycle-v2.ts */

// A transaction's phase is the first rule its label matches; an approval takes the phase of the next transaction
// that is not one. A loan harvest's label names the bribes it claims, so it is matched before the escrow phase.
const V2_PHASES = [
  ["harvest", /harvest loan/],
  ["fund", /^fund /],
  ["liquidate", /auction|shock|^bidder:/],
  ["lend", /^lender: deposit/],
  ["epoch", /^Surety keeper: (poke|rebalance)/],
  ["vote", /^voter: vote|incentive|rebalance/],
  ["peg", /peg override|refused on chain/],
  ["morpho", /Morpho/],
  ["escrow", /escrow vote|bribe/],
  ["loan", /^borrower: (veBTC lock|veBTC loan|auto-repay)/],
  ["market", /ShareMarket|^lender: (list|cancel)|^share buyer: fill/],
  ["savings", /savings harvest/],
  ["kit", /starter kit/],
];
const isApproval = (label) => /: approve /.test(label);
// Steps that must be recorded: [phase, label pattern, how a missing one is shown, key-step text].
const V2_REQUIRED = [
  ["fund", /^fund /, "fund the role accounts from the deployer"],
  ["lend", /^lender: deposit/, "lender deposit", "Lender deposit parks in sMUSD through the liquidity adapter"],
  ["vote", /^voter: vote #/, "veBTC vote on the two lines"],
  ["vote", /incentive .* to line 0/, "sponsor incentive on line 0"],
  ["vote", /incentive .* to line 1/, "sponsor incentive on line 1"],
  ["vote", /rebalance/, "rebalance", "Rebalance moves the capital from sMUSD to the lines by the votes"],
  ["loan", /^borrower: veBTC loan #\d+ opened/, "veBTC loan", "veBTC loan opened, origination fee to the treasury (`OriginationFeePaid`)"],
  ["loan", /auto-repay on/, "auto-repay on"],
  ["escrow", /escrow vote/, "escrow vote on Mezo's PoolsVoter", "The loan's escrow votes the NFT on Mezo's PoolsVoter"],
  ["escrow", /^sponsor: bribe/, "MUSD bribe on the gauge"],
  ["morpho", /Morpho borrow/, "Morpho borrow"],
  ["peg", /peg override, MUSD at/, "peg override"],
  ["peg", /refused on chain: PegUnhealthy/, "borrow refused while MUSD is off its peg", "Depeg breaker: a borrow sent while MUSD reads $0.94 reverts on chain with `PegUnhealthy`"],
  ["peg", /peg override cleared/, "peg override cleared"],
  ["liquidate", /shock −/, "price shock"],
  ["liquidate", /auction started/, "auction start"],
  ["liquidate", /auction bid/, "auction bid", "Auction bid above debt + fee: no shortfall, fee split to lenders, treasury and keeper (`LiquidationFeePaid`)"],
  ["market", /^lender: list/, "ShareMarket listing"],
  ["market", /^share buyer: fill/, "ShareMarket fill", "ShareMarket fill: a lender sells srMUSD at a discount, 10 bps to the treasury"],
  ["market", /^lender: cancel/, "cancel the rest of the listing"],
  ["kit", /starter kit/, "starter kit through the relayer", "Starter kit through the Sponsor's relayer (team test wallet)"],
  ["harvest", /harvest loan/, "harvest after the Mezo flip (Thu 2026-11-12 00:00 UTC)", "Auto-repay: the escrow's bribes and fees harvested into repayment after the Mezo flip"],
];

/* v2 mainnet: the transactions that put real MUSD through the deployment, from the team's own wallets */

// Same rules as V2_PHASES: the first match wins, an approval takes the phase of the next transaction.
const MAINNET_PHASES = [
  ["harvest", /harvest loan/],
  ["setup", /swap|veBTC lock #\d+ created/],
  ["lend", /: deposit/],
  ["vote", /: vote #/],
  ["keeper", /^Surety keeper:/],
  ["escrow", /escrow vote/],
  ["loan", /veBTC loan|auto-repay on/],
  ["morpho", /Morpho/],
];
// Mezo pays an epoch's fees and bribes after it ends, so the first harvest of a mainnet loan follows its escrow vote
// by one Mezo epoch.
const MAINNET_REQUIRED = [
  ["lend", /: deposit/, "deposit", "Real MUSD deposited into the mainnet vault, parked in Mezo's sMUSD"],
  ["vote", /: vote #/, "veBTC vote on the two lines"],
  ["keeper", /: rebalance/, "rebalance", "Rebalance by the votes: MUSD supplied to Surety's market on Mezo's Morpho Blue and lent to the veBTC line"],
  ["keeper", /savings harvest/, "savings harvest", "sMUSD yield harvested and re-deposited"],
  ["loan", /veBTC loan #\d+ opened/, "veBTC loan", "veBTC loan against a mainnet lock, origination fee to the treasury"],
  ["loan", /auto-repay on/, "auto-repay on"],
  ["escrow", /escrow vote/, "escrow vote on Mezo's PoolsVoter", "The loan's escrow votes the NFT on Mezo's PoolsVoter"],
  ["morpho", /Morpho borrow/, "Morpho borrow", "MUSD borrowed from Surety's market on Mezo's Morpho Blue"],
  ["harvest", /harvest loan/, "auto-repay harvest of loan #1 after the Mezo flip (Thu 2026-11-19 00:00 UTC)", "Auto-repay: the escrow's fees and bribes harvested into repayment after the Mezo flip"],
];

const MARKERS = {
  keys: ["<!-- proof:key-steps:start -->", "<!-- proof:key-steps:end -->"],
  table: ["<!-- proof:lifecycle:start -->", "<!-- proof:lifecycle:end -->"],
  keysV2: ["<!-- proof:key-steps-v2:start -->", "<!-- proof:key-steps-v2:end -->"],
  tableV2: ["<!-- proof:lifecycle-v2:start -->", "<!-- proof:lifecycle-v2:end -->"],
  contractsMainnet: ["<!-- proof:contracts-31612:start -->", "<!-- proof:contracts-31612:end -->"],
  keysMainnet: ["<!-- proof:key-steps-31612:start -->", "<!-- proof:key-steps-31612:end -->"],
  tableMainnet: ["<!-- proof:live-31612:start -->", "<!-- proof:live-31612:end -->"],
};

/* v2 mainnet: the contracts of the deployment file */

// Surety's contracts in the order the docs list them: [key in `contracts`, label]. A key the file has but this list
// does not is still rendered, under its own name, so a new contract never drops out of the table.
const CONTRACTS = [
  ["vault", "Surety vault (VaultV2, srMUSD)"],
  ["morphoAdapter", "MorphoMarketV1AdapterV2"],
  ["savingsAdapter", "SavingsAdapter"],
  ["creditVoter", "CreditVoter"],
  ["voteAllocator", "VoteAllocator"],
  ["suretyPool", "SuretyPool"],
  ["depositGate", "DepositGate"],
  ["veBTCLine", "VeBTCCreditLine"],
  ["loanEscrowImpl", "LoanEscrow implementation"],
  ["irmLine", "LinearKinkIrm (veBTC line)"],
  ["shareMarket", "ShareMarket"],
  ["musdPeg", "MusdPeg"],
  ["pegSources", null],
  ["btcMusdSource", "BtcMusdPriceSource (lines' price)"],
  ["btcUsdSource", "SkipPriceSource (BTC/USD)"],
  ["morphoOracle", "MorphoPriceOracle"],
];
// Not Surety's contracts (Mezo's Morpho Blue and IRM) or not a contract (the treasury key).
const EXTERNAL = { morpho: "Morpho Blue (Mezo's)", irm: "AdaptiveCurveIrm (Mezo's)" };
const NOT_CONTRACTS = new Set(["treasury"]);
const PEG_SOURCES = {
  ClTwap: "ClTwapPegSource",
  StableTwap: "StableTwapPegSource",
  BtcCross: "BtcCrossPegSource",
  Stressed: "StressedPegSource",
};
// Mezo's pools behind the mainnet peg sources.
const POOLS = {
  "0xcc372b7e15535ab225fe17c1075831d38ef7ac1a": "CL mUSDC/MUSD",
  "0xed812aec0fecc8fd882ac3eccc43f3aa80a6c356": "basic mUSDC/MUSD",
  "0x10906a9e9215939561597b4c8e4b98f93c02031a": "basic MUSD/mUSDT",
  "0x9cbc1537d255768b431488305b1c7efc2ac95022": "CL BTC/MUSD",
};

function load(path) {
  const d = JSON.parse(readFileSync(path, "utf8"));
  const explorer = EXPLORERS[d.chainId];
  if (!explorer) throw new Error(`${path}: no explorer known for chain ${d.chainId}`);
  return { d, explorer, txs: d.proof?.txs ?? [], version: d.version ?? 1 };
}

const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const link = (explorer, h) => `[${short(h)}](${explorer}/tx/${h})`;

/** v1: assigns each recorded tx to a step; returns rows in lifecycle order plus PENDING rows for missing steps. */
function planV1({ txs }) {
  const used = new Set();
  const rows = [];
  for (const [phase, match, opts = {}] of STEPS) {
    const hits = txs.filter((t) => !used.has(t.hash) && t.label.startsWith(match));
    hits.forEach((t) => used.add(t.hash));
    if (hits.length) hits.forEach((t) => rows.push({ phase, tx: t, key: opts.key }));
    else if (!opts.optional) rows.push({ phase, pending: match.trim(), key: opts.key });
  }
  // Epoch flips: pokes and rebalances recorded after the settle phase.
  const settled = Math.max(0, ...rows.filter((r) => r.phase === "settle" && r.tx).map((r) => r.tx.block));
  const flips = txs.filter(
    (t) => !used.has(t.hash) && EPOCH_STEPS.some(([m]) => t.label.startsWith(m)) && settled > 0 && t.block > settled,
  );
  flips.forEach((t) => used.add(t.hash));
  const firstRebalance = flips.find((t) => t.label.startsWith("rebalance (epoch"));
  for (const t of flips) rows.push({ phase: "epoch", tx: t, key: t === firstRebalance ? EPOCH_KEY : undefined });
  if (!firstRebalance) {
    for (const [m, missing] of EPOCH_STEPS) {
      if (!flips.some((t) => t.label.startsWith(m))) {
        rows.push({ phase: "epoch", pending: missing, key: m.startsWith("rebalance") ? EPOCH_KEY : undefined });
      }
    }
  }
  for (const t of txs) if (!used.has(t.hash)) rows.push({ phase: "other", tx: t });
  return rows;
}

/**
 * v2, testnet run or mainnet: recorded txs in the order they were sent, by phase, then PENDING rows for required
 * steps not recorded.
 */
function planV2({ txs }, rules = V2_PHASES, required = V2_REQUIRED) {
  const phaseOf = (label) => rules.find(([, re]) => re.test(label))?.[0] ?? "other";
  const phases = txs.map((t) => (isApproval(t.label) ? null : phaseOf(t.label)));
  for (let i = phases.length - 1, next = "other"; i >= 0; i--) {
    if (phases[i] === null) phases[i] = next;
    else next = phases[i];
  }
  const rows = txs.map((t, i) => ({ phase: phases[i], tx: t }));
  for (const [phase, re, missing, key] of required) {
    const row = rows.find((r) => r.tx && r.phase === phase && re.test(r.tx.label));
    if (row) {
      if (key && !row.key) row.key = key;
    } else rows.push({ phase, pending: missing, key });
  }
  return rows;
}

function stepText(r) {
  if (!r.tx) return `${r.pending} (not recorded yet)`;
  if (r.tx.status !== "reverted") return r.tx.label;
  const reason = r.tx.reason ?? "unknown";
  return r.tx.label.includes(reason) ? `${r.tx.label} [reverted on chain]` : `${r.tx.label} [reverted: ${reason}]`;
}

function renderTable(src, rows, file) {
  const done = rows.filter((r) => r.tx).length;
  const pending = rows.length - done;
  const out = [
    `Rendered by \`node docs/proof-table.mjs\` from \`${file}\`: ${done} transactions recorded, ${pending} step${pending === 1 ? "" : "s"} PENDING.`,
    "",
    "| # | Phase | Step | Transaction | Block |",
    "| --- | --- | --- | --- | --- |",
  ];
  rows.forEach((r, i) => {
    const step = stepText(r);
    const tx = r.tx ? link(src.explorer, r.tx.hash) : "PENDING";
    const block = r.tx ? String(r.tx.block) : "—";
    out.push(`| ${i + 1} | ${r.phase} | ${r.key ? `**${step}**` : step} | ${tx} | ${block} |`);
  });
  return out.join("\n");
}

function renderKeys(src, rows) {
  return rows
    .filter((r) => r.key)
    .map((r) => `- ${r.key}: ${r.tx ? link(src.explorer, r.tx.hash) : "PENDING (not recorded yet)"}`)
    .join("\n");
}

/** v2 mainnet: Surety's contracts as [label, address], once per address, in the order of CONTRACTS. */
function listContracts({ d }) {
  const seen = new Set();
  const out = [];
  const add = (label, address) => {
    if (!address || seen.has(address.toLowerCase())) return;
    seen.add(address.toLowerCase());
    out.push([label, address]);
  };
  for (const [key, label] of CONTRACTS) {
    if (key !== "pegSources") add(label, d.contracts[key]);
    else {
      for (const s of d.pegSources ?? []) {
        const pool = s.pool && (POOLS[s.pool.toLowerCase()] ?? `pool ${short(s.pool)}`);
        add(`${PEG_SOURCES[s.kind] ?? `${s.kind} peg source`}${pool ? ` (${pool})` : ""}`, s.address);
      }
    }
  }
  const listed = new Set(CONTRACTS.map(([key]) => key));
  for (const [key, address] of Object.entries(d.contracts)) {
    if (!listed.has(key) && !(key in EXTERNAL) && !NOT_CONTRACTS.has(key)) add(key, address);
  }
  return out;
}

/** The contracts table: PROOF.md's columns, or the README's (explorer link on the address, Mezo's Morpho rows). */
function renderContracts(src, file, { readme = false } = {}) {
  const { d, explorer } = src;
  const contracts = listContracts(src);
  const address = (a) => `${explorer}/address/${a}`;
  const sourcify = (a) => `${SOURCIFY}/${d.chainId}/${a}`;
  if (readme) {
    const out = ["| Contract | Address | Verified |", "| --- | --- | --- |"];
    for (const [label, a] of contracts) {
      out.push(`| ${label} | [\`${a}\`](${address(a)}) | [Sourcify](${sourcify(a)}) |`);
    }
    for (const [key, label] of Object.entries(EXTERNAL)) {
      const a = d.contracts[key];
      if (a) out.push(`| ${label} | [\`${a}\`](${address(a)}) | on Mezo's explorer |`);
    }
    return out.join("\n");
  }
  const out = [
    `Rendered by \`node docs/proof-table.mjs\` from \`${file}\`: ${contracts.length} Surety contracts.`,
    "",
    "| Contract | Address | Sourcify | Explorer |",
    "| --- | --- | --- | --- |",
  ];
  for (const [label, a] of contracts) {
    out.push(`| ${label} | \`${a}\` | [source](${sourcify(a)}) | [explorer](${address(a)}) |`);
  }
  return out.join("\n");
}

/** Replaces what sits between the markers, indented like the start marker (so a block can live in a list item). */
function splice(path, [start, end], body, { required = true } = {}) {
  const text = readFileSync(path, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) {
    if (required) throw new Error(`${path}: markers ${start} / ${end} not found`);
    return false;
  }
  const indent = text.slice(text.lastIndexOf("\n", a) + 1, a);
  const lines = body.split("\n").map((l) => (l ? indent + l : l));
  const next = `${text.slice(0, a + start.length)}\n${lines.join("\n")}\n\n${indent}${text.slice(b)}`;
  if (next !== text) writeFileSync(path, next);
  return true;
}

function render(file) {
  const src = load(file);
  const shown = relative(ROOT, file).replaceAll("\\", "/");
  // A file from another checkout is named by the path it has inside the repository.
  const outside = shown.startsWith("..") || isAbsolute(shown);
  const name = outside ? `contracts/deployments/${src.version >= 2 ? "" : "v1/"}${src.d.chainId}.json` : shown;
  // The v2 mainnet deployment has no scripted lifecycle: its blocks are the contracts table and the transactions
  // the team sent through it with real MUSD.
  if (src.version >= 2 && src.d.chainId === MAINNET) {
    const rows = planV2(src, MAINNET_PHASES, MAINNET_REQUIRED);
    return {
      contracts: true,
      proof: renderContracts(src, name),
      readme: renderContracts(src, name, { readme: true }),
      keys: renderKeys(src, rows),
      table: renderTable(src, rows, name),
    };
  }
  const rows = src.version >= 2 ? planV2(src) : planV1(src);
  return { version: src.version, keys: renderKeys(src, rows), table: renderTable(src, rows, name) };
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const fileArg = args.find((a) => !a.startsWith("--"));
const files = fileArg ? [fileArg] : [V1_FILE, V2_FILE, MAINNET_FILE].filter((f) => existsSync(f));
const blocks = files.map(render);

if (write) {
  const updated = new Set();
  for (const b of blocks) {
    if (b.contracts) {
      splice(join(ROOT, "docs/PROOF.md"), MARKERS.contractsMainnet, b.proof);
      updated.add("docs/PROOF.md");
      if (splice(join(ROOT, "README.md"), MARKERS.contractsMainnet, b.readme, { required: false })) {
        updated.add("README.md");
      }
      // The mainnet key steps go wherever their markers are; the full table lives in PROOF.md.
      for (const doc of ["README.md", "docs/PROOF.md"]) {
        if (splice(join(ROOT, doc), MARKERS.keysMainnet, b.keys, { required: false })) updated.add(doc);
      }
      splice(join(ROOT, "docs/PROOF.md"), MARKERS.tableMainnet, b.table);
      continue;
    }
    const [keys, table] = b.version >= 2 ? [MARKERS.keysV2, MARKERS.tableV2] : [MARKERS.keys, MARKERS.table];
    // The v1 key steps must be in the README; the v2 ones go wherever their markers are.
    for (const doc of ["README.md", "docs/PROOF.md"]) {
      if (splice(join(ROOT, doc), keys, b.keys, { required: b.version < 2 && doc === "README.md" })) updated.add(doc);
    }
    splice(join(ROOT, "docs/PROOF.md"), table, b.table);
    updated.add("docs/PROOF.md");
  }
  process.stdout.write(`Updated ${[...updated].join(" and ")}\n`);
} else {
  const print = (b) => (b.contracts ? `${b.proof}\n\n${b.keys}\n\n${b.table}` : `${b.keys}\n\n${b.table}`);
  process.stdout.write(`${blocks.map(print).join("\n\n")}\n`);
}
