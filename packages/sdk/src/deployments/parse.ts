import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

import type {
  DeploymentCaps,
  DeploymentFees,
  DeploymentLine,
  ExternalContracts,
  LineKind,
  LineParams,
  MarketParams,
  PegParams,
  PegSourceInfo,
  PegSourceKind,
  ProofTx,
  SponsorKit,
  SuretyContracts,
  SuretyDeployment,
} from "./types.js";

const CONTRACT_KEYS = [
  "vault",
  "morphoAdapter",
  "morpho",
  "irm",
  "creditVoter",
  "voteAllocator",
  "suretyPool",
  "veBTCLine",
  "loanEscrowImpl",
  "irmLine",
  "priceSource",
  "skipSource",
  "morphoOracle",
] as const satisfies readonly (keyof SuretyContracts)[];

/** Contracts every v2 deployment has. */
const V2_CONTRACT_KEYS = [
  "depositGate",
  "btcMusdSource",
  "btcUsdSource",
  "musdPeg",
  "savingsAdapter",
  "shareMarket",
  "treasury",
] as const satisfies readonly (keyof SuretyContracts)[];

/** v2 testnet-only contracts. */
const V2_OPTIONAL_CONTRACT_KEYS = ["stressedPegSource", "sponsor"] as const satisfies readonly (keyof SuretyContracts)[];

const EXTERNAL_KEYS = [
  "musd",
  "btc",
  "veBTC",
  "poolsVoter",
  "rewardsDistributor",
  "skipAggregator",
] as const satisfies readonly (keyof ExternalContracts)[];

const LINE_PARAM_KEYS = [
  "maxLtvTimedBps",
  "maxLtvPermanentBps",
  "liqLtvBps",
  "liqFeeBps",
  "floorBps",
  "auctionDuration",
  "minTerm",
  "originationFeeBps",
  "protocolShareBps",
  "keeperShareBps",
] as const satisfies readonly (keyof LineParams)[];

const PEG_SOURCE_KINDS: readonly PegSourceKind[] = ["ClTwap", "StableTwap", "BtcCross", "Stressed"];

export class DeploymentError extends Error {
  override name = "DeploymentError";
}

function fail(path: string, message: string): never {
  throw new DeploymentError(`deployment ${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function address(value: unknown, path: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail(path, "expected an address");
  return getAddress(value);
}

function hex(value: unknown, path: string): Hex {
  if (typeof value !== "string" || !isHex(value)) fail(path, "expected 0x-prefixed hex");
  return value;
}

function integer(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  fail(path, "expected an integer");
}

function smallInt(value: unknown, path: string): number {
  const n = integer(value, path);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) fail(path, "out of range");
  return Number(n);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected true or false");
  return value;
}

function marketParams(value: unknown, path: string): MarketParams {
  const v = record(value, path);
  return {
    loanToken: address(v.loanToken, `${path}.loanToken`),
    collateralToken: address(v.collateralToken, `${path}.collateralToken`),
    oracle: address(v.oracle, `${path}.oracle`),
    irm: address(v.irm, `${path}.irm`),
    lltv: integer(v.lltv, `${path}.lltv`),
  };
}

function line(value: unknown, path: string): DeploymentLine {
  const v = record(value, path);
  const kind = v.kind;
  if (kind !== "Morpho" && kind !== "VeBTC") fail(`${path}.kind`, 'expected "Morpho" or "VeBTC"');
  const out: DeploymentLine = {
    id: smallInt(v.id, `${path}.id`),
    kind: kind as LineKind,
    name: string(v.name, `${path}.name`),
    adapter: address(v.adapter, `${path}.adapter`),
  };
  if (v.marketId !== undefined) out.marketId = hex(v.marketId, `${path}.marketId`);
  if (v.marketParams !== undefined) out.marketParams = marketParams(v.marketParams, `${path}.marketParams`);
  return out;
}

function lineParams(value: unknown, path: string): LineParams {
  const v = record(value, path);
  const out = {} as LineParams;
  for (const key of LINE_PARAM_KEYS) out[key] = smallInt(v[key], `${path}.${key}`);
  return out;
}

function pegParams(value: unknown, path: string): PegParams {
  const v = record(value, path);
  return {
    minSources: smallInt(v.minSources, `${path}.minSources`),
    maxSpreadBps: smallInt(v.maxSpreadBps, `${path}.maxSpreadBps`),
    bandBps: smallInt(v.bandBps, `${path}.bandBps`),
  };
}

function pegSource(value: unknown, path: string): PegSourceInfo {
  const v = record(value, path);
  const kind = v.kind as PegSourceKind;
  if (!PEG_SOURCE_KINDS.includes(kind)) fail(`${path}.kind`, `expected one of ${PEG_SOURCE_KINDS.join(", ")}`);
  const out: PegSourceInfo = { kind, address: address(v.address, `${path}.address`) };
  if (v.pool !== undefined) out.pool = address(v.pool, `${path}.pool`);
  if (v.window !== undefined) out.window = smallInt(v.window, `${path}.window`);
  if (v.granularity !== undefined) out.granularity = smallInt(v.granularity, `${path}.granularity`);
  if (v.btcUsd !== undefined) out.btcUsd = address(v.btcUsd, `${path}.btcUsd`);
  if (v.base !== undefined) out.base = address(v.base, `${path}.base`);
  if (kind !== "Stressed" && !out.pool) fail(`${path}.pool`, "expected an address");
  return out;
}

function fees(value: unknown, path: string): DeploymentFees {
  const v = record(value, path);
  return {
    performanceFee: integer(v.performanceFee, `${path}.performanceFee`),
    performanceFeeRecipient: address(v.performanceFeeRecipient, `${path}.performanceFeeRecipient`),
    managementFee: integer(v.managementFee, `${path}.managementFee`),
    managementFeeRecipient: address(v.managementFeeRecipient, `${path}.managementFeeRecipient`),
    forceDeallocatePenalty: integer(v.forceDeallocatePenalty, `${path}.forceDeallocatePenalty`),
    shareMarketFeeBps: smallInt(v.shareMarketFeeBps, `${path}.shareMarketFeeBps`),
  };
}

function caps(value: unknown, path: string): DeploymentCaps {
  const v = record(value, path);
  return {
    morpho: integer(v.morpho, `${path}.morpho`),
    line: integer(v.line, `${path}.line`),
    savings: integer(v.savings, `${path}.savings`),
  };
}

function sponsorKit(value: unknown, path: string): SponsorKit {
  const v = record(value, path);
  return {
    relayer: address(v.relayer, `${path}.relayer`),
    btcGas: integer(v.btcGas, `${path}.btcGas`),
    lockAmount: integer(v.lockAmount, `${path}.lockAmount`),
    musd: integer(v.musd, `${path}.musd`),
    lockDuration: smallInt(v.lockDuration, `${path}.lockDuration`),
    dailyLimit: smallInt(v.dailyLimit, `${path}.dailyLimit`),
    fundedBtc: integer(v.fundedBtc, `${path}.fundedBtc`),
    fundedMusd: integer(v.fundedMusd, `${path}.fundedMusd`),
  };
}

/** The v2 keys: required ones checked, testnet-only ones read when present. */
function readV2(v: Record<string, unknown>, out: SuretyDeployment): void {
  const contractsRaw = record(v.contracts, "contracts");
  for (const key of V2_CONTRACT_KEYS) out.contracts[key] = address(contractsRaw[key], `contracts.${key}`);
  for (const key of V2_OPTIONAL_CONTRACT_KEYS) {
    if (contractsRaw[key] !== undefined) out.contracts[key] = address(contractsRaw[key], `contracts.${key}`);
  }
  out.external.smusd = address(record(v.external, "external").smusd, "external.smusd");
  out.stress = boolean(v.stress, "stress");
  out.timelock = smallInt(v.timelock, "timelock");
  out.morphoMarketId = hex(v.morphoMarketId, "morphoMarketId");
  out.lineParams = lineParams(v.lineParams, "lineParams");
  out.peg = pegParams(v.peg, "peg");
  if (!Array.isArray(v.pegSources) || v.pegSources.length === 0) fail("pegSources", "expected a non-empty array");
  out.pegSources = v.pegSources.map((s: unknown, i: number) => pegSource(s, `pegSources[${i}]`));
  out.fees = fees(v.fees, "fees");
  out.caps = caps(v.caps, "caps");
  if (v.sponsorKit !== undefined) out.sponsorKit = sponsorKit(v.sponsorKit, "sponsorKit");
}

/**
 * Validates a raw deployment file object and normalises it: checksummed addresses, bigint integers. Version 1 files
 * (`contracts/deployments/v1/<chainId>.json`) have no `version` key; version 2 files must carry every v2 key.
 * Throws `DeploymentError` naming the first bad field.
 */
export function parseDeployment(raw: unknown): SuretyDeployment {
  const v = record(raw, "root");
  const version = v.version === undefined ? 1 : smallInt(v.version, "version");
  if (version !== 1 && version !== 2) fail("version", "expected 1 or 2");
  const contractsRaw = record(v.contracts, "contracts");
  const externalRaw = record(v.external, "external");

  const contracts = {} as SuretyContracts;
  for (const key of CONTRACT_KEYS) contracts[key] = address(contractsRaw[key], `contracts.${key}`);
  if (contractsRaw.depositGate !== undefined) {
    contracts.depositGate = address(contractsRaw.depositGate, "contracts.depositGate");
  }
  const external = {} as ExternalContracts;
  for (const key of EXTERNAL_KEYS) external[key] = address(externalRaw[key], `external.${key}`);

  if (!Array.isArray(v.lines)) fail("lines", "expected an array");
  const proofRaw = v.proof === undefined ? { txs: [] } : record(v.proof, "proof");
  const txsRaw = proofRaw.txs ?? [];
  if (!Array.isArray(txsRaw)) fail("proof.txs", "expected an array");
  const txs: ProofTx[] = txsRaw.map((tx: unknown, i: number) => {
    const t = record(tx, `proof.txs[${i}]`);
    return { label: string(t.label, `proof.txs[${i}].label`), hash: hex(t.hash, `proof.txs[${i}].hash`) };
  });

  const epochLength = smallInt(v.epochLength, "epochLength");
  if (epochLength === 0) fail("epochLength", "must be positive");
  const deployedAt = integer(v.deployedAt ?? 0, "deployedAt");
  // Mezo block numbers stay far below 1e9 for decades; anything above is a unix timestamp by mistake.
  if (deployedAt >= 1_000_000_000n) fail("deployedAt", "expected the deployment block number, got a timestamp?");

  const out: SuretyDeployment = {
    version,
    chainId: smallInt(v.chainId, "chainId"),
    epochLength,
    deployedAt,
    contracts,
    external,
    lines: v.lines.map((l: unknown, i: number) => line(l, `lines[${i}]`)),
    proof: { txs },
  };
  if (version === 2) readV2(v, out);
  return out;
}
