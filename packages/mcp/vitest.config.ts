import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against the SDK sources, so they do not need a prior SDK build.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@surety\/sdk\/testing$/, replacement: fileURLToPath(new URL("../sdk/src/testing/index.ts", import.meta.url)) },
      { find: /^@surety\/sdk$/, replacement: fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) },
    ],
  },
});
