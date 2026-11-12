// Who has used Surety: every wallet that sent a successful transaction to a Surety contract (the vault, the veBTC
// credit line, the voter, the share market), on every bundled deployment of a chain, plus every wallet the testnet
// Sponsor handed a starter kit to. Transactions come from the Mezo explorer's API (Blockscout), kits from the
// Sponsor's StarterKit events. Team wallets are marked from TEAM_WALLETS, never hidden. Shared by the build-time
// snapshot and the ledger page's refresh: viem, the SDK and fetch only.
import {
  creditVoterAbi,
  getDeployments,
  shareMarketAbi,
  vaultV2Abi,
  veBTCCreditLineAbi,
  veBTCCreditLineV1Abi,
  type SuretyClient,
  type SuretyDeployment,
} from "@surety/sdk";
import { getAddress, isAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";

/* ---------- Team wallets ---------- */

export interface TeamWallet {
  address: Address;
  label: string;
}

/**
 * Wallets run by the team. Their transactions are listed like any other, labelled as the team's. More can be added
 * without a code change through NEXT_PUBLIC_TEAM_WALLETS ("0xabc…:Label,0xdef…:Label").
 */
export const TEAM_WALLETS: TeamWallet[] = [
  { address: "0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282", label: "Deployer and keeper" },
  // The founder's own wallet: the first real MUSD through the v2 mainnet vault (2026-11-10 to 2026-11-12).
  { address: "0xF3B025ed707A50704f93658CA10797230AaFbC37", label: "Founder (mainnet)" },
  { address: "0x030E00FE424e98327332BC4f946975C4927c7DdC", label: "Starter-kit relayer" },
  // Role wallets of the v2 lifecycle run on testnet.
  { address: "0x38c4F040E1A6b76AB5F6d56A45612a79C565604c", label: "Lifecycle lender" },
  { address: "0x5EbAD5e82EC5FE57792708741Fb7CAeCb5a7296C", label: "Lifecycle borrower" },
  { address: "0x525f12EFb63D9373d7fd03E6eD93625C24930922", label: "Lifecycle voter" },
  { address: "0xa102BF713aD35F0B9A5b20CB75192F2f4a43274c", label: "Lifecycle sponsor" },
  { address: "0xE5D77eAa62c9E11345d308A2F0388a33e81592d7", label: "Lifecycle bidder" },
  { address: "0xDB3cDA1EE42010fA2eb230fbD6d97E4409A56f4d", label: "Lifecycle share buyer" },
  { address: "0xc69cb7b6d6238DDdF47323B0BC57E99BF040A87E", label: "Lifecycle keeper" },
  { address: "0x7e87dc50afA869D03444cD3304A2FE28cCf5759a", label: "Lifecycle starter-kit wallet" },
  ...parseTeamEnv(process.env.NEXT_PUBLIC_TEAM_WALLETS),
];

function parseTeamEnv(raw: string | undefined): TeamWallet[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().split(":"))
    .filter(([a]) => !!a && isAddress(a))
    .map(([a, label]) => ({ address: getAddress(a!), label: label?.trim() || "Team" }));
}

export function teamLabel(address: string): string | null {
  const a = address.toLowerCase();
  return TEAM_WALLETS.find((t) => t.address.toLowerCase() === a)?.label ?? null;
}

/* ---------- Shapes ---------- */

export interface LedgerAction {
  hash: Hex;
  /** Function name, decoded from the selector with the SDK's ABIs (the selector when unknown). */
  method: string;
  /** Which contract it went to ("Vault", "veBTC credit line", …). */
  contract: string;
  /** Seconds since epoch. */
  timestamp: number;
  blockNumber: number;
}

export interface LedgerWallet {
  address: Address;
  /** Team label, or null for an outside wallet. */
  team: string | null;
  first: LedgerAction | null;
  last: LedgerAction | null;
  /** Successful transactions to Surety contracts. */
  txCount: number;
  /** Contract names it has used. */
  contracts: string[];
  /** Deployment versions it has used. */
  versions: number[];
  /** The starter kit it received, if any. */
  kit: { tokenId: bigint; hash: Hex; blockNumber: bigint } | null;
}

export interface LedgerSource {
  label: string;
  address: Address;
  version: number;
  /** Successful transactions read. */
  txs: number;
  /** False when the scan stopped at the page cap or on an error. */
  complete: boolean;
}

export interface LedgerSnapshot {
  chainId: number;
  /** Wall-clock time of the read, ms. */
  asOf: number;
  wallets: LedgerWallet[];
  sources: LedgerSource[];
  /** Starter kits: null where no Sponsor is deployed. */
  kits: { issued: number; left: bigint | null; dailyLimit: number } | null;
  /** Latest successful transactions across the contracts, newest first. */
  recent: (LedgerAction & { from: Address })[];
  errors: string[];
}

export type LedgerSnapshots = Partial<Record<number, LedgerSnapshot>>;

/* ---------- Explorer ---------- */

const EXPLORER_API: Record<number, string> = {
  31612: "https://api.explorer.mezo.org/api/v2",
  31611: "https://api.explorer.test.mezo.org/api/v2",
};

/** Pages of 50 transactions read per contract at most. */
const MAX_PAGES = 20;

interface ExplorerTx {
  hash: Hex;
  from: { hash: string } | null;
  method: string | null;
  timestamp: string | null;
  block_number: number;
  result: string;
  raw_input?: string;
  transaction_types?: string[];
  created_contract?: { hash: string } | null;
}

interface ExplorerPage {
  items: ExplorerTx[];
  next_page_params: Record<string, string | number> | null;
}

type Fetch = typeof fetch;

const selectorNames = new Map<string, string>();
for (const abi of [vaultV2Abi, veBTCCreditLineAbi, veBTCCreditLineV1Abi, creditVoterAbi, shareMarketAbi] as Abi[]) {
  for (const item of abi) {
    if (item.type === "function") selectorNames.set(toFunctionSelector(item as AbiFunction), item.name);
  }
}

function methodName(tx: ExplorerTx): string {
  if (tx.created_contract || tx.transaction_types?.includes("contract_creation")) return "deployment";
  const selector = (tx.raw_input ?? "").slice(0, 10).toLowerCase();
  if (selector.length === 10 && selectorNames.has(selector)) return selectorNames.get(selector)!;
  const m = tx.method ?? "";
  if (/^0x[0-9a-f]{8}$/i.test(m)) return selectorNames.get(m.toLowerCase()) ?? m;
  return m || ((tx.raw_input ?? "0x") === "0x" ? "transfer" : "call");
}

async function readTransactions(
  chainId: number,
  address: Address,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<{ txs: ExplorerTx[]; complete: boolean }> {
  const base = EXPLORER_API[chainId];
  if (!base) throw new Error(`no explorer API for chain ${chainId}`);
  const txs: ExplorerTx[] = [];
  let params: Record<string, string | number> | null = { filter: "to" };
  for (let page = 0; page < MAX_PAGES && params; page++) {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    if (!q.has("filter")) q.set("filter", "to");
    const res = await fetchImpl(`${base}/addresses/${address}/transactions?${q}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (res.status === 404) return { txs, complete: true }; // an address the explorer has never seen
    if (!res.ok) throw new Error(`explorer answered ${res.status} for ${address}`);
    const body = (await res.json()) as ExplorerPage;
    txs.push(...body.items);
    params = body.next_page_params;
  }
  return { txs, complete: params === null };
}

/* ---------- Collection ---------- */

function contractsOf(d: SuretyDeployment): { label: string; address: Address }[] {
  const c = d.contracts;
  return [
    { label: "Vault", address: c.vault },
    { label: "veBTC credit line", address: c.veBTCLine },
    { label: "Voter", address: c.creditVoter },
    ...(c.shareMarket ? [{ label: "Share market", address: c.shareMarket }] : []),
  ];
}

export interface CollectLedgerOptions {
  /** SDK clients by deployment version, for the Sponsor's StarterKit events (v2 only). */
  clients?: Partial<Record<number, SuretyClient>>;
  fetchImpl?: Fetch;
  signal?: AbortSignal;
}

/** Reads the ledger of `chainId` across every deployment bundled for it. */
export async function collectLedger(chainId: number, options: CollectLedgerOptions = {}): Promise<LedgerSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deployments = getDeployments(chainId);
  const errors: string[] = [];
  const sources: LedgerSource[] = [];
  const actions: (LedgerAction & { from: Address; version: number })[] = [];

  const scans = deployments.flatMap((d) => contractsOf(d).map((c) => ({ ...c, version: d.version })));
  const results = await Promise.allSettled(
    scans.map((s) => readTransactions(chainId, s.address, fetchImpl, options.signal)),
  );
  results.forEach((r, i) => {
    const s = scans[i]!;
    if (r.status === "rejected") {
      errors.push(`${s.label} (v${s.version}): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      sources.push({ ...s, txs: 0, complete: false });
      return;
    }
    const ok = r.value.txs.filter((t) => t.result === "success" && t.from?.hash && isAddress(t.from.hash));
    sources.push({ ...s, txs: ok.length, complete: r.value.complete });
    for (const t of ok) {
      actions.push({
        hash: t.hash,
        method: methodName(t),
        contract: s.label,
        timestamp: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : 0,
        blockNumber: Number(t.block_number),
        from: getAddress(t.from!.hash),
        version: s.version,
      });
    }
  });

  // Starter kits: the Sponsor's own event log is the record of who received one.
  let kits: LedgerSnapshot["kits"] = null;
  const kitByUser = new Map<string, NonNullable<LedgerWallet["kit"]>>();
  for (const d of deployments) {
    if (!d.contracts.sponsor) continue;
    const client = options.clients?.[d.version];
    if (!client) continue;
    try {
      const ledger = await client.getSponsorLedger();
      kits = { issued: Number(ledger.kitsIssued), left: ledger.kitsLeft, dailyLimit: Number(ledger.dailyLimit) };
      for (const e of ledger.entries) {
        kitByUser.set(e.user.toLowerCase(), { tokenId: e.tokenId, hash: e.transactionHash, blockNumber: e.blockNumber });
      }
    } catch (e) {
      errors.push(`Starter kits (v${d.version}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }

  const byWallet = new Map<string, LedgerWallet>();
  const walletOf = (address: Address): LedgerWallet => {
    const key = address.toLowerCase();
    let w = byWallet.get(key);
    if (!w) {
      w = { address, team: teamLabel(address), first: null, last: null, txCount: 0, contracts: [], versions: [], kit: null };
      byWallet.set(key, w);
    }
    return w;
  };
  const byTime = [...actions].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber);
  for (const a of byTime) {
    const w = walletOf(a.from);
    const action: LedgerAction = {
      hash: a.hash,
      method: a.method,
      contract: a.contract,
      timestamp: a.timestamp,
      blockNumber: a.blockNumber,
    };
    w.first ??= action;
    w.last = action;
    w.txCount++;
    if (!w.contracts.includes(a.contract)) w.contracts.push(a.contract);
    if (!w.versions.includes(a.version)) w.versions.push(a.version);
  }
  for (const [user, kit] of kitByUser) {
    walletOf(getAddress(user)).kit = kit;
  }

  const wallets = [...byWallet.values()].sort((a, b) => {
    if (!!a.team !== !!b.team) return a.team ? 1 : -1; // outside wallets first
    return (a.first?.timestamp ?? Number.MAX_SAFE_INTEGER) - (b.first?.timestamp ?? Number.MAX_SAFE_INTEGER);
  });
  const recent = byTime
    .slice(-12)
    .reverse()
    .map((a) => ({
      hash: a.hash,
      method: a.method,
      contract: a.contract,
      timestamp: a.timestamp,
      blockNumber: a.blockNumber,
      from: a.from,
    }));

  return { chainId, asOf: Date.now(), wallets, sources, kits, recent, errors };
}

