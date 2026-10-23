import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

import type {
  DeploymentLine,
  ExternalContracts,
  LineKind,
  MarketParams,
  ProofTx,
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

const EXTERNAL_KEYS = [
  "musd",
  "btc",
  "veBTC",
  "poolsVoter",
  "rewardsDistributor",
  "skipAggregator",
] as const satisfies readonly (keyof ExternalContracts)[];

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

/**
 * Validates a raw `deployments/<chainId>.json` object and normalises it: checksummed addresses, bigint
 * integers. Throws `DeploymentError` naming the first bad field.
 */
export function parseDeployment(raw: unknown): SuretyDeployment {
  const v = record(raw, "root");
  const contractsRaw = record(v.contracts, "contracts");
  const externalRaw = record(v.external, "external");

  const contracts = {} as SuretyContracts;
  for (const key of CONTRACT_KEYS) contracts[key] = address(contractsRaw[key], `contracts.${key}`);
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

  return {
    chainId: smallInt(v.chainId, "chainId"),
    epochLength,
    deployedAt: integer(v.deployedAt ?? 0, "deployedAt"),
    contracts,
    external,
    lines: v.lines.map((l: unknown, i: number) => line(l, `lines[${i}]`)),
    proof: { txs },
  };
}
