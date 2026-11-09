"use client";

import {
  explorerUrl,
  getDeployment,
  getDeployments,
  type ExternalContracts,
  type ProofTx,
  type SuretyDeployment,
} from "@surety/sdk";
import type { Address } from "viem";

import { Stack } from "@/components/layout/Layout";
import { EnvGate } from "@/components/shell/EnvGate";
import { Empty, KeyValues, LineName, Muted, Notice, PageHead, Pill, Stat } from "@/components/ui/Bits";
import { Card } from "@/components/ui/Card";
import { DataTable, ExplorerLink } from "@/components/ui/Controls";
import { CHAIN_NAMES, type ReadyEnv } from "@/lib/env";
import { shortAddress, shortHash } from "@/lib/format";
import { epochCadence, kindLabel } from "@/lib/lines";
import {
  deployedContracts,
  isEscrowProof,
  proofAnchor,
  repoFile,
  REPO_DOCS,
  SECURITY_REPORT_PATH,
  SECURITY_REVIEW,
  sourcifyUrl,
  TEST_COUNTS,
} from "@/lib/proof";

import styles from "./Proof.module.css";

export function ProofPage() {
  return <EnvGate>{(env) => <ProofView env={env} />}</EnvGate>;
}

const EXTERNAL: Record<keyof ExternalContracts, string> = {
  musd: "MUSD",
  btc: "BTC (ERC-20 precompile)",
  veBTC: "veBTC (vote-escrowed BTC NFT)",
  poolsVoter: "Mezo PoolsVoter",
  rewardsDistributor: "Mezo rewards distributor",
  skipAggregator: "Skip price oracle (precompile)",
  smusd: "Mezo MUSD Savings Rate (sMUSD)",
};

/** One deployment to show: whether its addresses are real (linkable) or the example fixture's. */
interface Shown {
  d: SuretyDeployment;
  real: boolean;
}

/**
 * The deployments of this network, newest first: the current one and the archived first deployment. In example
 * mode the fixture stands in for the current one, next to the real archived v1 of the testnet.
 */
function shownDeployments(env: ReadyEnv): Shown[] {
  if (env.mode === "demo") {
    const out: Shown[] = [{ d: env.deployment, real: false }];
    if (env.deployment.version === 2) {
      const v1 = getDeployment(env.chainId, { version: 1 });
      if (v1) out.push({ d: v1, real: true });
    }
    return out;
  }
  return getDeployments(env.chainId).map((d) => ({ d, real: true }));
}

function versionLabel(d: SuretyDeployment): string {
  return d.version === 2 ? "v2" : "v1";
}

function ProofView({ env }: { env: ReadyEnv }) {
  const shown = shownDeployments(env);
  const v2 = shown.find((s) => s.d.version === 2) ?? null;
  const v1 = shown.find((s) => s.d.version === 1) ?? null;
  const current = env.deployment;
  const escrowRows = shown.flatMap((s) =>
    s.d.proof.txs.flatMap((t, i) => (isEscrowProof(t.label) ? [{ s, t, n: i + 1 }] : [])),
  );

  return (
    <Stack gap={6}>
      <PageHead
        title="Proof"
        lead={`Every contract Surety runs on ${env.chainName}, the first deployment and the current one side by side, with verified source and explorer links, the transactions that show the mechanism working on chain, and what the security reviews found.`}
      />
      {env.mode === "demo" ? (
        <Notice tone="info" title="Example addresses">
          The current deployment here comes from the SDK&apos;s test fixture: not real contracts, so no links. The first
          deployment next to it is the real one on Mezo testnet.
        </Notice>
      ) : null}

      <section aria-labelledby="deployments-title">
        <h2 id="deployments-title" className="sr-only">
          Deployments
        </h2>
        <div className={styles.columns}>
          {v2 ? <DeploymentCard shown={v2} current /> : <Missing env={env} />}
          {v1 ? <DeploymentCard shown={v1} current={!v2} /> : null}
        </div>
      </section>

      <Card
        tone="accent"
        eyebrow="On chain"
        title="The loan escrow on Mezo: vote, bribe, claims"
        description="Proof steps where an escrowed veBTC votes on Mezo's gauges, earns a bribe, and has its fees, bribes and rebase claimed or harvested."
      >
        {escrowRows.length === 0 ? (
          <Muted small>No escrow steps are recorded on this network yet.</Muted>
        ) : (
          <ol className={styles.txs} aria-label="Escrow proof transactions">
            {escrowRows.map(({ s, t, n }) => (
              <li key={t.hash} className={styles.tx}>
                <a className={styles.step} href={`#${proofAnchor(s.d.version, n)}`} aria-label={`${versionLabel(s.d)} step ${n}`}>
                  {versionLabel(s.d)}·{n}
                </a>
                <span className={styles.txLabel}>{t.label}</span>
                <span className={styles.txHash}>
                  <TxLink chainId={s.d.chainId} hash={t.hash} real={s.real} />
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className={styles.after}>
          <Muted small>
            Fees and bribes from a Mezo vote become claimable once that Mezo epoch ends (weekly, Thursday 00:00 UTC); the
            claim, rebase and harvest steps are listed here as they are recorded.
          </Muted>
        </p>
      </Card>

      <section aria-labelledby="txs-title">
        <h2 id="txs-title" className={styles.sectionTitle}>
          Proof transactions
        </h2>
        <div className={styles.columns}>
          {v2 ? <ProofList shown={v2} /> : null}
          {v1 ? <ProofList shown={v1} /> : null}
        </div>
      </section>

      <Card flat title="Mezo contracts it uses" description="Surety reads and calls these; it does not own them.">
        <DataTable
          caption="External contracts"
          rowKey={(r) => r.key}
          rows={(Object.keys(EXTERNAL) as (keyof ExternalContracts)[]).flatMap((k) => {
            const address = current.external[k];
            return address ? [{ key: k, role: EXTERNAL[k], address }] : [];
          })}
          columns={[
            { key: "role", header: "Contract", cell: (r) => r.role },
            { key: "address", header: "Address", align: "end", cell: (r) => <ExplorerLink kind="address" value={r.address} full /> },
          ]}
        />
      </Card>
      <Card flat title="Credit lines">
        <DataTable
          caption="Credit lines"
          rowKey={(l) => l.id.toString()}
          rows={current.lines}
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
      <SecurityReview />
      <Tests />
    </Stack>
  );
}

/* ---------- Links that work for any deployment of the chain ---------- */

function AddressLink({ chainId, address, real }: { chainId: number; address: Address; real: boolean }) {
  const href = real ? explorerUrl(chainId, "address", address) : null;
  if (!href) return <span className="num" title={address}>{shortAddress(address)}</span>;
  return (
    <a className="num" href={href} target="_blank" rel="noopener noreferrer" title={address}>
      {shortAddress(address)}
      <span className="sr-only"> (opens the Mezo explorer)</span>
    </a>
  );
}

function TxLink({ chainId, hash, real }: { chainId: number; hash: string; real: boolean }) {
  const href = real ? explorerUrl(chainId, "tx", hash) : null;
  if (!href) return <span className="num" title={hash}>{shortHash(hash)}</span>;
  return (
    <a className="num" href={href} target="_blank" rel="noopener noreferrer" title={hash}>
      {shortHash(hash)}
      <span className="sr-only"> (opens the Mezo explorer)</span>
    </a>
  );
}

/* ---------- One deployment ---------- */

function DeploymentCard({ shown, current }: { shown: Shown; current: boolean }) {
  const { d, real } = shown;
  const contracts = deployedContracts(d);
  return (
    <Card
      title={d.version === 2 ? "v2: peg, fees, savings, share market" : "v1: the first deployment"}
      eyebrow={
        <span className={styles.eyebrow}>
          <Pill tone={current ? "accent" : "outline"}>{versionLabel(d)}</Pill>
          {current ? "Current" : "Archived, still on chain"}
        </span>
      }
    >
      <Stack gap={4}>
        <KeyValues
          label={`${versionLabel(d)} deployment`}
          items={[
            { label: "Network", value: `${CHAIN_NAMES[d.chainId] ?? "Chain"} (${d.chainId})` },
            {
              label: "Deployed at block",
              value: real ? (
                <a href={explorerUrl(d.chainId, "block", d.deployedAt) ?? undefined} target="_blank" rel="noopener noreferrer" className="num">
                  {d.deployedAt.toString()}
                </a>
              ) : (
                <span className="num">{d.deployedAt.toString()}</span>
              ),
            },
            { label: "Epochs", value: `${d.epochLength} s (${epochCadence(BigInt(d.epochLength))})` },
            { label: "Surety contracts", value: contracts.length.toString() },
            { label: "Proof steps", value: d.proof.txs.length.toString() },
          ]}
        />
        <ul className={styles.contracts} aria-label={`${versionLabel(d)} contracts`}>
          {contracts.map((c) => (
            <li key={c.key} className={styles.contract}>
              <span className={styles.contractName}>{c.name}</span>
              <AddressLink chainId={d.chainId} address={c.address} real={real} />
              {real ? (
                <a href={sourcifyUrl(d.chainId, c.address)} target="_blank" rel="noopener noreferrer" className={styles.source}>
                  Sourcify<span aria-hidden="true"> ↗</span>
                  <span className="sr-only"> (verified source of {c.name})</span>
                </a>
              ) : (
                <span className={styles.source} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
        {real ? <Muted small>Verified source on Sourcify (exact match).</Muted> : null}
      </Stack>
    </Card>
  );
}

function Missing({ env }: { env: ReadyEnv }) {
  return (
    <Card title="v2: peg, fees, savings, share market" eyebrow={<Pill tone="outline">v2</Pill>} tone="sunk">
      <Empty title={`Not deployed on ${env.chainName} yet`}>
        The v2 contracts, their verification links and their proof transactions appear here, next to the first
        deployment, as soon as the deployment file is published. Until then the app reads the first deployment, and
        example mode shows v2.
      </Empty>
    </Card>
  );
}

function ProofList({ shown }: { shown: Shown }) {
  const { d, real } = shown;
  const txs: (ProofTx & { n: number })[] = d.proof.txs.map((t, i) => ({ ...t, n: i + 1 }));
  return (
    <Card
      flat
      title={`${versionLabel(d)} · ${txs.length} step${txs.length === 1 ? "" : "s"}`}
      description={txs.length ? "Each a step of the lifecycle, executed on chain, in the order it ran." : undefined}
    >
      {txs.length === 0 ? (
        <div className={styles.pad}>
          <Empty title="Not published yet">
            The lifecycle runs (deposit, vote, rebalance, loan, price shock, auction, cover, claim) are listed here with
            explorer links once they are recorded in the deployment file.
          </Empty>
        </div>
      ) : (
        <ol className={styles.txs} aria-label={`${versionLabel(d)} proof transactions`}>
          {txs.map((t) => (
            <li key={t.hash} id={proofAnchor(d.version, t.n)} className={styles.tx} data-escrow={isEscrowProof(t.label) || undefined}>
              <span className={styles.step}>{t.n}</span>
              <span className={styles.txLabel}>
                {t.label}
                {isEscrowProof(t.label) ? (
                  <>
                    {" "}
                    <Pill tone="accent">Escrow on Mezo</Pill>
                  </>
                ) : null}
              </span>
              <span className={styles.txHash}>
                <TxLink chainId={d.chainId} hash={t.hash} real={real} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/* ---------- Reviews and tests ---------- */

function SecurityReview() {
  const { counts, findings } = SECURITY_REVIEW;
  const fixed = findings.filter((f) => f.status === "fixed").length;
  return (
    <Card
      title="Security review"
      description={`An independent review of the first contracts and the deploy script before mainnet found no critical or high issues. Of its ${findings.length} medium and low findings, ${fixed} are fixed in code and ${findings.length - fixed} is handled by the keeper.`}
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
          <a href={repoFile(SECURITY_REPORT_PATH)} target="_blank" rel="noopener noreferrer">
            {SECURITY_REPORT_PATH}
          </a>
          ; the regression tests are in contracts/test/audit. The review of the v2 changes is added to{" "}
          {REPO_DOCS.security} as it completes.
        </Muted>
      </Stack>
    </Card>
  );
}

function Tests() {
  return (
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
            { label: "SDK, keeper, MCP and web (TypeScript)", value: TEST_COUNTS.typescript.toString() },
          ]}
        />
        <Muted small>
          Counted at the first testnet deployment. The Foundry suites are unit, fuzz, integration, invariant and
          live-Mezo fork tests. Each regression test replays a review finding&apos;s attack and checks it no longer
          works. Run them with forge test in contracts/ and pnpm test at the repository root.
        </Muted>
      </Stack>
    </Card>
  );
}
