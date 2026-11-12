"use client";

import {
  exampleDeploymentV2,
  explorerUrl,
  getDeployment,
  getDeployments,
  isV2Deployment,
  MEZO_MAINNET_ID,
  MEZO_TESTNET_ID,
  type ProofTx,
  type SuretyContracts,
  type SuretyDeployment,
} from "@surety/sdk";
import type { ReactNode } from "react";

import { PegBadge } from "@/components/peg/PegBadge";
import { Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate } from "@/components/shell/EnvGate";
import { Muted, PageHead, Pill } from "@/components/ui/Bits";
import { Button, ButtonLink } from "@/components/ui/Button";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, shortAddress, shortHash } from "@/lib/format";
import { isEscrowProof, isKeyMainnetStep, proofAnchor, repoFile, REPO_DOCS, REPO_URL, sourcifyUrl } from "@/lib/proof";
import { useLineParams } from "@/lib/queries";

import styles from "./Review.module.css";

export function ReviewPage() {
  return <EnvGate>{(env) => <ReviewView env={env} />}</EnvGate>;
}

/** The v2 line's auction trigger and floor, as configured for every v2 deployment. */
const V2_LINE = exampleDeploymentV2.lineParams;

/** Contracts worth opening first, in that order; each deployment lists what it has. */
const KEY_CONTRACTS: [keyof SuretyContracts, string][] = [
  ["vault", "Surety vault (VaultV2)"],
  ["veBTCLine", "VeBTCCreditLine"],
  ["suretyPool", "SuretyPool"],
  ["creditVoter", "CreditVoter"],
  ["musdPeg", "MusdPeg"],
  ["shareMarket", "ShareMarket"],
];

/** A recorded proof transaction with its deployment and its 1-based step number there. */
interface Step {
  d: SuretyDeployment;
  t: ProofTx;
  n: number;
}

function ReviewView({ env }: { env: ReadyEnv }) {
  const mainnet = getDeployment(MEZO_MAINNET_ID) ?? null;
  const testnetV1 = getDeployment(MEZO_TESTNET_ID, { version: 1 }) ?? null;
  const mainnetSteps: Step[] = mainnet
    ? mainnet.proof.txs.flatMap((t, i) => (isKeyMainnetStep(t.label) ? [{ d: mainnet, t, n: i + 1 }] : []))
    : [];
  const escrowSteps: Step[] = [...getDeployments(MEZO_MAINNET_ID), ...getDeployments(MEZO_TESTNET_ID)].flatMap((d) =>
    d.proof.txs.flatMap((t, i) => (isEscrowProof(t.label) ? [{ d, t, n: i + 1 }] : [])),
  );
  const params = useLineParams().data;

  return (
    <Stack gap={6}>
      <PageHead
        title="Review in 5 minutes"
        lead="Ten checks, each pointing at the place to see it for yourself: the contracts on Mezo, the transactions that exercised them, the code and the numbers. Start anywhere."
      />
      <ol className={styles.checks}>
        <Check
          n={1}
          minutes="1 min"
          title="The live mainnet deployment"
          what="Surety runs on Mezo mainnet with small caps and real MUSD in it. Open a contract on the explorer, then its verified source, then the transactions that put the MUSD to work."
        >
          {mainnet ? (
            <Stack gap={3}>
              <p className={styles.meta}>
                <Pill tone="accent">{isV2Deployment(mainnet) ? "v2" : "v1"}</Pill> Mezo Mainnet (31612), deployed at block{" "}
                <span className="num">{mainnet.deployedAt.toString()}</span>
              </p>
              <ContractList d={mainnet} />
              {mainnetSteps.length ? (
                <>
                  <p className={styles.meta}>Real MUSD through it, from the team&apos;s own wallet and keeper:</p>
                  <StepList env={env} steps={mainnetSteps} />
                </>
              ) : null}
              <div className={styles.links}>
                {env.mode === "live" ? (
                  <Button size="sm" variant="secondary" onClick={() => env.selectChain(MEZO_MAINNET_ID)} disabled={env.chainId === MEZO_MAINNET_ID}>
                    {env.chainId === MEZO_MAINNET_ID ? "Reading mainnet now" : "Read the app on mainnet"}
                  </Button>
                ) : null}
                <ButtonLink size="sm" variant="quiet" href="/app/proof">
                  Every contract and proof step
                </ButtonLink>
              </div>
            </Stack>
          ) : (
            <Muted small>The mainnet deployment file is not bundled in this build.</Muted>
          )}
        </Check>

        <Check
          n={2}
          minutes="1 min"
          title="Try it on testnet, no setup"
          what="A testnet wallet in the browser gets a starter kit (gas, a small veBTC lock, test MUSD), borrows against the veBTC, steers its escrow's vote and repays."
        >
          <div className={styles.links}>
            <ButtonLink size="sm" href="/app/try">
              Try it
            </ButtonLink>
            <ButtonLink size="sm" variant="quiet" href="/app?demo=1">
              Or click through example data
            </ButtonLink>
          </div>
        </Check>

        <Check
          n={3}
          minutes="30 s"
          title="The MUSD peg, live, and a depeg on demand"
          what="MUSD is priced from Mezo's own pools. On testnet anyone can push it off $1 for two hours and watch new loans get refused."
        >
          <div className={styles.links}>
            <PegBadge />
            <ButtonLink size="sm" variant="secondary" href="/app/peg">
              Open the peg
            </ButtonLink>
          </div>
        </Check>

        <Check
          n={4}
          minutes="30 s"
          title="The loan escrow votes and claims on Mezo"
          what="An escrowed veBTC voted on a Mezo gauge, earned a bribe, and its fees, bribes and rebase are claimed or harvested into repayment."
        >
          {escrowSteps.length ? (
            <StepList env={env} steps={escrowSteps} network />
          ) : (
            <Muted small>The escrow steps appear here once they are recorded.</Muted>
          )}
          {testnetV1 ? null : <Muted small>The testnet deployment file is not bundled in this build.</Muted>}
        </Check>

        <Check
          n={5}
          minutes="30 s"
          title="Auctions and where a bid goes"
          what={
            params && isV2Deployment(env.deployment)
              ? `Auctions start at ${formatBps(params.liqLtvBps, 0)} LTV and fall to an ${formatBps(params.floorBps, 0)} floor, so a sale at the floor still repays the debt. Each bid shows its split: debt, the fee to lenders, treasury and keeper, the borrower's surplus.`
              : `On v2 auctions start at ${formatBps(V2_LINE.liqLtvBps, 0)} LTV and fall to an ${formatBps(V2_LINE.floorBps, 0)} floor${params ? ` (the first deployment: ${formatBps(params.liqLtvBps, 0)} and ${formatBps(params.floorBps, 0)})` : ""}, so a sale at the floor still repays the debt. Each bid shows its split: debt, the fee to lenders, treasury and keeper.`
          }
        >
          <div className={styles.links}>
            <ButtonLink size="sm" variant="secondary" href="/app/auctions">
              Open auctions
            </ButtonLink>
          </div>
        </Check>

        <Check
          n={6}
          minutes="30 s"
          title="The share market"
          what="Lenders leave while the vault's cash is lent out by selling srMUSD at a discount; buyers fill in parts. It pauses, and says why, while a loss is covered."
        >
          <div className={styles.links}>
            <ButtonLink size="sm" variant="secondary" href="/app/market">
              Open the share market
            </ButtonLink>
          </div>
        </Check>

        <Check
          n={7}
          minutes="30 s"
          title="Who pays whom"
          what="Every fee, who pays it, what it funds, the live treasury, and a year of income at the caps and at $1M and $10M. Small, and said plainly."
        >
          <div className={styles.links}>
            <ButtonLink size="sm" variant="secondary" href="/app/business">
              Open the business page
            </ButtonLink>
            <ExtLink href={repoFile(REPO_DOCS.business)} label={REPO_DOCS.business} />
          </div>
        </Check>

        <Check
          n={8}
          minutes="30 s"
          title="Security reviews"
          what="An independent review of the first contracts, every finding with its fix and a regression test; the review of the v2 changes is added to the same file."
        >
          <div className={styles.links}>
            <ExtLink href={repoFile(REPO_DOCS.security)} label={REPO_DOCS.security} />
            <ButtonLink size="sm" variant="quiet" href="/app/proof">
              Findings on the proof page
            </ButtonLink>
          </div>
        </Check>

        <Check
          n={9}
          minutes="30 s"
          title="Feedback, answered"
          what="Each piece of feedback on the first version, with the change that answers it and the transaction that shows it working."
        >
          <div className={styles.links}>
            <ExtLink href={repoFile(REPO_DOCS.feedback)} label={REPO_DOCS.feedback} />
          </div>
        </Check>

        <Check
          n={10}
          minutes="30 s"
          title="Who has used it, and the code"
          what="Every wallet outside the team that took a starter kit and used Surety, from on-chain events; and the full source: contracts, SDK, keeper and this app."
        >
          <div className={styles.links}>
            <ButtonLink size="sm" variant="secondary" href="/app/ledger">
              Outside users
            </ButtonLink>
            <ExtLink href={REPO_URL} label="Source code" />
          </div>
        </Check>
      </ol>
    </Stack>
  );
}

function Check({
  n,
  minutes,
  title,
  what,
  children,
}: {
  n: number;
  minutes: string;
  title: string;
  what: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={styles.check} aria-labelledby={`check-${n}`}>
      <div className={styles.head}>
        <span className={styles.n} aria-hidden="true">
          {n}
        </span>
        <h2 id={`check-${n}`} className={styles.title}>
          {title}
        </h2>
        <span className={styles.time}>{minutes}</span>
      </div>
      <p className={styles.what}>{what}</p>
      {children ? <div className={styles.body}>{children}</div> : null}
    </li>
  );
}

function ExtLink({ href, label }: { href: string | null; label: ReactNode }) {
  if (!href) return <span className="num">{label}</span>;
  return (
    <a className={styles.ext} href={href} target="_blank" rel="noopener noreferrer">
      {label}
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * Proof transactions with their explorer links, and a link to the step on the proof page when the app reads that
 * network (the proof page lists the deployments of the network it reads). `network` tags each with its network.
 */
function StepList({ env, steps, network = false }: { env: ReadyEnv; steps: Step[]; network?: boolean }) {
  return (
    <ul className={styles.steps}>
      {steps.map(({ d, t, n }) => (
        <li key={t.hash}>
          <span className={styles.stepLabel}>
            {network ? (
              <>
                <Pill tone="outline">{d.chainId === MEZO_MAINNET_ID ? "Mainnet" : "Testnet"}</Pill>{" "}
              </>
            ) : null}
            {t.label}
          </span>
          <span className={styles.stepLinks}>
            <ExtLink href={explorerUrl(d.chainId, "tx", t.hash)} label={shortHash(t.hash)} />
            {env.chainId === d.chainId && env.mode === "live" ? (
              <AppLink href={`/app/proof#${proofAnchor(d.version, n)}`} className={styles.small}>
                step {n}
              </AppLink>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ContractList({ d }: { d: SuretyDeployment }) {
  const rows = KEY_CONTRACTS.flatMap(([key, name]) => {
    const address = d.contracts[key];
    return address ? [{ key, name, address }] : [];
  });
  return (
    <ul className={styles.contracts} aria-label="Key mainnet contracts">
      {rows.map((r) => (
        <li key={r.key}>
          <span>{r.name}</span>
          <ExtLink href={explorerUrl(d.chainId, "address", r.address)} label={shortAddress(r.address)} />
          <ExtLink href={sourcifyUrl(d.chainId, r.address)} label="Source" />
        </li>
      ))}
    </ul>
  );
}
