"use client";

import type { ExternalContracts, SuretyContracts } from "@surety/sdk";
import type { Address } from "viem";

import { Stack } from "@/components/layout/Layout";
import { EnvGate } from "@/components/shell/EnvGate";
import { Empty, KeyValues, LineName, Muted, Notice, PageHead, Pill, Stat } from "@/components/ui/Bits";
import { Card } from "@/components/ui/Card";
import { DataTable, ExplorerLink, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { epochCadence, kindLabel } from "@/lib/lines";
import { SECURITY_REPORT_PATH, SECURITY_REVIEW, sourcifyUrl, TEST_COUNTS } from "@/lib/proof";

import styles from "./Proof.module.css";

export function ProofPage() {
  return <EnvGate>{(env) => <ProofView env={env} />}</EnvGate>;
}

const SURETY: Record<keyof SuretyContracts, string> = {
  vault: "Surety vault (Morpho VaultV2, shares = srMUSD)",
  depositGate: "DepositGate: holds new srMUSD while a loss or its cover is pending",
  creditVoter: "CreditVoter: veBTC ballots per line and epoch, timelocked listing",
  voteAllocator: "VoteAllocator: moves vault capital to vote targets",
  suretyPool: "SuretyPool: reward cohorts, first loss, cover",
  veBTCLine: "VeBTCCreditLine: loans against locked veBTC",
  loanEscrowImpl: "LoanEscrow implementation (one clone per loan)",
  irmLine: "LinearKinkIrm of the veBTC line",
  morphoAdapter: "Morpho market adapter (Morpho's MorphoMarketV1AdapterV2)",
  morpho: "Morpho Blue",
  irm: "AdaptiveCurveIrm of the Morpho markets",
  priceSource: "Price source the lines value BTC with",
  skipSource: "Skip BTC/USD source (staleness-checked)",
  morphoOracle: "Morpho oracle over the price source",
};

const EXTERNAL: Record<keyof ExternalContracts, string> = {
  musd: "MUSD",
  btc: "BTC (ERC-20 precompile)",
  veBTC: "veBTC (vote-escrowed BTC NFT)",
  poolsVoter: "Mezo PoolsVoter",
  rewardsDistributor: "Mezo rewards distributor",
  skipAggregator: "Skip price oracle (precompile)",
};

interface Row {
  key: string;
  role: string;
  address: Address;
}

function ProofView({ env }: { env: ReadyEnv }) {
  const d = env.deployment;
  const demo = env.mode === "demo";
  const columns: Column<Row>[] = [
    { key: "role", header: "Contract", cell: (r) => r.role },
    { key: "address", header: "Address", align: "end", cell: (r) => <ExplorerLink kind="address" value={r.address} full /> },
  ];
  // Surety's own contracts are verified on Sourcify (exact match); link the source next to the address.
  const suretyColumns: Column<Row>[] = demo
    ? columns
    : [
        ...columns,
        {
          key: "source",
          header: "Source",
          align: "end",
          cell: (r) => (
            <a href={sourcifyUrl(d.chainId, r.address)} target="_blank" rel="noopener noreferrer">
              Sourcify<span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens the verified source of {r.role})</span>
            </a>
          ),
        },
      ];
  // Older deployments have no gate: list only what this one has.
  const surety: Row[] = (Object.keys(SURETY) as (keyof SuretyContracts)[]).flatMap((k) => {
    const address = d.contracts[k];
    return address ? [{ key: k, role: SURETY[k], address }] : [];
  });
  const external: Row[] = (Object.keys(EXTERNAL) as (keyof ExternalContracts)[]).map((k) => ({
    key: k,
    role: EXTERNAL[k],
    address: d.external[k],
  }));
  const txs = d.proof.txs.map((t, i) => ({ ...t, n: i + 1 }));

  return (
    <Stack gap={6}>
      <PageHead
        title="Proof"
        lead={`Every contract Surety runs on ${env.chainName}, with verified source and explorer links, the transactions that show the mechanism working on chain, and what the security review found.`}
      />
      {demo ? (
        <Notice tone="info" title="Example addresses">
          These come from the SDK&apos;s test fixture. They are not real contracts, so they have no explorer links.
        </Notice>
      ) : null}
      <Card title="Deployment">
        <KeyValues
          label="Deployment"
          items={[
            { label: "Network", value: `${env.chainName} (chain ${d.chainId})` },
            { label: "Deployed at block", value: <ExplorerLink kind="block" value={d.deployedAt.toString()} label={d.deployedAt.toString()} /> },
            { label: "Epochs", value: `${d.epochLength} s (${epochCadence(BigInt(d.epochLength))})` },
            { label: "Surety contracts", value: surety.length.toString() },
            { label: "Credit lines", value: d.lines.length.toString() },
          ]}
        />
      </Card>
      <Card
        flat
        title="Surety contracts"
        description={demo ? undefined : `All ${surety.length} are verified source on Sourcify (exact match).`}
      >
        <DataTable columns={suretyColumns} rows={surety} rowKey={(r) => r.key} caption="Surety contracts" />
      </Card>
      <Card flat title="Mezo contracts it uses" description="Surety reads and calls these; it does not own them.">
        <DataTable columns={columns} rows={external} rowKey={(r) => r.key} caption="External contracts" />
      </Card>
      <Card flat title="Credit lines">
        <DataTable
          caption="Credit lines"
          rowKey={(l) => l.id.toString()}
          rows={d.lines}
          columns={[
            { key: "line", header: "Line", cell: (l) => <LineName id={l.id} name={l.name} /> },
            { key: "kind", header: "Kind", cell: (l) => kindLabel(l.kind) },
            { key: "adapter", header: "Adapter", align: "end", cell: (l) => <ExplorerLink kind="address" value={l.adapter} /> },
            {
              key: "market",
              header: "Morpho market id",
              align: "end",
              cell: (l) => (l.marketId ? <span className="num" title={l.marketId}>{`${l.marketId.slice(0, 10)}…${l.marketId.slice(-6)}`}</span> : "—"),
            },
          ]}
        />
      </Card>
      <Card
        flat
        title="Proof transactions"
        description={
          txs.length === 0
            ? "Each one is a step of the lifecycle, executed on chain."
            : `${txs.length} lifecycle step${txs.length === 1 ? "" : "s"} executed on chain so far, in the order they ran.`
        }
      >
        {txs.length === 0 ? (
          <div style={{ padding: "0 var(--space-5) var(--space-5)" }}>
            <Empty title="Not published yet">
              The lifecycle runs (deposit, vote, rebalance, loan, price shock, auction, cover, claim) are listed here with
              explorer links once they are recorded in the deployment file.
            </Empty>
          </div>
        ) : (
          <ol className={styles.txs} aria-label="Proof transactions">
            {txs.map((t) => (
              <li key={t.hash} className={styles.tx}>
                <span className={styles.step}>{t.n}</span>
                <span className={styles.txLabel}>{t.label}</span>
                <span className={styles.txHash}>
                  <ExplorerLink kind="tx" value={t.hash} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <SecurityReview />
      <Card title="Tests">
        <Stack gap={3}>
          <KeyValues
            label="Tests"
            items={[
              { label: "Contracts (Foundry), all suites", value: TEST_COUNTS.foundry.toString() },
              {
                label: `Of those, invariants (${TEST_COUNTS.invariantRuns} runs × ${TEST_COUNTS.invariantDepth} calls)`,
                value: TEST_COUNTS.invariants.toString(),
              },
              { label: "Of those, security review regressions", value: TEST_COUNTS.regression.toString() },
              { label: "SDK, keeper and MCP (TypeScript)", value: TEST_COUNTS.typescript.toString() },
            ]}
          />
          <Muted small>
            The Foundry suites are unit, fuzz, integration, invariant and live-Mezo fork tests. Each regression test
            replays a review finding&apos;s attack and checks it no longer works. Run them with forge test in contracts/
            and pnpm test at the repository root.
          </Muted>
        </Stack>
      </Card>
    </Stack>
  );
}

function SecurityReview() {
  const { counts, findings } = SECURITY_REVIEW;
  const fixed = findings.filter((f) => f.status === "fixed").length;
  return (
    <Card
      title="Security review"
      description={`An independent review of the contracts and the deploy script before mainnet found no critical or high issues. Of its ${findings.length} medium and low findings, ${fixed} are fixed in code and ${findings.length - fixed} is handled by the keeper.`}
    >
      <Stack gap={5}>
        <div className={styles.counts}>
          <Stat size="sm" label="Critical" value={counts.critical} />
          <Stat size="sm" label="High" value={counts.high} />
          <Stat size="sm" label="Medium" value={counts.medium} hint="All fixed" />
          <Stat size="sm" label="Low" value={counts.low} hint={`${counts.low - (findings.length - fixed)} fixed, ${findings.length - fixed} mitigated`} />
        </div>
        <ol className={styles.findings} aria-label="Findings and fixes">
          {findings.map((f) => (
            <li key={f.id} className={styles.finding}>
              <span className={styles.findingId}>
                <span className={styles.id}>{f.id}</span>
                <Pill tone={f.severity === "Medium" ? "warning" : "outline"}>{f.severity}</Pill>
              </span>
              <p className={styles.what}>{f.finding}</p>
              <p className={styles.fix}>
                <span className={styles.fixLabel}>{f.status === "fixed" ? "Fixed" : "Mitigated"}</span> {f.fix}
              </p>
            </li>
          ))}
        </ol>
        <Muted small>
          Plus {counts.info} informational notes. The full report, with each proof of concept, is in the repository at{" "}
          <span className="num">{SECURITY_REPORT_PATH}</span>; the regression tests are in contracts/test/audit.
        </Muted>
      </Stack>
    </Card>
  );
}
