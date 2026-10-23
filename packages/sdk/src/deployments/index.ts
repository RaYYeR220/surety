import example31611 from "./example.31611.json";
import { parseDeployment } from "./parse.js";
import { rawDeployments } from "./registry.js";
import type { SuretyDeployment } from "./types.js";

export { DeploymentError, parseDeployment } from "./parse.js";
export type * from "./types.js";

const cache = new Map<number, SuretyDeployment>();

/** Chain ids that have a deployment bundled into this build. */
export function deployedChainIds(): number[] {
  return Object.keys(rawDeployments).map(Number);
}

/**
 * The deployment bundled for `chainId`, validated, or `undefined` when this build has none for that chain.
 * Throws `DeploymentError` if the bundled file is malformed.
 */
export function getDeployment(chainId: number): SuretyDeployment | undefined {
  const cached = cache.get(chainId);
  if (cached) return cached;
  const raw = rawDeployments[chainId];
  if (raw === undefined) return undefined;
  const parsed = parseDeployment(raw);
  if (parsed.chainId !== chainId) {
    throw new Error(`deployment file for chain ${chainId} declares chainId ${parsed.chainId}`);
  }
  cache.set(chainId, parsed);
  return parsed;
}

/** Zero-address example deployment for chain 31611, for tests and fixtures. */
export const exampleDeployment: SuretyDeployment = parseDeployment(example31611);
