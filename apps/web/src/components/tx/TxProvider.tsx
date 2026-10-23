"use client";

// Every write goes through here: a review of what will happen (amounts, approvals, consequences), then
// each transaction is simulated, signed, sent and confirmed in order, with an explorer link per step.
import { isRevert, type TxRequest } from "@surety/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";

import { useWalletDialog } from "@/components/shell/WalletDialog";
import { KeyValues, Notice, type KV } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Dialog, ExplorerLink } from "@/components/ui/Controls";
import { useSurety, type ReadyEnv } from "@/lib/env";
import { explainError, type ExplainedError } from "@/lib/errors";
import { shortAddress } from "@/lib/format";

import styles from "./Tx.module.css";

export interface TxStep {
  label: string;
  detail?: ReactNode;
  tx: TxRequest;
}

export interface TxPlan {
  title: string;
  /** What will happen, in a sentence or two. */
  summary: ReactNode;
  rows?: (KV | false | null | undefined)[];
  /** Consequences worth knowing before signing. */
  notes?: ReactNode[];
  warnings?: ReactNode[];
  /** Set when the action cannot go ahead now (the reason is shown instead of a confirm button). */
  blocked?: ReactNode;
  steps: TxStep[];
  confirmLabel?: string;
  successMessage?: ReactNode;
}

type PlanSource = TxPlan | (() => Promise<TxPlan>);

type StepState =
  | { s: "todo" }
  | { s: "check" }
  | { s: "wallet" }
  | { s: "pending"; hash: Hex }
  | { s: "done"; hash: Hex }
  | { s: "failed"; error: ExplainedError; hash?: Hex };

type Phase =
  | { p: "closed" }
  | { p: "preparing" }
  | { p: "prepare-failed"; error: ExplainedError; source: PlanSource }
  | { p: "review"; plan: TxPlan }
  | { p: "running"; plan: TxPlan }
  | { p: "done"; plan: TxPlan }
  | { p: "failed"; plan: TxPlan; at: number };

const TxContext = createContext<{ review: (source: PlanSource) => void } | null>(null);

export function useTx() {
  const ctx = useContext(TxContext);
  if (!ctx) throw new Error("useTx outside TxProvider");
  return ctx;
}

export function TxProvider({ children }: { children: ReactNode }) {
  const env = useSurety();
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();
  const wallet = useWalletDialog();

  const [phase, setPhase] = useState<Phase>({ p: "closed" });
  const [steps, setSteps] = useState<StepState[]>([]);
  const runId = useRef(0);

  const prepare = useCallback(async (source: PlanSource) => {
    const id = ++runId.current;
    setSteps([]);
    if (typeof source !== "function") {
      setPhase({ p: "review", plan: source });
      setSteps(source.steps.map(() => ({ s: "todo" })));
      return;
    }
    setPhase({ p: "preparing" });
    try {
      const plan = await source();
      if (runId.current !== id) return;
      setPhase({ p: "review", plan });
      setSteps(plan.steps.map(() => ({ s: "todo" })));
    } catch (e) {
      if (runId.current !== id) return;
      setPhase({ p: "prepare-failed", error: explainError(e), source });
    }
  }, []);

  const close = useCallback(() => {
    runId.current++;
    setPhase({ p: "closed" });
  }, []);

  const setStep = (i: number, st: StepState) => setSteps((prev) => prev.map((x, k) => (k === i ? st : x)));

  const run = useCallback(
    async (plan: TxPlan, from: number) => {
      if (env.status !== "ready" || !address) return;
      const ready: ReadyEnv = env;
      const id = runId.current;
      setPhase({ p: "running", plan });
      let onChain = walletChainId;
      for (let i = from; i < plan.steps.length; i++) {
        const step = plan.steps[i]!;
        let hash: Hex | undefined;
        try {
          setStep(i, { s: "check" });
          if (onChain !== ready.chainId) {
            await switchChainAsync({ chainId: ready.chainId as 31611 | 31612 });
            onChain = ready.chainId;
          }
          // Dry run first: a refusal (stale price, cap reached, ...) is shown before the wallet opens.
          try {
            await ready.client.publicClient.call({ account: address, to: step.tx.to, data: step.tx.data, value: step.tx.value });
          } catch (e) {
            if (isRevert(e)) throw e;
          }
          setStep(i, { s: "wallet" });
          hash = await sendTransactionAsync({
            to: step.tx.to,
            data: step.tx.data,
            value: step.tx.value,
            chainId: ready.chainId as 31611 | 31612,
          });
          setStep(i, { s: "pending", hash });
          const receipt = await ready.client.publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            throw new Error("The transaction was included but reverted on chain.");
          }
          setStep(i, { s: "done", hash });
        } catch (e) {
          if (runId.current !== id) return;
          setStep(i, { s: "failed", error: explainError(e), hash });
          setPhase({ p: "failed", plan, at: i });
          void queryClient.invalidateQueries({ queryKey: ready.scope });
          return;
        }
      }
      void queryClient.invalidateQueries({ queryKey: ready.scope });
      if (runId.current === id) setPhase({ p: "done", plan });
    },
    [address, env, queryClient, sendTransactionAsync, switchChainAsync, walletChainId],
  );

  const value = useMemo(() => ({ review: (s: PlanSource) => void prepare(s) }), [prepare]);

  const open = phase.p !== "closed";
  const plan = "plan" in phase ? phase.plan : null;
  const ready = env.status === "ready" ? env : null;
  const busy = phase.p === "running";

  let footer: ReactNode = null;
  if (phase.p === "review" && plan) {
    if (plan.blocked) {
      footer = <Button variant="secondary" onClick={close}>Close</Button>;
    } else if (ready?.mode === "demo") {
      footer = (
        <>
          <Button variant="secondary" onClick={close}>Close</Button>
          <Button disabled title="Example data: nothing is sent">
            {plan.confirmLabel ?? "Confirm in wallet"}
          </Button>
        </>
      );
    } else if (!isConnected) {
      footer = (
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={wallet.open}>Connect a wallet</Button>
        </>
      );
    } else {
      footer = (
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={() => void run(plan, 0)}>
            {plan.confirmLabel ?? (plan.steps.length > 1 ? `Start (${plan.steps.length} transactions)` : "Confirm in wallet")}
          </Button>
        </>
      );
    }
  } else if (phase.p === "running") {
    footer = (
      <Button variant="secondary" onClick={close}>
        Hide (keeps going in your wallet)
      </Button>
    );
  } else if (phase.p === "done") {
    footer = <Button onClick={close}>Done</Button>;
  } else if (phase.p === "failed" && plan) {
    footer = (
      <>
        <Button variant="secondary" onClick={close}>Close</Button>
        <Button onClick={() => void run(plan, phase.at)}>Try again</Button>
      </>
    );
  } else if (phase.p === "prepare-failed") {
    footer = (
      <>
        <Button variant="secondary" onClick={close}>Close</Button>
        <Button onClick={() => void prepare(phase.source)}>Try again</Button>
      </>
    );
  }

  return (
    <TxContext.Provider value={value}>
      {children}
      <Dialog open={open} onClose={busy ? close : close} title={plan?.title ?? "Review"} footer={footer}>
        {phase.p === "preparing" ? (
          <div className={styles.preparing} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            Reading the latest numbers from the chain…
          </div>
        ) : null}
        {phase.p === "prepare-failed" ? (
          <Notice tone="danger" title="Could not prepare this action" role="alert">
            {phase.error.title}
          </Notice>
        ) : null}
        {plan ? (
          <PlanView
            plan={plan}
            steps={steps}
            env={ready}
            from={address}
            phase={phase.p}
            notConnected={!isConnected && ready?.mode === "live"}
          />
        ) : null}
      </Dialog>
    </TxContext.Provider>
  );
}

function stepStatus(st: StepState | undefined): ReactNode {
  if (!st || st.s === "todo") return null;
  if (st.s === "check") return (
    <>
      <span className={styles.spinner} aria-hidden="true" /> Checking it would go through…
    </>
  );
  if (st.s === "wallet") return (
    <>
      <span className={styles.spinner} aria-hidden="true" /> Confirm in your wallet
    </>
  );
  if (st.s === "pending")
    return (
      <>
        <span className={styles.spinner} aria-hidden="true" /> Pending · <ExplorerLink kind="tx" value={st.hash} />
      </>
    );
  if (st.s === "done")
    return (
      <>
        Confirmed · <ExplorerLink kind="tx" value={st.hash} />
      </>
    );
  return (
    <>
      {st.error.title}
      {st.hash ? (
        <>
          {" "}
          · <ExplorerLink kind="tx" value={st.hash} />
        </>
      ) : null}
    </>
  );
}

function PlanView({
  plan,
  steps,
  env,
  from,
  phase,
  notConnected,
}: {
  plan: TxPlan;
  steps: StepState[];
  env: ReadyEnv | null;
  from: string | undefined;
  phase: Phase["p"];
  notConnected: boolean;
}) {
  return (
    <>
      <p className={styles.summary}>{plan.summary}</p>
      {plan.rows && plan.rows.some(Boolean) ? (
        <div className={styles.rows}>
          <KeyValues items={plan.rows} label="Details" />
        </div>
      ) : null}
      {plan.blocked ? (
        <Notice tone="danger" title="Not possible right now" role="alert">
          {plan.blocked}
        </Notice>
      ) : null}
      {plan.warnings?.map((w, i) => (
        <Notice key={i} tone="warning">
          {w}
        </Notice>
      ))}
      {!plan.blocked && plan.steps.length > 0 ? (
        <div>
          <p className={styles.stepsTitle}>
            {plan.steps.length === 1 ? "One transaction" : `${plan.steps.length} transactions, in this order`}
          </p>
          <ol className={styles.steps}>
            {plan.steps.map((step, i) => {
              const st = steps[i];
              const cls = [
                styles.step,
                st && (st.s === "check" || st.s === "wallet" || st.s === "pending") && styles.stepActive,
                st?.s === "done" && styles.stepDone,
                st?.s === "failed" && styles.stepFailed,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={i} className={cls}>
                  <span className={styles.badge} aria-hidden="true">
                    {st?.s === "done" ? "✓" : st?.s === "failed" ? "!" : i + 1}
                  </span>
                  <div>
                    <div className={styles.stepLabel}>{step.label}</div>
                    {step.detail ? <div className={styles.stepDetail}>{step.detail}</div> : null}
                    {st && st.s !== "todo" ? (
                      <div className={styles.stepStatus} role="status">
                        {stepStatus(st)}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      {plan.notes && plan.notes.length ? (
        <ul className={styles.notes}>
          {plan.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      {phase === "done" ? (
        <Notice tone="positive" title="Done" role="status">
          {plan.successMessage ?? "Confirmed on chain. The numbers on the page refresh from the chain now."}
        </Notice>
      ) : null}
      {env?.mode === "demo" && phase === "review" && !plan.blocked ? (
        <Notice tone="info" title="Example data">
          This is the review you would sign. In example mode nothing is sent; connect a wallet on a deployed network to do
          it for real.
        </Notice>
      ) : null}
      {notConnected && phase === "review" && !plan.blocked ? (
        <Notice tone="info">Connect a wallet to sign this. Nothing is sent until you confirm each step in it.</Notice>
      ) : null}
      {env ? (
        <p className={styles.meta}>
          {env.chainName}
          {from && env.mode === "live" ? ` · from ${shortAddress(from)}` : ""}
          {env.mode === "demo" ? " · example wallet" : ""}
        </p>
      ) : null}
    </>
  );
}
