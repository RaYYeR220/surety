/**
 * Shared plumbing for the operator scripts that run Surety flows live on Mezo testnet (31611): the sending key, the
 * keeper's Executor with Mezo's gas rules, scrubbed output, and the deployment file's proof list
 * (`proof.txs`, entries `{ label, hash, block }`).
 *
 * The sending key is DEPLOYER_PRIVATE_KEY, from the environment or an --env-file. It is never printed: every line
 * written through `say` and every error passed to `runMain` is scrubbed of it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createMezoPublicClient,
  createSuretyClient,
  erc20Abi,
  explorerUrl,
  mezoTestnet,
  parseDeployment,
  type SuretyClient,
  type SuretyDeployment,
  type TxRequest,
} from "@surety/sdk";
import {
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  http,
  isHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Executor, gasLimitFor, type ContractCall } from "../../src/execute.js";
import { createLogger } from "../../src/log.js";
import { sleep } from "../../src/retry.js";

export const CHAIN_ID = 31611;
export const RPC = "https://rpc.test.mezo.org";
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/**
 * The v1 testnet deployment file, resolved from the built script in keeper/dist/scripts: the deployment these
 * scripts' recorded runs belong to. Pass --deployment contracts/deployments/31611.json for the current one.
 */
export const DEFAULT_DEPLOYMENT = fileURLToPath(new URL("../../../contracts/deployments/v1/31611.json", import.meta.url));

/* Output */

const secrets: string[] = [];

export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join("[redacted]");
    const bare = s.startsWith("0x") ? s.slice(2) : s;
    if (bare.length >= 8) out = out.split(bare).join("[redacted]");
  }
  return out;
}

export function say(text = ""): void {
  process.stdout.write(`${scrub(text)}\n`);
}

export function fmt(x: bigint, dp = 2, decimals = 18): string {
  const neg = x < 0n;
  const n = Number(formatUnits(neg ? -x : x, decimals));
  return `${neg ? "-" : ""}${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
export const musd = (x: bigint, dp = 2) => `${fmt(x, dp)} MUSD`;
export const btc = (x: bigint) => `${fmt(x, 6)} BTC`;
export const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
export const utc = (ts: bigint) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
export const hhmm = (ts: bigint) => `${utc(ts).slice(11, 16)} UTC`;
export const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/* Context */

export interface Ctx {
  pc: PublicClient;
  surety: SuretyClient;
  d: SuretyDeployment;
  me: Address;
  exec: Executor;
  /** Signs for `me`; used directly only to send a call that is meant to revert on chain. */
  wallet: WalletClient;
  rpc: string;
  deploymentPath: string;
  dryRun: boolean;
  /**
   * Hold every send until the keeper, which sends from the same address, is idle: outside the minutes around a
   * Surety epoch flip and with no transaction of the sender pending.
   */
  quiet: boolean;
}

export interface ProofEntry {
  label: string;
  hash: Hex;
  block: number;
  /** Set on a transaction that was sent to be refused on chain; absent on mined successes. */
  status?: "reverted";
  /** The custom error such a transaction reverted with. */
  reason?: string;
}

export interface Sent {
  hash: Hex;
  block: bigint;
  receipt: TransactionReceipt;
}

export interface ContextOptions {
  /** .env file holding DEPLOYER_PRIVATE_KEY (keep it outside the repository). */
  envFile?: string;
  deployment?: string;
  rpc?: string;
  dryRun: boolean;
  quiet?: boolean;
  /** Fields added to every Executor log line. */
  logFields?: Record<string, unknown>;
}

/**
 * Reads the 32-byte private key in the environment variable `name` and registers it for scrubbing. The key is never
 * printed, not even in the error for a malformed one.
 */
export function keyFromEnv(name: string): Hex {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is not set`);
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  secrets.push(key);
  if (!isHex(key) || key.length !== 66) throw new Error(`${name} must be a 32-byte hex key`);
  return key;
}

function signer(pc: PublicClient, rpc: string, key: Hex, dryRun: boolean, logFields: Record<string, unknown>) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http(rpc, { timeout: 30_000 }) });
  const log = createLogger({ level: "warn", secrets: [key] }, logFields);
  const exec = new Executor({
    publicClient: guardEstimates(pc),
    walletClient: wallet,
    account,
    dryRun,
    log,
    receiptTimeoutMs: 180_000,
  });
  return { me: account.address, wallet, exec };
}

/** Loads the sending key and the deployment, and builds the clients and the Executor. */
export function openContext(o: ContextOptions): Ctx {
  if (o.envFile) process.loadEnvFile(o.envFile);
  if (!process.env.DEPLOYER_PRIVATE_KEY?.trim()) throw new Error("DEPLOYER_PRIVATE_KEY is not set (pass --env-file)");
  const key = keyFromEnv("DEPLOYER_PRIVATE_KEY");

  const deploymentPath = o.deployment ?? DEFAULT_DEPLOYMENT;
  const d = parseDeployment(JSON.parse(readFileSync(deploymentPath, "utf8")));
  if (d.chainId !== CHAIN_ID) throw new Error(`${deploymentPath} is for chain ${d.chainId}, not ${CHAIN_ID}`);
  const rpc = o.rpc ?? RPC;
  const pc = createMezoPublicClient(CHAIN_ID, { rpcUrls: [rpc], timeout: 30_000 });
  const { me, wallet, exec } = signer(pc, rpc, key, o.dryRun, o.logFields ?? {});
  const surety = createSuretyClient({ chainId: CHAIN_ID, publicClient: pc, deployment: d });
  return { pc, surety, d, me, exec, wallet, rpc, deploymentPath, dryRun: o.dryRun, quiet: o.quiet ?? false };
}

/**
 * The same deployment, clients and proof file, sending from `key` instead. For scripts that act as several
 * accounts; `quiet` is off unless asked for, since only the keeper's own address races the keeper.
 */
export function withSender(
  base: Ctx,
  key: Hex,
  o: { quiet?: boolean; logFields?: Record<string, unknown> } = {},
): Ctx {
  const { me, wallet, exec } = signer(base.pc, base.rpc, key, base.dryRun, o.logFields ?? {});
  return { ...base, me, wallet, exec, quiet: o.quiet ?? false };
}

/** Runs a script's main, reporting a failure as one scrubbed line and exit code 1. */
export function runMain(main: () => Promise<void>): void {
  // exitCode rather than exit(): exiting while sockets are closing can abort Node on Windows.
  main().catch((e: unknown) => {
    const err = e as { shortMessage?: string; message?: string };
    process.stderr.write(`${scrub(`error: ${err.shortMessage ?? err.message ?? String(e)}`)}\n`);
    process.exitCode = 1;
  });
}

/* Reads */

export async function rd<T>(
  c: Ctx,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
): Promise<T> {
  const params = { address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) };
  return (await c.pc.readContract(params as Parameters<PublicClient["readContract"]>[0])) as T;
}

export async function chainNow(c: Ctx): Promise<bigint> {
  return (await c.pc.getBlock({ blockTag: "latest" })).timestamp;
}

/** Start of the Surety epoch (the deployment's `epochLength`) holding `ts`. */
export function epochOf(c: Ctx, ts: bigint): bigint {
  const len = BigInt(c.d.epochLength);
  return ts - (ts % len);
}

/** Sleeps until the chain's latest block is at or past `ts`. */
export async function waitUntil(c: Ctx, ts: bigint, why: string): Promise<void> {
  let now = await chainNow(c);
  if (now >= ts) return;
  say(`  … waiting ${ts - now}s until ${utc(ts)} (${why})`);
  while (now < ts) {
    await sleep(Number(minB(ts - now, 30n)) * 1000);
    now = await chainNow(c);
  }
}

/* Proof file */

export function proofTxs(c: Ctx): ProofEntry[] {
  const raw = JSON.parse(readFileSync(c.deploymentPath, "utf8")) as { proof?: { txs?: ProofEntry[] } };
  return raw.proof?.txs ?? [];
}

export function lastProof(c: Ctx, label: string): ProofEntry | undefined {
  return proofTxs(c).filter((t) => t.label === label).at(-1);
}

/** Writes the deployment file as it is kept in the repository: two-space JSON, non-ASCII characters escaped. */
function writeDeployment(path: string, raw: unknown): void {
  const json = JSON.stringify(raw, null, 2).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  writeFileSync(path, `${json}\n`);
}

/** Appends a mined transaction to `proof.txs`, keeping the rest of the file as it is. */
export function record(c: Ctx, entry: ProofEntry): void {
  const raw = JSON.parse(readFileSync(c.deploymentPath, "utf8")) as { proof?: { txs?: ProofEntry[] } };
  raw.proof ??= { txs: [] };
  raw.proof.txs ??= [];
  if (!raw.proof.txs.some((t) => t.hash === entry.hash)) raw.proof.txs.push(entry);
  writeDeployment(c.deploymentPath, raw);
}

/** Replaces the label of the recorded transaction `hash`. */
export function relabel(c: Ctx, hash: Hex, label: string): void {
  const raw = JSON.parse(readFileSync(c.deploymentPath, "utf8")) as { proof?: { txs?: ProofEntry[] } };
  const entry = raw.proof?.txs?.find((t) => t.hash === hash);
  if (!entry) return;
  entry.label = label;
  writeDeployment(c.deploymentPath, raw);
}

/* Sending */

/**
 * The public client the Executor estimates with, fixed for Mezo. With a local (signing) account viem prepares the
 * request through `eth_fillTransaction`, and Mezo's node fills a gas limit that can be just the intrinsic gas: a
 * CreditVoter vote came back at 22,348 where `eth_estimateGas` says 326,857, and the vote ran out of gas. So this
 * estimates with the sender's address (plain `eth_estimateGas`), then checks the estimate with an eth_call at exactly
 * the limit the Executor will send (estimate x 1.3), re-estimating while that call fails.
 */
export function guardEstimates(pc: PublicClient): PublicClient {
  const estimateContractGas = async (params: Parameters<PublicClient["estimateContractGas"]>[0]) => {
    const p = params as unknown as {
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
      account: Address | { address: Address };
    };
    const from = typeof p.account === "string" ? p.account : p.account.address;
    const data = encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args ?? [] } as never);
    for (let attempt = 1; ; attempt++) {
      const estimate = await pc.estimateContractGas({ ...params, account: from } as typeof params);
      const gas = gasLimitFor(estimate);
      try {
        await pc.call({ account: from, to: p.address, data, gas });
        return estimate;
      } catch (e) {
        if (attempt >= 5) throw new Error(`${p.functionName}: every gas estimate reverts at estimate x 1.3 (${gas})`);
        say(`  ! ${p.functionName}: estimate ${estimate} reverts at limit ${gas}; re-estimating (${attempt})`);
        await sleep(3_000);
      }
    }
  };
  return { ...pc, estimateContractGas } as PublicClient;
}

/** The keeper sends its pokes, rebalance and covers in the first minutes after each Surety epoch flip. */
const KEEPER_BUSY_AFTER_FLIP = 300n;
const KEEPER_BUSY_BEFORE_FLIP = 60n;

/**
 * Waits until a send cannot race the keeper for a nonce: outside the minutes around a Surety epoch flip, and with
 * no transaction of the sender still pending.
 */
export async function awaitQuietSender(c: Ctx): Promise<void> {
  const len = BigInt(c.d.epochLength);
  for (let attempt = 0; ; attempt++) {
    const now = await chainNow(c);
    const start = epochOf(c, now);
    if (now - start < KEEPER_BUSY_AFTER_FLIP) {
      await waitUntil(c, start + KEEPER_BUSY_AFTER_FLIP, "the keeper sends right after each epoch flip");
      continue;
    }
    if (start + len - now <= KEEPER_BUSY_BEFORE_FLIP) {
      await waitUntil(c, start + len + KEEPER_BUSY_AFTER_FLIP, "the keeper sends right after each epoch flip");
      continue;
    }
    const [latest, pending] = await Promise.all([
      c.pc.getTransactionCount({ address: c.me, blockTag: "latest" }),
      c.pc.getTransactionCount({ address: c.me, blockTag: "pending" }),
    ]);
    if (latest === pending) return;
    if (attempt >= 60) throw new Error(`the sender has had a transaction pending for 5 minutes (nonce ${latest})`);
    if (attempt === 0) say(`  … waiting for the sender's pending transaction (nonce ${latest}) to land`);
    await sleep(5_000);
  }
}

/** Simulates, sends with gas = estimate x 1.3, waits, and records the transaction. Null when skipped or dry-run. */
export async function send(
  c: Ctx,
  label: string,
  call: ContractCall,
  options: { skipIfResult?: (result: unknown) => boolean } = {},
): Promise<Sent | null> {
  if (c.quiet && !c.dryRun) await awaitQuietSender(c);
  const r = await c.exec.run(label, call, {}, options);
  switch (r.status) {
    case "skipped":
      say(`  · ${label}: nothing to do (simulated result ${String(r.result)})`);
      return null;
    case "simulated":
      say(`  · ${label}: simulated only (dry run), result ${String(r.result)}`);
      return null;
    case "reverted":
      throw new Error(`${label}: simulation reverted (${r.reason})`);
    case "failed":
      throw new Error(`${label}: ${r.hash} reverted on chain; diagnose with: cast run ${r.hash} --rpc-url ${RPC}`);
  }
  const receipt = await c.pc.waitForTransactionReceipt({ hash: r.hash, timeout: 180_000 });
  record(c, { label, hash: r.hash, block: Number(receipt.blockNumber) });
  say(`  + ${label}`);
  say(`      ${explorerUrl(CHAIN_ID, "tx", r.hash)}  (block ${receipt.blockNumber}, gas ${r.gasUsed}/${r.gasLimit})`);
  return { hash: r.hash, block: receipt.blockNumber, receipt };
}

/** Sends an SDK-built transaction: decoded back into a contract call so the Executor can simulate it. */
export async function sendBuilt(
  c: Ctx,
  label: string,
  tx: TxRequest,
  abi: Abi,
  options: { skipIfResult?: (result: unknown) => boolean } = {},
): Promise<Sent | null> {
  const { functionName, args } = decodeFunctionData({ abi, data: tx.data });
  return send(c, label, { address: tx.to, abi, functionName, args: args ?? [] }, options);
}

/** The custom error (or revert string) a call reverts with now, or null if it succeeds. */
export async function revertReason(c: Ctx, call: ContractCall, blockNumber?: bigint): Promise<string | null> {
  try {
    await c.pc.simulateContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args ?? [],
      account: c.me,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    } as Parameters<PublicClient["simulateContract"]>[0]);
    return null;
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string; walk?: (fn: (x: unknown) => boolean) => unknown };
    const revert = err.walk?.((x) => (x as { name?: string }).name === "ContractFunctionRevertedError") as
      | { data?: { errorName?: string }; reason?: string }
      | undefined;
    if (revert?.data?.errorName) return revert.data.errorName;
    if (revert?.reason) return revert.reason;
    throw e; // not a revert: an RPC failure
  }
}

/**
 * Sends a call that must be refused, so the refusal itself is on chain: it is simulated first and sent only if it
 * reverts with `expected`; then it is signed with an explicit gas limit (nothing estimates it) and sent raw. The mined
 * transaction is recorded with status "reverted" and its reason, read again at the block before it. Null in a dry run.
 */
export async function sendRefused(
  c: Ctx,
  label: string,
  call: ContractCall,
  expected: string,
  gas: bigint,
): Promise<{ hash: Hex; block: bigint; reason: string } | null> {
  const reason = await revertReason(c, call);
  if (reason !== expected) {
    throw new Error(`${label}: expected the call to revert with ${expected}, it ${reason ? `reverts with ${reason}` : "succeeds"}`);
  }
  if (c.dryRun) {
    say(`  · ${label}: reverts with ${reason} (dry run, not sent)`);
    return null;
  }
  const account = c.wallet.account;
  if (!account?.signTransaction) throw new Error(`${label}: the sender cannot sign locally`);
  const [nonce, gasPrice] = await Promise.all([
    c.pc.getTransactionCount({ address: c.me, blockTag: "pending" }),
    c.pc.getGasPrice(),
  ]);
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as never);
  const serializedTransaction = await account.signTransaction({
    chainId: CHAIN_ID,
    type: "legacy",
    to: call.address,
    data,
    gas,
    gasPrice,
    nonce,
  });
  const hash = await c.pc.sendRawTransaction({ serializedTransaction });
  const receipt = await c.pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status === "success") throw new Error(`${label}: ${hash} was meant to revert but succeeded`);
  const onChain = (await revertReason(c, call, receipt.blockNumber - 1n)) ?? reason;
  record(c, { label, hash, block: Number(receipt.blockNumber), status: "reverted", reason: onChain });
  say(`  x ${label}`);
  say(
    `      ${explorerUrl(CHAIN_ID, "tx", hash)}  (block ${receipt.blockNumber}, reverted: ${onChain}, ` +
      `gas ${receipt.gasUsed}/${gas})`,
  );
  return { hash, block: receipt.blockNumber, reason: onChain };
}

export async function ensureAllowance(c: Ctx, token: Address, spender: Address, amount: bigint, label: string): Promise<void> {
  const current = await rd<bigint>(c, token, erc20Abi, "allowance", [c.me, spender]);
  if (current >= amount) {
    say(`  · ${label}: allowance already ${fmt(current, 4)}`);
    return;
  }
  await sendBuilt(c, label, c.surety.buildApprove({ token, spender, amount }), erc20Abi);
}
