import example31611 from "./example.31611.json";
import exampleV2 from "./example.v2.31611.json";
import { parseDeployment } from "./parse.js";
import { rawArchivedDeployments, rawDeployments } from "./registry.js";
import type { SuretyDeployment, SuretyDeploymentV2 } from "./types.js";

export { DeploymentError, parseDeployment } from "./parse.js";
export { isV2Deployment } from "./types.js";
export type * from "./types.js";

const cache = new Map<string, SuretyDeployment>();

function load(key: string, raw: unknown, chainId: number): SuretyDeployment {
  const cached = cache.get(key);
  if (cached) return cached;
  const parsed = parseDeployment(raw);
  if (parsed.chainId !== chainId) {
    throw new Error(`deployment file for chain ${chainId} declares chainId ${parsed.chainId}`);
  }
  cache.set(key, parsed);
  return parsed;
}

/** Archived versions bundled for `chainId`, newest first. */
function archivedVersions(chainId: number): number[] {
  return Object.keys(rawArchivedDeployments)
    .map(Number)
    .filter((v) => rawArchivedDeployments[v]?.[chainId] !== undefined)
    .sort((a, b) => b - a);
}

/** Chain ids that have a deployment (current or archived) bundled into this build. */
export function deployedChainIds(): number[] {
  const ids = new Set(Object.keys(rawDeployments).map(Number));
  for (const byChain of Object.values(rawArchivedDeployments)) {
    for (const id of Object.keys(byChain)) ids.add(Number(id));
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * The deployment bundled for `chainId`, validated, or `undefined` when this build has none for that chain.
 * Without `version`: the current deployment (`contracts/deployments/<chainId>.json`), or, while a chain has none
 * yet, its newest archived one. With `version`: that schema version only (the current file if it has it, else the
 * archive `contracts/deployments/v<version>/`). Throws `DeploymentError` if the bundled file is malformed.
 */
export function getDeployment(chainId: number, options: { version?: number } = {}): SuretyDeployment | undefined {
  const current = rawDeployments[chainId];
  if (options.version === undefined) {
    if (current !== undefined) return load(`current:${chainId}`, current, chainId);
    const newest = archivedVersions(chainId)[0];
    return newest === undefined ? undefined : load(`v${newest}:${chainId}`, rawArchivedDeployments[newest]![chainId], chainId);
  }
  if (current !== undefined) {
    const parsed = load(`current:${chainId}`, current, chainId);
    if (parsed.version === options.version) return parsed;
  }
  const archived = rawArchivedDeployments[options.version]?.[chainId];
  return archived === undefined ? undefined : load(`v${options.version}:${chainId}`, archived, chainId);
}

/** Every deployment bundled for `chainId`, newest first: the current one, then the archived ones. */
export function getDeployments(chainId: number): SuretyDeployment[] {
  const out: SuretyDeployment[] = [];
  const current = rawDeployments[chainId];
  if (current !== undefined) out.push(load(`current:${chainId}`, current, chainId));
  for (const v of archivedVersions(chainId)) {
    if (out.some((d) => d.version === v)) continue;
    out.push(load(`v${v}:${chainId}`, rawArchivedDeployments[v]![chainId], chainId));
  }
  return out;
}

/** Zero-address example deployment for chain 31611 in the v1 schema, for tests and fixtures. */
export const exampleDeployment: SuretyDeployment = parseDeployment(example31611);

/** Example deployment for chain 31611 in the v2 schema (a testnet dry run), for tests and fixtures. */
export const exampleDeploymentV2 = parseDeployment(exampleV2) as SuretyDeploymentV2;
