"use client";

// /app/try: from nothing to a real testnet loan with no wallet. A key kept in this browser signs, a starter kit
// from the testnet Sponsor pays for everything, and a short path walks through the product pages (borrow, see the
// escrow, auto-repay, vote the escrowed veBTC, repay). The pages themselves do the work; this one only tracks
// where the visitor is.
import { erc20Abi, MEZO_TESTNET_ID, type LoanView, type VeBTCPosition } from "@surety/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";

import { Cluster, Stack } from "@/components/layout/Layout";
import { EnvGate } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { KeyValues, Muted, Notice, PageHead, Pill, SectionTitle } from "@/components/ui/Bits";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog, ExplorerLink } from "@/components/ui/Controls";
import { BURNER_ID, createBurnerKey, resetBurnerKey, useBurnerKey, type BurnerKey } from "@/lib/burner";
import { useSurety, type ReadyEnv } from "@/lib/env";
import { explainError } from "@/lib/errors";
import { formatBtc, formatMusd } from "@/lib/format";

import styles from "./Try.module.css";

const FAUCET_URL = "https://faucet.test.mezo.org/";

type StarterReply =
  | { ok: true; hash: Hex; tokenId: string | null; confirmed: boolean; explorer: string }
  | { ok: false; code: string; error: string };

type Flow =
  | { s: "idle" }
  | { s: "working"; what: string }
  | { s: "sent"; hash: Hex; tokenId: string | null; confirmed: boolean }
  | { s: "error"; message: string };

export function TryPage() {
  const env = useSurety();
  const chosen = useRef(false);
  // The try-out runs on testnet: arriving here selects it (and the choice is remembered).
  useEffect(() => {
    if (chosen.current || env.demo) return;
    chosen.current = true;
    if (env.chainId !== MEZO_TESTNET_ID) env.selectChain(MEZO_TESTNET_ID);
  }, [env]);
  return <EnvGate>{(ready) => <TryView env={ready} />}</EnvGate>;
}

interface KitState {
  btc: bigint | null;
  musd: bigint | null;
  positions: VeBTCPosition[];
  loans: LoanView[];
  claimed: boolean | null;
}

const SPONSOR_CLAIMED_ABI = [
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** What the key holds and has done: balances, veBTC, loans, and whether it claimed its kit. */
function useKitState(env: ReadyEnv, address: Address | null) {
  const sponsor = env.deployment.contracts.sponsor ?? null;
  return useQuery({
    queryKey: [...env.scope, "try", address ?? "-"],
    enabled: !!address && env.mode === "live",
    refetchInterval: 20_000,
    queryFn: async (): Promise<KitState> => {
      const a = address!;
      const pc = env.client.publicClient;
      const [btc, musd, positions, loans, claimed] = await Promise.all([
        pc.getBalance({ address: a }).catch(() => null),
        pc
          .readContract({ address: env.deployment.external.musd, abi: erc20Abi, functionName: "balanceOf", args: [a] })
          .catch(() => null),
        env.client.getVeBTCPositions(a).catch(() => [] as VeBTCPosition[]),
        env.client.getLoans(a).catch(() => [] as LoanView[]),
        sponsor
          ? pc.readContract({ address: sponsor, abi: SPONSOR_CLAIMED_ABI, functionName: "claimed", args: [a] }).catch(() => null)
          : Promise.resolve(null),
      ]);
      return { btc, musd: musd as bigint | null, positions, loans, claimed };
    },
  });
}

function TryView({ env }: { env: ReadyEnv }) {
  const key = useBurnerKey();
  const { isConnected, connector } = useAccount();
  const connectors = useConnectors();
  const burner = connectors.find((c) => c.id === BURNER_ID);
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const queryClient = useQueryClient();
  const wallet = useWalletDialog();
  const [flow, setFlow] = useState<Flow>({ s: "idle" });
  const [confirmReset, setConfirmReset] = useState(false);

  const usingKey = isConnected && connector?.id === BURNER_ID;
  const otherWallet = isConnected && !usingKey;
  const sponsor = env.deployment.contracts.sponsor ?? null;
  const kit = useKitState(env, key?.address ?? null);
  const onTestnet = env.chainId === MEZO_TESTNET_ID;

  const connectKey = async (k: BurnerKey | null = key) => {
    if (!burner || !k) return;
    if (otherWallet) await disconnectAsync();
    if (!usingKey) await connectAsync({ connector: burner, chainId: MEZO_TESTNET_ID });
  };

  const requestKit = async (address: Address) => {
    setFlow({ s: "working", what: "Sending your starter kit from the testnet Sponsor…" });
    let reply: StarterReply | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/starter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      status = res.status;
      reply = (await res.json().catch(() => null)) as StarterReply | null;
    } catch {
      reply = null;
    }
    if (!reply) {
      setFlow({
        s: "error",
        message:
          status === 404
            ? "The starter-kit service is not available on this copy of the site."
            : "The starter-kit service did not answer. Try again in a minute.",
      });
      return;
    }
    if (!reply.ok) {
      setFlow({ s: "error", message: reply.error });
      if (reply.code === "AlreadyClaimed") void queryClient.invalidateQueries({ queryKey: env.scope });
      return;
    }
    setFlow({ s: "sent", hash: reply.hash, tokenId: reply.tokenId, confirmed: reply.confirmed });
    if (!reply.confirmed) {
      await env.client.publicClient.waitForTransactionReceipt({ hash: reply.hash, timeout: 90_000 }).catch(() => null);
      setFlow({ s: "sent", hash: reply.hash, tokenId: reply.tokenId, confirmed: true });
    }
    void queryClient.invalidateQueries({ queryKey: env.scope });
  };

  /** One click from nothing: a key, connected, with its kit on the way. */
  const start = async () => {
    setFlow({ s: "working", what: "Creating a key in this browser…" });
    try {
      const k = await createBurnerKey();
      await connectKey(k);
      if (sponsor) await requestKit(k.address);
      else setFlow({ s: "idle" });
    } catch (e) {
      setFlow({ s: "error", message: explainError(e).title });
    }
  };

  const working = flow.s === "working";
  const data = kit.data;
  const hasKit = !!data && (data.claimed === true || data.positions.length > 0 || data.loans.length > 0);

  return (
    <Stack gap={6}>
      <PageHead
        title="Try Surety on testnet"
        lead="No wallet and nothing to install. A key kept in this browser signs for you, and a starter kit pays for everything: a little BTC for gas, a small veBTC lock to borrow against, and 50 test MUSD."
      />

      {!onTestnet ? (
        <Notice tone="warning" title="Your wallet is on Mezo Mainnet">
          The try-out runs on Mezo Testnet. Switch your wallet to testnet, or disconnect it to use a key kept in this
          browser.
        </Notice>
      ) : null}

      <div className={styles.grid}>
        <Card
          eyebrow="Step 1"
          title="A testnet key in this browser"
          description="It signs without prompts because it only ever holds test BTC and test MUSD. It is stored in this browser's storage, in plain text: never send real funds to it."
        >
          {key ? (
            <Stack gap={4}>
              <KeyValues
                label="Testnet key"
                items={[
                  { label: "Address", value: <ExplorerLink kind="address" value={key.address} full /> },
                  {
                    label: "Status",
                    value: usingKey ? (
                      <Pill tone="positive" dot>
                        Connected
                      </Pill>
                    ) : (
                      <Pill tone="outline">Not connected</Pill>
                    ),
                  },
                  data && { label: "BTC for gas", value: `${formatBtc(data.btc, 6)} BTC` },
                  data && { label: "Test MUSD", value: `${formatMusd(data.musd, 2)} MUSD` },
                  data && {
                    label: "veBTC",
                    value: data.positions.length
                      ? data.positions.map((p) => `#${p.tokenId.toString()}`).join(", ")
                      : "None in the wallet",
                  },
                ]}
              />
              <Cluster gap={3}>
                {!usingKey ? (
                  <Button onClick={() => void connectKey().catch((e) => setFlow({ s: "error", message: explainError(e).title }))}>
                    Use this key
                  </Button>
                ) : null}
                <KeyExport keyValue={key.privateKey} />
                <Button variant="quiet" onClick={() => setConfirmReset(true)}>
                  Reset key
                </Button>
              </Cluster>
            </Stack>
          ) : (
            <Stack gap={4}>
              <Button size="lg" loading={working} disabled={!onTestnet || otherWallet} onClick={() => void start()}>
                {sponsor ? "Create a key and get a starter kit" : "Create a testnet key"}
              </Button>
              <Muted small>
                Prefer your own wallet?{" "}
                <button type="button" className={styles.inlineLink} onClick={wallet.open}>
                  Connect it instead
                </button>
                .
              </Muted>
            </Stack>
          )}
        </Card>

        <Card
          eyebrow="Step 2"
          title="Starter kit"
          description="Sent once per wallet by the testnet Sponsor: BTC for gas, a veBTC lock owned by your key, and test MUSD."
        >
          <Stack gap={4}>
            {!sponsor ? (
              <Notice tone="info" title="Starter kits open with the next testnet deployment">
                Until then, fund the key with test BTC from the{" "}
                <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                  Mezo testnet faucet
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                and lock it as veBTC on Mezo to borrow against it.
              </Notice>
            ) : data?.claimed ? (
              <Notice tone="positive" title="Kit received">
                {data.positions.length
                  ? `veBTC #${data.positions[0]!.tokenId.toString()} is yours to borrow against.`
                  : "Its veBTC is in a loan escrow now."}
              </Notice>
            ) : (
              <Button
                variant={key ? "primary" : "secondary"}
                loading={working}
                disabled={!key || !usingKey || hasKit}
                onClick={() => key && void requestKit(key.address)}
              >
                Get a starter kit
              </Button>
            )}
            <FlowStatus flow={flow} />
          </Stack>
        </Card>
      </div>

      <section aria-labelledby="try-path">
        <Stack gap={4}>
          <SectionTitle id="try-path">Then, in about a minute</SectionTitle>
          <GuidedPath env={env} kit={data ?? null} ready={hasKit && usingKey} />
        </Stack>
      </section>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the testnet key?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmReset(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (usingKey) await disconnectAsync().catch(() => undefined);
                resetBurnerKey();
                setFlow({ s: "idle" });
                setConfirmReset(false);
              }}
            >
              Reset
            </Button>
          </>
        }
      >
        <p>
          This browser forgets the key. Whatever it holds stays on chain, out of reach unless you exported the key
          first. A new key can get a new starter kit.
        </p>
      </Dialog>
    </Stack>
  );
}

function FlowStatus({ flow }: { flow: Flow }) {
  return (
    <div className={styles.flow} aria-live="polite">
      {flow.s === "working" ? <Muted>{flow.what}</Muted> : null}
      {flow.s === "error" ? (
        <Notice tone="danger" role="alert">
          {flow.message}
        </Notice>
      ) : null}
      {flow.s === "sent" ? (
        <Notice tone={flow.confirmed ? "positive" : "info"} title={flow.confirmed ? "Starter kit arrived" : "Starter kit sent"}>
          {flow.tokenId ? `veBTC #${flow.tokenId}. ` : ""}
          Transaction <ExplorerLink kind="tx" value={flow.hash} />
          {flow.confirmed ? "" : " is confirming…"}
        </Notice>
      ) : null}
    </div>
  );
}

function KeyExport({ keyValue }: { keyValue: Hex }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button variant="secondary" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        {shown ? "Hide private key" : "Export key"}
      </Button>
      {shown ? (
        <div className={styles.keyBox}>
          <p className={styles.keyWarn}>Testnet key. Anyone with it controls this address; keep it to testnet.</p>
          <code className={styles.keyValue}>{keyValue}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(keyValue);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

type StepStatus = "done" | "next" | "later";

interface PathStep {
  title: string;
  why: string;
  href: string;
  cta: string;
  status: StepStatus;
  detail?: ReactNode;
}

type PathDraft = Omit<PathStep, "status"> & { done: boolean; blocked?: boolean };

function GuidedPath({ env, kit, ready }: { env: ReadyEnv; kit: KitState | null; ready: boolean }) {
  const loans = kit?.loans ?? [];
  const open = loans.find((l) => l.state === "Active" || l.state === "Auction") ?? null;
  const loan = open ?? loans[0] ?? null;
  const v2 = env.deployment.version === 2;
  const borrowed = loans.length > 0;
  const repaid = loans.some((l) => l.state === "Closed");

  const steps: PathDraft[] = [
    {
      title: "Borrow MUSD against the kit's veBTC",
      why: "The veBTC moves into a loan escrow of its own; the lock keeps running and stays yours.",
      href: "/app/borrow",
      cta: "Borrow",
      done: borrowed,
    },
    {
      title: "See the loan and its escrow",
      why: "Debt, LTV, the liquidation price, and the escrow contract that holds the NFT.",
      href: "/app/borrow",
      cta: "Open loans",
      done: borrowed,
      detail: loan ? (
        <>
          Loan #{loan.loanId.toString()} · escrow <ExplorerLink kind="address" value={loan.escrow} />
        </>
      ) : undefined,
    },
    {
      title: "Turn on auto-repay",
      why: "Anyone may then harvest the escrowed veBTC's rewards into repaying the loan.",
      href: "/app/borrow",
      cta: "Set auto-repay",
      done: !!loan?.autoRepay,
      blocked: !v2,
    },
    {
      title: "Vote the escrowed veBTC on Mezo",
      why: "The escrow can still vote Mezo's pools and claim fees and bribes while the loan is open.",
      href: "/app/borrow",
      cta: "Vote",
      done: false,
    },
    {
      title: "Repay",
      why: "Repaying in full closes the loan and hands the veBTC back.",
      href: "/app/borrow",
      cta: "Repay",
      done: repaid,
    },
  ];
  let nextGiven = !ready;
  const withStatus = steps.map((s): PathDraft & { status: StepStatus } => {
    let status: StepStatus = s.done ? "done" : "later";
    if (!s.done && !s.blocked && !nextGiven) {
      status = "next";
      nextGiven = true;
    }
    return { ...s, status };
  });

  return (
    <ol className={styles.path}>
      {withStatus.map((s, i) => (
        <li key={s.title} className={styles.step} data-status={s.status}>
          <span className={styles.stepNo} aria-hidden="true">
            {i + 1}
          </span>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>{s.title}</h3>
            <p className={styles.stepWhy}>{s.why}</p>
            {s.detail ? <p className={styles.stepDetail}>{s.detail}</p> : null}
            {s.blocked ? <Muted small>Arrives with the v2 contracts on testnet.</Muted> : null}
          </div>
          <div className={styles.stepSide}>
            <Pill tone={s.status === "done" ? "positive" : s.status === "next" ? "accent" : "outline"}>
              {s.status === "done" ? "Done" : s.status === "next" ? "Next" : "Later"}
            </Pill>
            <ButtonLink size="sm" variant={s.status === "next" ? "primary" : "secondary"} href={s.href}>
              {s.cta}
              <span className="sr-only">: {s.title}</span>
            </ButtonLink>
          </div>
        </li>
      ))}
    </ol>
  );
}
