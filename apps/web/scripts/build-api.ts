// Bundles the serverless functions in api/ into self-contained CommonJS files under dist-api/api/, so the deploy
// folder needs no install: viem and the SDK (with its bundled deployments) are inlined.
//
//   node scripts/build-api.ts
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-api", "api");
const functions = ["starter"];

mkdirSync(outDir, { recursive: true });
// This package is "type": "module"; the bundles are CommonJS, as a deploy root without a package.json reads them.
writeFileSync(join(root, "dist-api", "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
for (const name of functions) {
  const outfile = join(outDir, `${name}.js`);
  await build({
    entryPoints: [join(root, "api", `${name}.ts`)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`api: ${outfile} (${Math.round(statSync(outfile).size / 1024)} KB)`);
}
