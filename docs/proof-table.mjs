#!/usr/bin/env node
// Renders the live-lifecycle proof from a deployment file's `proof.txs` (written by
// keeper/scripts/testnet-cycle.ts) as Markdown.
//
//   node docs/proof-table.mjs                     print both blocks for contracts/deployments/31611.json
//   node docs/proof-table.mjs <deployment.json>   same, for another deployment file
//   node docs/proof-table.mjs [file] --write      also replace the rendered blocks in README.md and docs/PROOF.md
//
// Every expected step that is not in the file yet is rendered as a PENDING row, so the tables show what is
// still missing instead of silently leaving it out.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPLORERS = { 31611: "https://explorer.test.mezo.org", 31612: "https://explorer.mezo.org" };

// Steps of the lifecycle script in order. `match` is a label prefix; `optional` steps (approvals) are skipped by
// the script when an allowance already exists, so they get no PENDING row.
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

const MARKERS = {
  keys: ["<!-- proof:key-steps:start -->", "<!-- proof:key-steps:end -->"],
  table: ["<!-- proof:lifecycle:start -->", "<!-- proof:lifecycle:end -->"],
};

function load(path) {
  const d = JSON.parse(readFileSync(path, "utf8"));
  const explorer = EXPLORERS[d.chainId];
  if (!explorer) throw new Error(`${path}: no explorer known for chain ${d.chainId}`);
  return { d, explorer, txs: d.proof?.txs ?? [] };
}

const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const link = (explorer, h) => `[${short(h)}](${explorer}/tx/${h})`;

/** Assigns each recorded tx to a step; returns rows in lifecycle order plus PENDING rows for missing steps. */
function plan({ txs }) {
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
    const step = r.tx ? r.tx.label : `${r.pending} (not recorded yet)`;
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
function splice(path, [start, end], body) {
  const text = readFileSync(path, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${path}: markers ${start} / ${end} not found`);
  const indent = text.slice(text.lastIndexOf("\n", a) + 1, a);
  const lines = body.split("\n").map((l) => (l ? indent + l : l));
  writeFileSync(path, `${text.slice(0, a + start.length)}\n${lines.join("\n")}\n\n${indent}${text.slice(b)}`);
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const file = args.find((a) => !a.startsWith("--")) ?? join(ROOT, "contracts/deployments/31611.json");
const src = load(file);
const rows = plan(src);
const shown = relative(ROOT, file).replaceAll("\\", "/");
const keys = renderKeys(src, rows);
// A file from another checkout is named by the path it has inside the repository.
const outside = shown.startsWith("..") || isAbsolute(shown);
const table = renderTable(src, rows, outside ? `contracts/deployments/${src.d.chainId}.json` : shown);

if (write) {
  splice(join(ROOT, "README.md"), MARKERS.keys, keys);
  splice(join(ROOT, "docs/PROOF.md"), MARKERS.table, table);
  process.stdout.write("Updated README.md and docs/PROOF.md\n");
} else {
  process.stdout.write(`${keys}\n\n${table}\n`);
}
