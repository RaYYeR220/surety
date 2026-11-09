"use client";

// /app/ledger: every wallet that has used Surety, on both networks and every deployment, read from the Mezo
// explorer and the testnet Sponsor's StarterKit events. Team wallets are labelled, never hidden or left out, so
// the counts of outside wallets can be checked one row at a time.
import { explorerUrl, getDeployments, MEZO_MAINNET_ID, MEZO_TESTNET_ID, type SuretyClient } from "@surety/sdk";
import { useState, type ReactNode } from "react";

import { Grid, Stack } from "@/components/layout/Layout";
import { Empty, Muted, Notice, PageHead, Pill, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/Controls";
import { formatAsOf } from "@/lib/asOf";
import { CHAIN_NAMES } from "@/lib/chain";
import { formatDateTime, shortAddress, shortHash } from "@/lib/format";
import { collectLedger, TEAM_WALLETS, type LedgerSnapshot, type LedgerSnapshots, type LedgerWallet } from "@/lib/ledger";

import styles from "./Ledger.module.css";

function Ext({ chainId, kind, value, children }: { chainId: number; kind: "tx" | "address"; value: string; children?: ReactNode }) {
  return (
    <a className={styles.ext} href={explorerUrl(chainId, kind, value)} target="_blank" rel="noreferrer" title={value}>
      {children ?? (kind === "tx" ? shortHash(value) : shortAddress(value))}
      <span className="sr-only"> (opens the Mezo explorer)</span>
    </a>
  );
}

export function LedgerView({ initial }: { initial: LedgerSnapshots }) {
  const [ledgers, setLedgers] = useState<LedgerSnapshots>(initial);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<Partial<Record<number, string>>>({});

  const refresh = async (chainId: number) => {
    setBusy(chainId);
    setFailed((f) => ({ ...f, [chainId]: undefined }));
    try {
      const [{ liveClient }, { timeBox }] = await Promise.all([import("@/lib/live"), import("@/lib/rpc")]);
      const clients: Partial<Record<number, SuretyClient>> = {};
      for (const d of getDeployments(chainId)) clients[d.version] = liveClient(chainId, d);
      const next = await timeBox(collectLedger(chainId, { clients }), 30_000, "The explorer");
      setLedgers((l) => ({ ...l, [chainId]: next }));
    } catch (e) {
      setFailed((f) => ({ ...f, [chainId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap={6}>
      <PageHead
        title="Who uses Surety"
        lead="Every wallet that sent a successful transaction to a Surety contract (the vault, the veBTC credit line, the voter, the share market) or received a testnet starter kit, on both networks and on every deployment. Team wallets are labelled, not hidden."
      />
      {[MEZO_MAINNET_ID, MEZO_TESTNET_ID].map((chainId) => (
        <ChainLedger
          key={chainId}
          chainId={chainId}
          ledger={ledgers[chainId] ?? null}
          busy={busy === chainId}
          disabled={busy !== null}
          error={failed[chainId] ?? null}
          onRefresh={() => void refresh(chainId)}
        />
      ))}
      <Card title="Team wallets" headingLevel={2} description="Listed in the app's source (lib/ledger.ts); every other wallet counts as outside.">
        <ul className={styles.team}>
          {TEAM_WALLETS.map((t) => (
            <li key={t.address}>
              <span className={styles.mono}>{t.address}</span>
              <Muted>{t.label}</Muted>
            </li>
          ))}
        </ul>
      </Card>
    </Stack>
  );
}

function ChainLedger({
  chainId,
  ledger,
  busy,
  disabled,
  error,
  onRefresh,
}: {
  chainId: number;
  ledger: LedgerSnapshot | null;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const name = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
  const outside = ledger?.wallets.filter((w) => !w.team) ?? [];
  const team = ledger?.wallets.filter((w) => w.team) ?? [];
  const outsideTxs = outside.reduce((n, w) => n + w.txCount, 0);
  const headingId = `ledger-${chainId}`;

  return (
    <section className={styles.chain} aria-labelledby={headingId}>
      <div className={styles.chainHead}>
        <div>
          <h2 className={styles.chainTitle} id={headingId}>
            {name}
          </h2>
          <Muted small>
            {ledger ? `As of ${formatAsOf(ledger.asOf)}` : "Not read yet"} · from the Mezo explorer
            {chainId === MEZO_TESTNET_ID ? " and the Sponsor's StarterKit events" : ""}
          </Muted>
        </div>
        <Button size="sm" variant="secondary" loading={busy} disabled={disabled && !busy} onClick={onRefresh}>
          Refresh from the explorer
        </Button>
      </div>

      {error ? (
        <Notice tone="danger" role="alert" title="Could not refresh">
          {error}. The figures below are from {ledger ? formatAsOf(ledger.asOf) : "the last build"}.
        </Notice>
      ) : null}

      <Grid min="180px" gap={4}>
        <Stat label="Outside wallets" value={ledger ? outside.length : "—"} />
        <Stat label="Team wallets" value={ledger ? team.length : "—"} />
        <Stat label="Transactions by outside wallets" value={ledger ? outsideTxs : "—"} />
        {chainId === MEZO_TESTNET_ID ? (
          <Stat
            label="Starter kits handed out"
            value={ledger?.kits ? ledger.kits.issued : "—"}
            hint={ledger?.kits ? undefined : "Opens with the Sponsor on the next testnet deployment"}
          />
        ) : null}
      </Grid>

      {!ledger ? (
        <Empty title="No ledger read yet">Refresh to read it from the Mezo explorer.</Empty>
      ) : ledger.wallets.length === 0 ? (
        <Empty title={`No wallet has used Surety on ${name} yet`} />
      ) : (
        <DataTable<LedgerWallet>
          caption={`Wallets that used Surety on ${name}`}
          rowKey={(w) => w.address}
          rows={ledger.wallets}
          columns={[
            {
              key: "wallet",
              header: "Wallet",
              cell: (w) => <Ext chainId={chainId} kind="address" value={w.address} />,
            },
            {
              key: "who",
              header: "Who",
              cell: (w) => (w.team ? <Pill tone="outline">Team · {w.team}</Pill> : <Pill tone="accent">Outside</Pill>),
            },
            {
              key: "first",
              header: "First action",
              cell: (w) =>
                w.first ? (
                  <span className={styles.first}>
                    <span>
                      {w.first.method} on {w.first.contract}
                    </span>
                    <Muted small>
                      {w.first.timestamp ? formatDateTime(w.first.timestamp) : `block ${w.first.blockNumber}`} ·{" "}
                      <Ext chainId={chainId} kind="tx" value={w.first.hash} />
                    </Muted>
                  </span>
                ) : (
                  <Muted>Starter kit only</Muted>
                ),
            },
            { key: "txs", header: "Transactions", align: "end", cell: (w) => w.txCount },
            {
              key: "used",
              header: "Used",
              cell: (w) => (w.contracts.length ? `${w.contracts.join(", ")} (v${[...w.versions].sort().join(", v")})` : "—"),
            },
            ...(chainId === MEZO_TESTNET_ID
              ? [
                  {
                    key: "kit",
                    header: "Starter kit",
                    cell: (w: LedgerWallet) =>
                      w.kit ? (
                        <Ext chainId={chainId} kind="tx" value={w.kit.hash}>
                          veBTC #{w.kit.tokenId.toString()}
                        </Ext>
                      ) : (
                        "—"
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}

      {ledger && ledger.recent.length ? (
        <details className={styles.recent}>
          <summary>Latest transactions ({ledger.recent.length})</summary>
          <ol>
            {ledger.recent.map((a) => (
              <li key={a.hash}>
                <Muted small>{a.timestamp ? formatDateTime(a.timestamp) : `block ${a.blockNumber}`}</Muted>
                <span>
                  <Ext chainId={chainId} kind="address" value={a.from} /> · {a.method} on {a.contract}
                </span>
                <Ext chainId={chainId} kind="tx" value={a.hash} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {ledger ? (
        <p className={styles.sources}>
          Read:{" "}
          {ledger.sources
            .map((s) => `${s.label} v${s.version} (${s.txs} transactions${s.complete ? "" : ", partial"})`)
            .join(" · ")}
          .{ledger.errors.length ? ` Not read: ${ledger.errors.join("; ")}.` : ""}
        </p>
      ) : null}
    </section>
  );
}
