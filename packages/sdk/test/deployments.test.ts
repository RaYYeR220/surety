import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import example from "../src/deployments/example.31611.json";
import {
  DeploymentError,
  deployedChainIds,
  exampleDeployment,
  getDeployment,
  parseDeployment,
} from "../src/deployments/index.js";
import { createSuretyClient } from "../src/client.js";
import { createMockChain } from "../src/testing/index.js";
import { mezoTestnet } from "../src/chains.js";

describe("deployments", () => {
  it("parses the example file into typed values", () => {
    expect(exampleDeployment.chainId).toBe(31611);
    expect(exampleDeployment.epochLength).toBe(3600);
    expect(exampleDeployment.deployedAt).toBe(16_300_000n);
    expect(exampleDeployment.contracts.vault).toBe(zeroAddress);
    expect(exampleDeployment.lines).toHaveLength(2);
    expect(exampleDeployment.lines[0]!.marketParams!.lltv).toBe(860_000_000_000_000_000n);
    expect(exampleDeployment.lines[1]!.kind).toBe("VeBTC");
  });

  it("names the first bad field", () => {
    const broken = structuredClone(example) as Record<string, unknown>;
    (broken.contracts as Record<string, unknown>).suretyPool = "0x1234";
    expect(() => parseDeployment(broken)).toThrow(DeploymentError);
    expect(() => parseDeployment(broken)).toThrow(/contracts\.suretyPool/);

    const badKind = structuredClone(example) as { lines: { kind: string }[] };
    badKind.lines[0]!.kind = "Aave";
    expect(() => parseDeployment(badKind)).toThrow(/lines\[0\]\.kind/);
  });

  it("accepts lltv as a number or a string", () => {
    const asNumber = structuredClone(example) as { lines: { marketParams?: { lltv: unknown } }[] };
    asNumber.lines[0]!.marketParams!.lltv = 860000000000000000;
    expect(parseDeployment(asNumber).lines[0]!.marketParams!.lltv).toBe(860_000_000_000_000_000n);
  });

  it("tolerates a chain without a bundled deployment", () => {
    expect(getDeployment(1)).toBeUndefined();
    expect(deployedChainIds()).not.toContain(1);
    const { client } = createMockChain({ chain: mezoTestnet, blockNumber: 1n, timestamp: 1n, contracts: [] });
    if (!deployedChainIds().includes(31611)) {
      expect(() => createSuretyClient({ chainId: 31611, publicClient: client })).toThrow(/no Surety deployment/);
    }
    expect(() => createSuretyClient({ chainId: 31612, publicClient: client, deployment: exampleDeployment })).toThrow(
      /chain 31611/,
    );
  });
});
