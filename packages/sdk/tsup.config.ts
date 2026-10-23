import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing/index.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["viem"],
});
