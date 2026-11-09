// Assembles the folder that `vercel deploy` uploads: the static site, the starter-kit function and vercel.json.
//
//   pnpm --filter web build                 site in out/, function in dist-api/api/starter.js
//   node scripts/stage-deploy.ts [--to DIR] DIR defaults to apps/web/.deploy/surety-credit
//
// Layout of the staged folder (its name is the Vercel project's, surety-credit):
//   surety-credit/
//     index.html, app/, _next/, …   everything in out/
//     api/starter.js                POST /api/starter, a self-contained Node function (viem and the SDK inlined)
//     vercel.json                   cleanUrls, and 30 s for the function to wait for its receipt
//     .vercel/                      the project link, kept from earlier deploys
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const toArg = args.indexOf("--to");
const target = resolve(toArg >= 0 && args[toArg + 1] ? args[toArg + 1]! : join(root, ".deploy", "surety-credit"));
const out = join(root, "out");
const fn = join(root, "dist-api", "api", "starter.js");

for (const [what, path] of [
  ["the static site", join(out, "index.html")],
  ["the starter-kit function", fn],
] as const) {
  if (!existsSync(path)) {
    console.error(`stage: ${what} is missing (${path}); run pnpm --filter web build first`);
    process.exit(1);
  }
}

mkdirSync(target, { recursive: true });
// Start clean, but keep the Vercel project link.
for (const entry of readdirSync(target)) {
  if (entry !== ".vercel") rmSync(join(target, entry), { recursive: true, force: true });
}
cpSync(out, target, { recursive: true });
mkdirSync(join(target, "api"), { recursive: true });
cpSync(fn, join(target, "api", "starter.js"));
writeFileSync(
  join(target, "vercel.json"),
  `${JSON.stringify({ cleanUrls: true, functions: { "api/starter.js": { maxDuration: 30 } } }, null, 2)}\n`,
);

console.log(`stage: ${target} is ready`);
console.log(existsSync(join(target, ".vercel")) ? "stage: linked to its Vercel project" : "stage: not linked yet (vercel link)");
console.log("next:");
console.log(`  cd "${target}"`);
console.log("  vercel deploy --prod --yes --scope rayyer220s-projects");
