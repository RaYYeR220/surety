// Generates src/abis/*.ts from the Foundry artifacts in contracts/out.
// Run `forge build` in contracts/ first, then `pnpm --filter @surety/sdk gen:abis`.
// The output is committed so the package builds without Foundry.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AbiItem {
  type: string;
  name?: string;
}

interface Source {
  /** Export name, without the `Abi` suffix. */
  name: string;
  /**
   * Artifacts merged into one ABI, as `File.sol/Contract`, or `File.sol/Contract@source/path.sol` when several
   * sources share the file name (forge then nests one of them under a subdirectory of out/).
   */
  artifacts: string[];
  /** Keep only these item types (default: all). */
  types?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../contracts/out");
const abiDir = resolve(here, "../src/abis");

const sources: Source[] = [
  { name: "creditVoter", artifacts: ["CreditVoter.sol/CreditVoter"] },
  { name: "voteAllocator", artifacts: ["VoteAllocator.sol/VoteAllocator"] },
  { name: "suretyPool", artifacts: ["SuretyPool.sol/SuretyPool"] },
  { name: "veBTCCreditLine", artifacts: ["VeBTCCreditLine.sol/VeBTCCreditLine"] },
  { name: "linearKinkIrm", artifacts: ["LinearKinkIrm.sol/LinearKinkIrm"] },
  { name: "loanEscrow", artifacts: ["LoanEscrow.sol/LoanEscrow"] },
  { name: "skipPriceSource", artifacts: ["SkipPriceSource.sol/SkipPriceSource"] },
  { name: "stressedPriceSource", artifacts: ["StressedPriceSource.sol/StressedPriceSource"] },
  { name: "morphoPriceOracle", artifacts: ["MorphoPriceOracle.sol/MorphoPriceOracle"] },
  { name: "btcMusdPriceSource", artifacts: ["BtcMusdPriceSource.sol/BtcMusdPriceSource"] },
  { name: "musdPeg", artifacts: ["MusdPeg.sol/MusdPeg"] },
  { name: "clTwapPegSource", artifacts: ["ClTwapPegSource.sol/ClTwapPegSource"] },
  { name: "stableTwapPegSource", artifacts: ["StableTwapPegSource.sol/StableTwapPegSource"] },
  { name: "btcCrossPegSource", artifacts: ["BtcCrossPegSource.sol/BtcCrossPegSource"] },
  { name: "stressedPegSource", artifacts: ["StressedPegSource.sol/StressedPegSource"] },
  { name: "savingsAdapter", artifacts: ["SavingsAdapter.sol/SavingsAdapter"] },
  { name: "musdSavingsRate", artifacts: ["IMusdSavingsRate.sol/IMusdSavingsRate"] },
  { name: "shareMarket", artifacts: ["ShareMarket.sol/ShareMarket"] },
  { name: "sponsor", artifacts: ["Sponsor.sol/Sponsor"] },
  { name: "vaultV2", artifacts: ["VaultV2.sol/VaultV2"] },
  {
    name: "morphoMarketV1AdapterV2",
    artifacts: ["MorphoMarketV1AdapterV2.sol/MorphoMarketV1AdapterV2"],
  },
  // IMorpho has the functions; Morpho emits its events through EventsLib.
  {
    name: "morpho",
    artifacts: ["IMorpho.sol/IMorpho", "EventsLib.sol/EventsLib@lib/morpho-blue/src/libraries/EventsLib.sol"],
  },
  { name: "adaptiveCurveIrm", artifacts: ["AdaptiveCurveIrm.sol/AdaptiveCurveIrm"] },
  { name: "aggregatorV3", artifacts: ["IAggregatorV3.sol/IAggregatorV3"] },
];

/** Every `<file>/` directory under out/, at any depth. */
function artifactDirs(file: string, dir = outDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === file) out.push(path);
    else if (!entry.name.endsWith(".sol")) out.push(...artifactDirs(file, path));
  }
  return out;
}

function compilationTarget(path: string): string | undefined {
  const json = JSON.parse(readFileSync(path, "utf8")) as { metadata?: { settings?: { compilationTarget?: object } } };
  return Object.keys(json.metadata?.settings?.compilationTarget ?? {})[0];
}

function artifactPath(spec: string): string {
  const [ref, source] = spec.split("@") as [string, string | undefined];
  if (source) {
    const [file, contract] = ref.split("/") as [string, string];
    for (const dir of artifactDirs(file)) {
      for (const f of readdirSync(dir).filter((x) => x.startsWith(`${contract}.`) && x.endsWith(".json"))) {
        if (compilationTarget(join(dir, f)) === source) return join(dir, f);
      }
    }
    throw new Error(`missing artifact ${ref} from ${source} (run forge build in contracts/)`);
  }
  const [file, contract] = ref.split("/") as [string, string];
  const exact = join(outDir, file, `${contract}.json`);
  if (existsSync(exact)) return exact;
  // Contracts compiled by several solc versions get a version suffix (IMorpho.0.8.19.json).
  const dir = join(outDir, file);
  const candidates = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(`${contract}.`) && f.endsWith(".json"))
    : [];
  if (candidates.length === 0) throw new Error(`missing artifact ${ref} (run forge build in contracts/)`);
  return join(dir, candidates.sort().at(-1)!);
}

function loadAbi(ref: string): AbiItem[] {
  const json = JSON.parse(readFileSync(artifactPath(ref), "utf8")) as { abi?: AbiItem[] };
  if (!Array.isArray(json.abi)) throw new Error(`artifact ${ref} has no abi`);
  return json.abi;
}

function key(item: AbiItem): string {
  return JSON.stringify(item);
}

const header = "// Generated by scripts/gen-abis.ts from contracts/out. Do not edit by hand.\n";
const written: string[] = [];

for (const source of sources) {
  const seen = new Set<string>();
  const items: AbiItem[] = [];
  for (const ref of source.artifacts) {
    for (const item of loadAbi(ref)) {
      if (source.types && !source.types.includes(item.type)) continue;
      const k = key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(item);
    }
  }
  const body = `${header}\nexport const ${source.name}Abi = ${JSON.stringify(items, null, 2)} as const;\n`;
  writeFileSync(join(abiDir, `${source.name}.ts`), body);
  written.push(source.name);
}

const index =
  `${header}\n` +
  written.map((name) => `export { ${name}Abi } from "./${name}.js";`).join("\n") +
  `\nexport { erc20Abi } from "./erc20.js";\n` +
  `export { mezoPoolsVoterAbi, rewardsDistributorAbi, votingRewardAbi } from "./mezo.js";\n` +
  `export { veBTCAbi } from "./veBTC.js";\n` +
  `export { veBTCCreditLineV1Abi } from "./veBTCCreditLineV1.js";\n`;
writeFileSync(join(abiDir, "index.ts"), index);

console.log(`wrote ${written.length} ABIs to ${abiDir}`);
