"use client";

import type { ExternalContracts, SuretyContracts } from "@surety/sdk";
import type { Address } from "viem";

import { Stack } from "@/components/layout/Layout";
import { EnvGate } from "@/components/shell/EnvGate";
import { Empty, KeyValues, LineName, Muted, Notice, PageHead } from "@/components/ui/Bits";
import { Card } from "@/components/ui/Card";
import { DataTable, ExplorerLink, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { epochCadence, kindLabel } from "@/lib/lines";
import { sourcifyUrl, TEST_COUNTS } from "@/lib/proof";

export function ProofPage() {
  return <EnvGate>{(env) => <ProofView env={env} />}</EnvGate>;
}

const SURETY: Record<keyof SuretyContracts, string> = {
  vault: "Surety vault (Morpho VaultV2, shares = srMUSD)",
  creditVoter: "CreditVoter: veBTC ballots per line and epoch",
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
  const surety: Row[] = (Object.keys(SURETY) as (keyof SuretyContracts)[]).map((k) => ({
    key: k,
    role: SURETY[k],
    address: d.contracts[k],
  }));
  const external: Row[] = (Object.keys(EXTERNAL) as (keyof ExternalContracts)[]).map((k) => ({
    key: k,
    role: EXTERNAL[k],
    address: d.external[k],
  }));

  return (
    <Stack gap={6}>
      <PageHead
        title="Proof"
        lead={`Every contract Surety runs on ${env.chainName}, with explorer links, and the transactions that show the mechanism working on chain.`}
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
            { label: "Credit lines", value: d.lines.length.toString() },
          ]}
        />
      </Card>
      <Card flat title="Surety contracts" description={demo ? undefined : "Every one is verified source on Sourcify."}>
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
      <Card flat title="Proof transactions" description="Each one is a step of the lifecycle, executed on chain.">
        {d.proof.txs.length === 0 ? (
          <div style={{ padding: "0 var(--space-5) var(--space-5)" }}>
            <Empty title="Not published yet">
              The lifecycle runs (deposit, vote, rebalance, loan, price shock, auction, cover, claim) are listed here with
              explorer links once they are recorded in the deployment file.
            </Empty>
          </div>
        ) : (
          <DataTable
            caption="Proof transactions"
            rowKey={(t) => t.hash}
            rows={d.proof.txs}
            columns={[
              { key: "label", header: "What it shows", cell: (t) => t.label },
              { key: "hash", header: "Transaction", align: "end", cell: (t) => <ExplorerLink kind="tx" value={t.hash} /> },
            ]}
          />
        )}
      </Card>
      <Card title="Tests">
        <Stack gap={3}>
          <KeyValues
            label="Tests"
            items={[
              {
                label: "Contracts (Foundry)",
                value: `${TEST_COUNTS.foundry} tests: unit, fuzz, integration and live-Mezo fork suites`,
              },
              {
                label: "Invariants",
                value: `${TEST_COUNTS.invariants}, each over ${TEST_COUNTS.invariantCalls.toLocaleString("en-US")} calls per run`,
              },
              { label: "SDK, keeper and MCP (TypeScript)", value: `${TEST_COUNTS.typescript} tests` },
            ]}
          />
          <Muted small>Run them with forge test in contracts/ and pnpm test at the repository root.</Muted>
        </Stack>
      </Card>
    </Stack>
  );
}
