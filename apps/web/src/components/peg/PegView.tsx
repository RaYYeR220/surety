"use client";

import type { PegSourceReading, PegView as Peg } from "@surety/sdk";
import type { CSSProperties } from "react";

import { V2Notice } from "@/components/gate/V2Notice";
import { Split, Stack } from "@/components/layout/Layout";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { Empty, FactList, KeyValues, Muted, Notice, PageHead, Pill, Skeleton, Stat } from "@/components/ui/Bits";
import { Card } from "@/components/ui/Card";
import { DataTable, ExplorerLink, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, formatPegUsd, formatUsd, formatUsdWad } from "@/lib/format";
import { ISSUE_TEXT, pegChartDomain, SOURCE_KINDS, sourceKindName } from "@/lib/peg";
import { isV2, usePeg } from "@/lib/queries";

import { DepegSimulator } from "./DepegSimulator";
import { PegBadge } from "./PegBadge";
import styles from "./Peg.module.css";

export function PegPage() {
  return <EnvGate>{(env) => <PegView env={env} />}</EnvGate>;
}

function PegView({ env }: { env: ReadyEnv }) {
  const peg = usePeg();
  const v2 = isV2(env);
  return (
    <Stack gap={6}>
      <PageHead
        title="MUSD peg"
        lead="Surety prices MUSD from Mezo's own pools. While MUSD holds its peg the veBTC line lends; when it slips, or the sources disagree, new loans and new allocations stop until it recovers."
        actions={v2 ? <PegBadge linked={false} /> : undefined}
      />
      {!v2 ? (
        <V2Notice what="The MUSD peg check">
          {`${env.chainName} still runs Surety's first deployment, which values MUSD at exactly $1. The peg check, its breaker and the depeg switch go live with the v2 deployment.`}
        </V2Notice>
      ) : peg.error ? (
        <ReadError what="the MUSD peg" error={peg.error} onRetry={() => void peg.refetch()} />
      ) : !peg.data ? (
        <Stack gap={5}>
          <Skeleton height={180} label="Reading the MUSD peg" />
          <Skeleton height={240} />
        </Stack>
      ) : (
        <>
          <PegStatus peg={peg.data} />
          <Sources peg={peg.data} />
          <Split main="1fr" side="1fr" gap={5}>
            <Breaker />
            <Pricing peg={peg.data} />
          </Split>
          <DepegSimulator env={env} peg={peg.data} />
        </>
      )}
    </Stack>
  );
}

/* ---------- Status ---------- */

function PegStatus({ peg }: { peg: Peg }) {
  const healthy = peg.healthyOnChain;
  return (
    <Card
      tone={healthy ? "default" : "danger"}
      eyebrow="Now"
      title={healthy ? "MUSD is on its peg: new loans are open" : "MUSD is off its peg: new loans are paused"}
      description={
        healthy
          ? `The median of ${peg.count} source${peg.count === 1 ? "" : "s"} sits within ${formatBps(peg.bandBps, 0)} of $1 and they agree within ${formatBps(peg.maxSpreadBps, 0)}.`
          : "The veBTC line refuses new loans and the allocator funds no line until the check passes again. Repaying, auctions and withdrawals keep working."
      }
    >
      <Stack gap={5}>
        <div className={styles.stats}>
          <Stat label="Median MUSD/USD" value={formatPegUsd(peg.medianWad)} size="lg" />
          <Stat
            label="Distance from $1"
            value={peg.offPegBps === null ? "—" : `${peg.offPegBps.toString()} bps`}
            hint={`Band ${peg.bandBps} bps`}
            tone={peg.issues.includes("off-peg") ? "danger" : undefined}
          />
          <Stat
            label="Spread"
            value={peg.spreadBps === null ? "—" : `${peg.spreadBps.toString()} bps`}
            hint={`Max ${peg.maxSpreadBps} bps`}
            tone={peg.issues.includes("sources-disagree") ? "danger" : undefined}
          />
          <Stat
            label="Sources answering"
            value={`${peg.count} of ${peg.sources.length}`}
            hint={`At least ${peg.minSources} needed`}
            tone={peg.issues.includes("too-few-sources") ? "danger" : undefined}
          />
        </div>
        <PegBand peg={peg} />
        {peg.issues.length ? (
          <Notice tone="danger" title="Why the check fails" role="status">
            <ul className={styles.issues}>
              {peg.issues.map((i) => (
                <li key={i}>{ISSUE_TEXT[i]}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div className={styles.onchain}>
          <Pill tone={peg.healthyOnChain ? "positive" : "danger"} dot>
            pegHealthy() {peg.healthyOnChain ? "true" : "false"}
          </Pill>
          {peg.allocatorGateOpen !== null ? (
            <Pill tone={peg.allocatorGateOpen ? "positive" : "danger"} dot>
              Allocator {peg.allocatorGateOpen ? "funds lines" : "funds no line"}
            </Pill>
          ) : null}
          <Muted small>
            Read from <ExplorerLink kind="address" value={peg.address} label="MusdPeg" />, the contract the line and the
            allocator ask.
          </Muted>
        </div>
      </Stack>
    </Card>
  );
}

/** Every reading on one axis around $1, with the band shaded and the median marked. */
function PegBand({ peg }: { peg: Peg }) {
  const { min, max } = pegChartDomain(peg);
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const band = peg.bandBps / 10_000;
  const median = peg.medianWad === null ? null : Number(peg.medianWad) / 1e18;
  const usable = peg.sources.filter((s): s is PegSourceReading & { musdUsdWad: bigint } => s.musdUsdWad !== null);
  const label = `Readings ${usable.map((s) => `${s.index + 1}: ${formatPegUsd(s.musdUsdWad)}`).join(", ")}; median ${formatPegUsd(peg.medianWad)}; healthy band from $${(1 - band).toFixed(4)} to $${(1 + band).toFixed(4)}.`;
  return (
    <div className={styles.chart}>
      <div className={styles.track} role="img" aria-label={label}>
        <span
          className={styles.zone}
          style={{ left: at(1 - band), width: `calc(${at(1 + band)} - ${at(1 - band)})` }}
          aria-hidden="true"
        />
        <span className={styles.par} style={{ left: at(1) }} aria-hidden="true" />
        {usable.map((s, k) => (
          <span
            key={s.index}
            className={styles.tick}
            data-row={k % 2}
            style={{ left: at(Number(s.musdUsdWad) / 1e18) } as CSSProperties}
            title={`${s.index + 1}. ${sourceKindName(s.kind)}: ${formatPegUsd(s.musdUsdWad)}`}
            aria-hidden="true"
          >
            <span className={styles.tickLabel}>{s.index + 1}</span>
          </span>
        ))}
        {median !== null ? (
          <span className={styles.median} style={{ left: at(median) }} aria-hidden="true" />
        ) : null}
      </div>
      <div className={styles.scale} aria-hidden="true">
        <span>${min.toFixed(3)}</span>
        <span style={{ left: at(1) }} className={styles.scalePar}>
          $1.000
        </span>
        <span>${max.toFixed(3)}</span>
      </div>
      <ul className={styles.legend}>
        <li>
          <span className={styles.legendZone} aria-hidden="true" /> Healthy band, $1 ± {formatBps(peg.bandBps, 1)}
        </li>
        <li>
          <span className={styles.legendTick} aria-hidden="true" /> A source&apos;s reading (numbered as below)
        </li>
        <li>
          <span className={styles.legendMedian} aria-hidden="true" /> Median
        </li>
      </ul>
    </div>
  );
}

/* ---------- Sources ---------- */

function Sources({ peg }: { peg: Peg }) {
  const columns: Column<PegSourceReading>[] = [
    { key: "n", header: "#", cell: (s) => <span className="num">{s.index + 1}</span> },
    {
      key: "kind",
      header: "Source",
      cell: (s) => (
        <span className={styles.source}>
          <span className={styles.sourceName}>{sourceKindName(s.kind)}</span>
          {s.kind ? <Muted small>{SOURCE_KINDS[s.kind].detail}</Muted> : null}
        </span>
      ),
    },
    {
      key: "reading",
      header: "Reading",
      align: "end",
      cell: (s) => (s.musdUsdWad === null ? <Muted small>No reading</Muted> : <span className="num">{formatPegUsd(s.musdUsdWad)}</span>),
    },
    {
      key: "ok",
      header: "Status",
      cell: (s) =>
        s.ok ? (
          <Pill tone="positive" dot>
            Counts
          </Pill>
        ) : (
          <Pill tone="warning" dot>
            Not ok
          </Pill>
        ),
    },
    {
      key: "pool",
      header: "Pool",
      align: "end",
      cell: (s) => (s.pool ? <ExplorerLink kind="address" value={s.pool} /> : <Muted small>—</Muted>),
    },
    { key: "address", header: "Contract", align: "end", cell: (s) => <ExplorerLink kind="address" value={s.address} /> },
  ];
  return (
    <Card
      flat
      title="Sources"
      description={`MusdPeg takes the median of the sources that answer. It needs ${peg.minSources} of ${peg.sources.length}; a source that cannot read its market reports “not ok” instead of a price.`}
    >
      {peg.sources.length === 0 ? (
        <div className={styles.pad}>
          <Empty title="No sources">This peg lists no sources, so it never reports healthy.</Empty>
        </div>
      ) : (
        <DataTable columns={columns} rows={peg.sources} rowKey={(s) => s.address} caption="MUSD/USD sources" />
      )}
    </Card>
  );
}

/* ---------- What the breaker does ---------- */

function Breaker() {
  return (
    <Card title="What the breaker does" description="It stops new risk and nothing else.">
      <Stack gap={4}>
        <div>
          <p className={styles.listHead}>Stops while the peg is unhealthy</p>
          <FactList
            items={[
              <>Opening a veBTC loan and borrowing more: both revert with PegUnhealthy.</>,
              <>New allocations: a rebalance moves no fresh MUSD into any line. Overweight lines still hand MUSD back.</>,
            ]}
          />
        </div>
        <div>
          <p className={styles.listHead}>Keeps working</p>
          <FactList
            items={[
              <>Repaying, in part or in full, and harvesting rewards into repayment.</>,
              <>Starting auctions and bidding, so bad loans still clear.</>,
              <>Deposits, withdrawals and the share market.</>,
              <>The escrow&apos;s Mezo votes and its fee, bribe and rebase claims.</>,
            ]}
          />
        </div>
      </Stack>
    </Card>
  );
}

/* ---------- How the price feeds collateral ---------- */

function Pricing({ peg }: { peg: Peg }) {
  const median = peg.available ? peg.medianWad : null;
  const divisor = median !== null && median > 10n ** 18n ? median : 10n ** 18n;
  return (
    <Card title="How the peg prices collateral" description="BTC in MUSD = BTC/USD ÷ max(MUSD/USD, $1).">
      <Stack gap={4}>
        <div className={styles.formula} aria-label="Collateral price">
          <span>
            <Muted small>BTC/USD</Muted>
            <strong className="num">{formatUsd(peg.btcUsdWad)}</strong>
          </span>
          <span className={styles.op} aria-hidden="true">
            ÷
          </span>
          <span>
            <Muted small>max(MUSD/USD, $1)</Muted>
            <strong className="num">{formatPegUsd(divisor)}</strong>
          </span>
          <span className={styles.op} aria-hidden="true">
            =
          </span>
          <span>
            <Muted small>BTC in MUSD</Muted>
            <strong className="num">{formatUsdWad(peg.btcMusdWad)}</strong>
          </span>
        </div>
        <FactList
          items={[
            <>A MUSD above $1 lowers what the collateral is worth. A MUSD below $1 is ignored, so BTC is never valued above its dollar price.</>,
            <>
              The median counts whenever at least {peg.minSources} source{peg.minSources === 1 ? "" : "s"} answer;
              with fewer, MUSD counts as $1, so liquidations keep working through an outage.
            </>,
            <>New loans also need the peg healthy; the price alone never opens them.</>,
          ]}
        />
        <KeyValues
          label="Price sources"
          items={[
            { label: "BTC/USD", value: "Skip on Mezo, staleness-checked" },
            { label: "MUSD/USD", value: `Median of ${peg.sources.length} Mezo source${peg.sources.length === 1 ? "" : "s"}` },
          ]}
        />
      </Stack>
    </Card>
  );
}
