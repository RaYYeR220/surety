// After `next build`: puts the router's per-segment prefetch files where the client asks for them.
//
// The client requests `<route>/__next.<segment path with dots>.txt` (for /app/borrow:
// /app/borrow/__next.app.borrow.__PAGE__.txt). When the export runs on Windows, Next joins the segment path with
// backslashes before turning slashes into dots, so the files land in nested folders instead
// (app/borrow/__next.app/borrow/__PAGE__.txt) and every <Link> prefetch 404s. This flattens them. On other
// systems there is nothing to move and the script only checks.
//
//   node scripts/fix-export.ts [outDir]
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "out");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function segmentDirs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_next") continue;
    const p = join(dir, entry.name);
    if (entry.name.startsWith("__next.")) found.push(p);
    else found.push(...segmentDirs(p));
  }
  return found;
}

if (!existsSync(out)) {
  console.error(`fix-export: ${out} does not exist; run next build first`);
  process.exit(1);
}

let moved = 0;
for (const dir of segmentDirs(out)) {
  const parent = dirname(dir);
  const prefix = dir.slice(parent.length + 1); // "__next.app"
  for (const file of walk(dir)) {
    const rest = relative(dir, file).split(sep).join("."); // "borrow.__PAGE__.txt"
    const target = join(parent, `${prefix}.${rest}`);
    if (!existsSync(target)) {
      renameSync(file, target);
      moved++;
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

const flat = [...walk(out)].filter((f) => !f.includes(`${sep}_next${sep}`) && /__next\..*\.txt$/.test(f) && statSync(f).isFile());
console.log(`fix-export: ${moved} prefetch file(s) moved into place, ${flat.length} in total`);
