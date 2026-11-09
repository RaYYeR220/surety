// Load check, in a real headless Chrome (Playwright):
//   1. with every Mezo RPC host blocked, the landing, /app and /app/try still render their content
//      (the build snapshot), with no 404s and no console errors beyond the blocked requests themselves;
//   2. with the RPCs up, each page reaches networkidle within 5 s (DOMContentLoaded and load are reported too);
//   3. a hidden tab makes no RPC requests.
//
//   pnpm --filter web build && node scripts/check-load.ts            serves out/ locally
//   node scripts/check-load.ts --url https://surety-credit.vercel.app  checks a deployment
//   node scripts/check-load.ts --dir ../../.deploy/surety-credit       serves a staged deploy folder
//
// Uses the Chrome installed on the machine (channel "chrome"); set PLAYWRIGHT_CHANNEL=chromium for Playwright's own.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page, type Request } from "playwright";

import { RPC_HOSTS } from "../src/lib/rpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const IDLE_BUDGET_MS = 5_000;
const EXPLORER_HOSTS = ["api.explorer.mezo.org", "api.explorer.test.mezo.org"];

/* ---------- Static server (cleanUrls + trailing slashes, like the Vercel deploy) ---------- */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

function serve(dir: string): Promise<{ url: string; close: () => void }> {
  const root = resolve(dir);
  const require = createRequire(import.meta.url);
  const apiFile = [join(root, "api", "starter.js"), join(here, "..", "dist-api", "api", "starter.js")].find(existsSync);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/api/starter" && apiFile) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        const handler = (require(apiFile) as { default: (q: unknown, s: unknown) => Promise<void> }).default;
        void handler({ method: req.method, headers: req.headers, body, socket: req.socket }, res);
      });
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const candidates = [join(root, path), join(root, path, "index.html"), join(root, `${path}.html`)];
    const file = candidates.find((f) => f.startsWith(root) && existsSync(f) && statSync(f).isFile());
    if (!file) {
      res.statusCode = 404;
      res.setHeader("content-type", TYPES[".html"]!);
      res.end(existsSync(join(root, "404.html")) ? readFileSync(join(root, "404.html")) : "not found");
      return;
    }
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

/* ---------- Checks ---------- */

interface Visit {
  page: string;
  mode: "rpc blocked" | "rpc up";
  dcl: number;
  load: number;
  idle: number | null;
  rpcRequests: number;
  notFound: string[];
  consoleErrors: string[];
  failures: string[];
}

const isRpc = (url: string) => RPC_HOSTS.some((h) => url.includes(`//${h}`));
const isExplorer = (url: string) => EXPLORER_HOSTS.some((h) => url.includes(`//${h}`));

/** What each page must show from its static HTML alone. */
const CONTENT: Record<string, (page: Page) => Promise<string[]>> = {
  "/": async (page) => {
    const f: string[] = [];
    if (!(await page.getByRole("heading", { level: 1 }).filter({ hasText: "Bitcoin decides where" }).isVisible()))
      f.push("landing headline missing");
    const rows = await page.locator("#board table tbody tr").count();
    if (rows < 1) f.push("landing credit board has no rows");
    const caption = (await page.locator("figure figcaption").first().textContent()) ?? "";
    if (!/Mezo (Mainnet|Testnet)/.test(caption)) f.push(`hero caption does not name the network: "${caption}"`);
    return f;
  },
  "/app/": async (page) => {
    const f: string[] = [];
    if (!(await page.getByRole("heading", { level: 1, name: "Credit board" }).isVisible())) f.push("board title missing");
    const strip = (await page.locator("[data-freshness]").textContent().catch(() => "")) ?? "";
    if (!/as of \d{1,2} \w{3}, \d{2}:\d{2} UTC/.test(strip)) f.push(`no "as of" label: "${strip.slice(0, 120)}"`);
    if (!(await page.getByText("Total lent in (TVL)").first().isVisible())) f.push("TVL figure missing");
    if (!(await page.getByText(/veBTC credit line/).first().isVisible())) f.push("credit lines missing");
    return f;
  },
  "/app/try/": async (page) => {
    const f: string[] = [];
    if (!(await page.getByRole("heading", { level: 1, name: "Try Surety on testnet" }).isVisible())) f.push("try title missing");
    if (!(await page.getByRole("button", { name: /Create a (testnet )?key/ }).isVisible())) f.push("create-key button missing");
    return f;
  },
};

async function visit(browser: Browser, base: string, path: string, mode: Visit["mode"]): Promise<Visit> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const notFound: string[] = [];
  const consoleErrors: string[] = [];
  let rpcRequests = 0;
  if (mode === "rpc blocked") {
    await page.route((url) => isRpc(url.href) || isExplorer(url.href), (route) => route.abort("connectionrefused"));
  }
  page.on("request", (r: Request) => {
    if (isRpc(r.url())) rpcRequests++;
  });
  page.on("response", (r) => {
    if (r.status() === 404) notFound.push(r.url().replace(base, ""));
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // A blocked RPC shows up as a failed resource load; that is the point of this run, not a page error.
    if (mode === "rpc blocked" && /Failed to load resource|ERR_CONNECTION_REFUSED|ERR_FAILED/.test(text)) return;
    consoleErrors.push(text.slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

  const started = Date.now();
  await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("load", { timeout: 30_000 });
  let idle: number | null = null;
  try {
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    idle = Date.now() - started;
  } catch {
    idle = null;
  }
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) };
  });

  // Give failed live reads time to come back, then check the page still shows its content.
  await page.waitForTimeout(mode === "rpc blocked" ? 6_000 : 1_000);
  const failures = await (CONTENT[path] ?? (async () => []))(page);
  if (mode === "rpc up" && (idle === null || idle > IDLE_BUDGET_MS)) failures.push(`networkidle ${idle ?? "never"} ms > ${IDLE_BUDGET_MS} ms`);
  if (notFound.length) failures.push(`${notFound.length} 404(s)`);
  if (consoleErrors.length) failures.push(`${consoleErrors.length} console error(s)`);
  await context.close();
  return { page: path, mode, ...nav, idle, rpcRequests, notFound, consoleErrors, failures };
}

/** A hidden tab must not poll: no RPC request for 20 s after the page reports itself hidden. */
async function hiddenTab(browser: Browser, base: string): Promise<{ requests: number; failures: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/app/`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  let requests = 0;
  page.on("request", (r) => {
    if (isRpc(r.url())) requests++;
  });
  await page.waitForTimeout(20_000);
  await context.close();
  return { requests, failures: requests ? [`${requests} RPC request(s) while hidden`] : [] };
}

async function main() {
  const external = opt("url");
  const dir = opt("dir") ?? join(here, "..", "out");
  if (!external && !existsSync(join(dir, "index.html"))) {
    console.error(`check-load: ${dir} has no index.html; run pnpm --filter web build first (or pass --url)`);
    process.exit(2);
  }
  const server = external ? null : await serve(dir);
  const base = (external ?? server!.url).replace(/\/$/, "");
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    headless: !args.includes("--headed"),
  });
  console.log(`check-load: ${base} (RPC hosts: ${RPC_HOSTS.join(", ")})`);

  const visits: Visit[] = [];
  for (const path of ["/", "/app/", "/app/try/"]) visits.push(await visit(browser, base, path, "rpc blocked"));
  for (const path of ["/", "/app/", "/app/try/"]) visits.push(await visit(browser, base, path, "rpc up"));
  const hidden = await hiddenTab(browser, base);
  await browser.close();
  server?.close();

  console.table(
    visits.map((v) => ({
      page: v.page,
      mode: v.mode,
      "DCL ms": v.dcl,
      "load ms": v.load,
      "networkidle ms": v.idle ?? "never",
      "RPC requests": v.rpcRequests,
      result: v.failures.length ? `FAIL: ${v.failures.join("; ")}` : "ok",
    })),
  );
  console.log(`hidden tab: ${hidden.requests} RPC request(s) in 20 s${hidden.failures.length ? " (FAIL)" : " (ok)"}`);
  for (const v of visits) {
    for (const e of v.consoleErrors) console.log(`  ${v.mode} ${v.page} console: ${e}`);
    for (const u of v.notFound) console.log(`  ${v.mode} ${v.page} 404: ${u}`);
  }
  const failed = visits.some((v) => v.failures.length) || hidden.failures.length > 0;
  console.log(failed ? "check-load: FAILED" : "check-load: passed");
  process.exit(failed ? 1 : 0);
}

await main();
