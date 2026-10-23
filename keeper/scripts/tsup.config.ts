import { defineConfig } from "tsup";

// Builds the operator scripts. The SDK is bundled from its sources (tsconfig paths) rather than its dist, so a
// script runs without an SDK build, against the deployment file it is pointed at.
export default defineConfig({
  entry: { "testnet-cycle": "scripts/testnet-cycle.ts" },
  outDir: "dist/scripts",
  format: ["esm"],
  target: "node22",
  platform: "node",
  tsconfig: "tsconfig.json",
  noExternal: ["@surety/sdk"],
  sourcemap: true,
  clean: true,
  dts: false,
});
