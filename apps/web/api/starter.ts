// POST /api/starter {"address": "0x…"}: hands a new wallet its testnet starter kit (BTC for gas, a small veBTC lock
// and test MUSD) by calling Sponsor.starterKit(address) from the relayer. Mezo Testnet only.
//
// Deployed as a Vercel Node function at the deploy root (api/starter.js, bundled by scripts/build-api.ts).
// RELAYER_PRIVATE_KEY comes from the Vercel environment; it is never logged or returned.
//
// Checks before sending: a valid, non-zero address; best-effort per-IP limits; on chain, that the address has not
// claimed, that kits are left, that today's kits are under the daily limit and that the relayer is allowed. Mezo's
// eth_estimateGas can come in low, so the gas limit is the estimate × 1.3 (3M when the estimate fails without a
// revert), and the call is simulated at that limit before it is sent.
import { getDeployment, MEZO_TESTNET_ID, sponsorAbi } from "@surety/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  getAddress,
  isAddress,
  nonceManager,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createReadClient, mezoChain, rpcTransport } from "../src/lib/rpc.ts";

export const CHAIN_ID = MEZO_TESTNET_ID;
export const GAS_FALLBACK = 3_000_000n;
const RECEIPT_TIMEOUT_MS = 20_000;

/* ---------- Clients (the subset of viem the handler uses, so tests can stand in for it) ---------- */

type SponsorCall = { address: Address; abi: typeof sponsorAbi; functionName: string; args?: readonly unknown[] };

export interface StarterReadClient {
  readContract(args: SponsorCall): Promise<unknown>;
  estimateContractGas(args: SponsorCall & { account: Address }): Promise<bigint>;
  simulateContract(args: SponsorCall & { account: Address; gas: bigint }): Promise<{ result: unknown }>;
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<Pick<TransactionReceipt, "status" | "logs">>;
}

export interface StarterWriteClient {
  address: Address;
  writeContract(args: SponsorCall & { gas: bigint }): Promise<Hex>;
}

export interface StarterContext {
  /** The Sponsor of the current testnet deployment, or null when none is deployed. */
  sponsor: Address | null;
  reads: StarterReadClient;
  /** The relayer, or null when RELAYER_PRIVATE_KEY is not set. */
  relayer: StarterWriteClient | null;
  /** Seconds since epoch (defaults to the wall clock). */
  now?: () => number;
}

/* ---------- Responses ---------- */

export type StarterResponse =
  | { ok: true; hash: Hex; tokenId: string | null; confirmed: boolean; explorer: string }
  | { ok: false; code: string; error: string };

export interface StarterResult {
  status: number;
  body: StarterResponse;
}

/** What each Sponsor error means to the person asking. */
export const FRIENDLY: Record<string, { status: number; error: string }> = {
  AlreadyClaimed: { status: 409, error: "This address already has its starter kit. There is one kit per wallet." },
  OutOfFunds: {
    status: 503,
    error: "The starter-kit fund is empty right now. Try again later, or fund the wallet from the Mezo testnet faucet.",
  },
  DailyLimitReached: { status: 429, error: "Today's starter kits are all handed out. More open at 00:00 UTC." },
  KitNotSet: { status: 503, error: "Starter kits are not set up on the Sponsor yet." },
  NotRelayer: { status: 503, error: "The starter-kit service is not allowed to hand out kits right now." },
  ZeroAddress: { status: 400, error: "That address cannot receive a kit." },
};

function fail(status: number, code: string, error: string): StarterResult {
  return { status, body: { ok: false, code, error } };
}

function failWith(code: string): StarterResult {
  const f = FRIENDLY[code]!;
  return fail(f.status, code, f.error);
}

/** The Sponsor error name inside a viem error, if the call reverted with one. */
export function sponsorErrorName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName;
    const withData = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
    if (withData?.data) {
      try {
        return decodeErrorResult({ abi: sponsorAbi, data: withData.data }).errorName;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isRevert(e: unknown): boolean {
  if (sponsorErrorName(e)) return true;
  return e instanceof BaseError && /revert/i.test(e.shortMessage + " " + e.details);
}

/* ---------- Per-IP limits (best effort: per function instance) ---------- */

const WINDOW_MS = 10 * 60_000;
const PER_IP = 3;
const ALL_PER_MINUTE = 30;
const hits = new Map<string, number[]>();
let recent: number[] = [];

export function resetRateLimits(): void {
  hits.clear();
  recent = [];
}

function rateLimited(ip: string, nowMs: number): boolean {
  recent = recent.filter((t) => nowMs - t < 60_000);
  const mine = (hits.get(ip) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  if (mine.length >= PER_IP || recent.length >= ALL_PER_MINUTE) {
    hits.set(ip, mine);
    return true;
  }
  mine.push(nowMs);
  hits.set(ip, mine);
  recent.push(nowMs);
  if (hits.size > 5_000) hits.clear();
  return false;
}

/* ---------- Handler ---------- */

export async function handleStarter(
  request: { method: string | undefined; body: unknown; ip: string },
  ctx: StarterContext,
): Promise<StarterResult> {
  if (request.method !== "POST") return fail(405, "MethodNotAllowed", "Use POST with a JSON body {\"address\": \"0x…\"}.");

  const raw = (request.body as { address?: unknown } | null)?.address;
  if (typeof raw !== "string" || !isAddress(raw, { strict: false })) {
    return fail(400, "InvalidAddress", "That is not a valid address.");
  }
  const user = getAddress(raw);
  if (user === zeroAddress) return failWith("ZeroAddress");

  if (!ctx.sponsor) {
    return fail(503, "NotDeployed", "Starter kits open with the next testnet deployment of Surety. Try again soon.");
  }
  if (!ctx.relayer) return fail(503, "NotConfigured", "The starter-kit service is not configured on this deployment.");

  const nowS = ctx.now?.() ?? Math.floor(Date.now() / 1000);
  if (rateLimited(request.ip, nowS * 1000)) {
    return fail(429, "RateLimited", "Too many starter-kit requests from this network. Try again in a few minutes.");
  }

  const sponsor = ctx.sponsor;
  const relayer = ctx.relayer;
  const base = { address: sponsor, abi: sponsorAbi } as const;
  const today = BigInt(Math.floor(nowS / 86_400));

  let state: [boolean, bigint, bigint, bigint, boolean];
  try {
    state = (await Promise.all([
      ctx.reads.readContract({ ...base, functionName: "claimed", args: [user] }),
      ctx.reads.readContract({ ...base, functionName: "kitsLeft" }),
      ctx.reads.readContract({ ...base, functionName: "dailyLimit" }),
      ctx.reads.readContract({ ...base, functionName: "kitsOnDay", args: [today] }),
      ctx.reads.readContract({ ...base, functionName: "isRelayer", args: [relayer.address] }),
    ])) as [boolean, bigint, bigint, bigint, boolean];
  } catch {
    return fail(502, "ChainUnavailable", "Mezo Testnet did not answer. Try again in a minute.");
  }
  const [claimed, kitsLeft, dailyLimit, kitsToday, allowed] = state;
  if (claimed) return failWith("AlreadyClaimed");
  if (!allowed) return failWith("NotRelayer");
  if (kitsLeft === 0n) return failWith("OutOfFunds");
  if (kitsToday >= dailyLimit) return failWith("DailyLimitReached");

  const call = { ...base, functionName: "starterKit", args: [user] } as const;

  let gas: bigint;
  try {
    gas = ((await ctx.reads.estimateContractGas({ ...call, account: relayer.address })) * 13n) / 10n;
  } catch (e) {
    const name = sponsorErrorName(e);
    if (name && FRIENDLY[name]) return failWith(name);
    if (isRevert(e)) return fail(409, "Reverted", "The Sponsor refused this kit.");
    gas = GAS_FALLBACK;
  }

  let predicted: bigint | null = null;
  try {
    const sim = await ctx.reads.simulateContract({ ...call, account: relayer.address, gas });
    predicted = typeof sim.result === "bigint" ? sim.result : null;
  } catch (e) {
    const name = sponsorErrorName(e);
    if (name && FRIENDLY[name]) return failWith(name);
    if (isRevert(e)) return fail(409, "Reverted", "The Sponsor refused this kit.");
    return fail(502, "ChainUnavailable", "Mezo Testnet did not answer. Try again in a minute.");
  }

  let hash: Hex;
  try {
    hash = await relayer.writeContract({ ...call, gas });
  } catch (e) {
    const name = sponsorErrorName(e);
    if (name && FRIENDLY[name]) return failWith(name);
    return fail(502, "SendFailed", "The starter kit could not be sent. Try again in a minute.");
  }

  const explorer = `https://explorer.test.mezo.org/tx/${hash}`;
  try {
    const receipt = await ctx.reads.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") return fail(502, "Reverted", "The starter-kit transaction reverted on chain.");
    let tokenId = predicted;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== sponsor.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: sponsorAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "StarterKit") tokenId = ev.args.tokenId;
      } catch {
        /* another event */
      }
    }
    return { status: 200, body: { ok: true, hash, tokenId: tokenId?.toString() ?? null, confirmed: true, explorer } };
  } catch {
    // Sent but not confirmed within the wait: the page keeps watching the hash.
    return { status: 202, body: { ok: true, hash, tokenId: predicted?.toString() ?? null, confirmed: false, explorer } };
  }
}

/* ---------- Live context ---------- */

export function liveContext(env: Record<string, string | undefined> = process.env): StarterContext {
  let sponsor: Address | null = null;
  try {
    sponsor = getDeployment(CHAIN_ID)?.contracts.sponsor ?? null;
  } catch {
    sponsor = null;
  }
  const reads = createReadClient(CHAIN_ID, { timeout: 8_000, batch: false }) as unknown as StarterReadClient;
  const key = env.RELAYER_PRIVATE_KEY?.trim();
  let relayer: StarterWriteClient | null = null;
  if (key && /^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex, { nonceManager });
    const wallet = createWalletClient({
      account,
      chain: mezoChain(CHAIN_ID),
      transport: rpcTransport(CHAIN_ID, { timeout: 10_000, batch: false }),
    });
    relayer = {
      address: account.address,
      writeContract: (args) => wallet.writeContract(args as Parameters<typeof wallet.writeContract>[0]),
    };
  }
  return { sponsor, reads, relayer };
}

/* ---------- Vercel entry ---------- */

interface NodeRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  on?(event: string, cb: (chunk?: unknown) => void): void;
}

interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

async function readBody(req: NodeRequest): Promise<unknown> {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return null;
      }
    }
    return req.body;
  }
  if (!req.on) return null;
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    req.on!("data", (c) => chunks.push(String(c)));
    req.on!("end", () => resolve());
    req.on!("error", () => resolve());
  });
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    return null;
  }
}

function clientIp(req: NodeRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  const real = req.headers["x-real-ip"];
  return first || (Array.isArray(real) ? real[0] : real) || req.socket?.remoteAddress || "unknown";
}

let context: StarterContext | null = null;

export default async function handler(req: NodeRequest, res: NodeResponse): Promise<void> {
  let result: StarterResult;
  try {
    context ??= liveContext();
    result = await handleStarter({ method: req.method, body: await readBody(req), ip: clientIp(req) }, context);
  } catch (e) {
    console.error("starter: unexpected failure", e instanceof Error ? e.name : "unknown");
    result = fail(500, "Internal", "The starter-kit service failed. Try again in a minute.");
  }
  res.statusCode = result.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (result.status === 405) res.setHeader("allow", "POST");
  res.end(JSON.stringify(result.body));
}
