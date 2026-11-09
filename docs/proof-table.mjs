#!/usr/bin/env node
// Renders the live-lifecycle proof from a deployment file's `proof.txs` as Markdown: the v1 run (written by
// keeper/scripts/testnet-cycle.ts) and the v2 run (keeper/scripts/testnet-cycle-v2.ts).
//
//   node docs/proof-table.mjs                     print the v1 and v2 blocks for contracts/deployments/v1/31611.json
//                                                 and contracts/deployments/31611.json
//   node docs/proof-table.mjs <deployment.json>   print the blocks for one deployment file (v1 or v2 by its schema)
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
const V1_FILE = join(ROOT, "contracts/deployments/v1/31611.json");
const V2_FILE = join(ROOT, "contracts/deployments/31611.json");

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
// that is not one.
const V2_PHASES = [
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
  ["harvest", /harvest loan/],
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

const MARKERS = {
  keys: ["<!-- proof:key-steps:start -->", "<!-- proof:key-steps:end -->"],
  table: ["<!-- proof:lifecycle:start -->", "<!-- proof:lifecycle:end -->"],
  keysV2: ["<!-- proof:key-steps-v2:start -->", "<!-- proof:key-steps-v2:end -->"],
  tableV2: ["<!-- proof:lifecycle-v2:start -->", "<!-- proof:lifecycle-v2:end -->"],
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

/** v2: recorded txs in the order they were sent, by phase, then PENDING rows for required steps not recorded. */
function planV2({ txs }) {
  const phaseOf = (label) => V2_PHASES.find(([, re]) => re.test(label))?.[0] ?? "other";
  const phases = txs.map((t) => (isApproval(t.label) ? null : phaseOf(t.label)));
  for (let i = phases.length - 1, next = "other"; i >= 0; i--) {
    if (phases[i] === null) phases[i] = next;
    else next = phases[i];
  }
  const rows = txs.map((t, i) => ({ phase: phases[i], tx: t }));
  for (const [phase, re, missing, key] of V2_REQUIRED) {
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
    `Rendered by \`node docs/proof-table.mjs\` from \`${file}\`: ${done} transactions recorded, ${pending} steps PENDING.`,
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
  const rows = src.version >= 2 ? planV2(src) : planV1(src);
  const shown = relative(ROOT, file).replaceAll("\\", "/");
  // A file from another checkout is named by the path it has inside the repository.
  const outside = shown.startsWith("..") || isAbsolute(shown);
  const name = outside ? `contracts/deployments/${src.version >= 2 ? "" : "v1/"}${src.d.chainId}.json` : shown;
  return { version: src.version, keys: renderKeys(src, rows), table: renderTable(src, rows, name) };
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const fileArg = args.find((a) => !a.startsWith("--"));
const files = fileArg ? [fileArg] : [V1_FILE, V2_FILE].filter((f) => existsSync(f));
const blocks = files.map(render);

if (write) {
  const updated = new Set();
  for (const b of blocks) {
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
  process.stdout.write(`${blocks.map((b) => `${b.keys}\n\n${b.table}`).join("\n\n")}\n`);
}
