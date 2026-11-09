// node --test src/lib/rpc.test.ts — crashed calls are retried on the same endpoint, timeouts are not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { custom, InternalRpcError, TimeoutError } from "viem";

import { retryCrashes } from "./rpc.ts";

function flaky(failures: Error[]) {
  let calls = 0;
  const transport = custom({
    async request() {
      calls++;
      const next = failures.shift();
      if (next) throw next;
      return "0x1";
    },
  });
  return { transport, calls: () => calls };
}

const crash = () => new InternalRpcError(new Error("method handler crashed"));

describe("retryCrashes", () => {
  it("retries a crashed call until it answers", async () => {
    const f = flaky([crash(), crash()]);
    const t = retryCrashes(f.transport, 2, 1)({ retryCount: 0 });
    assert.equal(await t.request({ method: "eth_blockNumber" }), "0x1");
    assert.equal(f.calls(), 3);
  });

  it("gives up after its attempts", async () => {
    const f = flaky([crash(), crash(), crash()]);
    const t = retryCrashes(f.transport, 2, 1)({ retryCount: 0 });
    await assert.rejects(t.request({ method: "eth_blockNumber" }));
    assert.equal(f.calls(), 3);
  });

  it("does not retry a timeout", async () => {
    const f = flaky([new TimeoutError({ body: {}, url: "https://rpc.test.mezo.org" })]);
    const t = retryCrashes(f.transport, 2, 1)({ retryCount: 0 });
    await assert.rejects(t.request({ method: "eth_blockNumber" }));
    assert.equal(f.calls(), 1);
  });
});
