"use client";

import type { Board, LoanView } from "@surety/sdk";
import { useState } from "react";
import { isAddress, type Address } from "viem";

import { Stack } from "@/components/layout/Layout";
import { ReadError } from "@/components/shell/EnvGate";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { Empty, Meter, Muted, Notice, Pill, SectionTitle, Skeleton, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, SelectField, TextField } from "@/components/ui/Controls";
import { buildEscrowClaimRebase, buildEscrowReset, buildEscrowVote } from "@/lib/builders";
import type { ReadyEnv } from "@/lib/env";
import {
  formatBps,
  formatBtc,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMusd,
  formatUsdWad,
  parseAmount,
  toInput,
} from "@/lib/format";
import { useChainNow, useLoans, useWallet } from "@/lib/queries";
import { readAllowance } from "@/lib/reads";

import styles from "./Borrow.module.css";

const BPS = 10_000n;
const WEEK = 604_800;

export function Loans({ env, board }: { env: ReadyEnv; board: Board | undefined }) {
  const loans = useLoans();
  if (!env.account) return null;
  const live = (loans.data ?? []).filter((l) => l.state === "Active" || l.state === "Auction");
  const closed = (loans.data ?? []).filter((l) => l.state === "Closed" || l.state === "Liquidated");
  return (
    <Stack gap={4}>
      <SectionTitle>Your loans</SectionTitle>
      {loans.error ? (
        <ReadError what="your loans" error={loans.error} onRetry={() => void loans.refetch()} />
      ) : loans.isPending ? (
        <Skeleton height={260} label="Loading your loans" />
      ) : live.length === 0 ? (
        <Empty title="No open loans">Loans you open against veBTC show up here with their health and actions.</Empty>
      ) : (
        live.map((l) => <LoanCard key={l.loanId.toString()} env={env} loan={l} board={board} />)
      )}
      {closed.length ? (
        <Muted small>
          Closed: {closed.map((l) => `#${l.loanId} (${l.state === "Liquidated" ? "auctioned" : "repaid"})`).join(", ")}
        </Muted>
      ) : null}
    </Stack>
  );
}

type Action = "repay" | "more" | "extend" | "collateral" | "escrow";

function ltvTone(loan: LoanView): string {
  if (loan.ltvBps === null) return "var(--color-ink-3)";
  if (loan.ltvBps >= loan.liqLtvBps) return "var(--color-danger)";
  if (loan.ltvBps > loan.maxLtvBps) return "var(--color-warning)";
  return "var(--color-positive)";
}

function LoanCard({ env, loan, board }: { env: ReadyEnv; loan: LoanView; board: Board | undefined }) {
  const now = useChainNow();
  const [action, setAction] = useState<Action | null>(null);
  const inAuction = loan.state === "Auction";
  const left = loan.maturity === null || now === null ? null : Number(loan.maturity) - now;
  const ltv = loan.ltvBps === null ? null : Number(loan.ltvBps) / 10_000;
  const scale = 1; // gauge spans 0-100% LTV

  return (
    <Card tone={inAuction || loan.liquidatable ? "danger" : "default"} label={`Loan ${loan.loanId}`}>
      <Stack gap={5}>
        <div className={styles.loanHead}>
          <span className={styles.loanTitle}>
            Loan #{loan.loanId.toString()} · veBTC #{loan.tokenId.toString()}
          </span>
          <span style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {inAuction ? (
              <Pill tone="danger" dot>In auction</Pill>
            ) : loan.liquidatable ? (
              <Pill tone="danger" dot>Can be auctioned now</Pill>
            ) : (
              <Pill tone="positive" dot>Active</Pill>
            )}
            {loan.lock.isPermanent ? <Pill tone="outline">Permanent lock</Pill> : null}
          </span>
        </div>

        {inAuction ? (
          <Notice tone="danger" title="Your veBTC is being auctioned" role="alert">
            The auction started {loan.auctionStart ? formatDateTime(loan.auctionStart) : ""}. Repay the full debt before
            someone bids and the NFT comes back to you. Repaying works even while the price feed is stale.
          </Notice>
        ) : loan.liquidatable ? (
          <Notice tone="danger" title="Past the liquidation line" role="alert">
            {loan.liquidationReason === "expiry"
              ? "The lock has ended. Anyone can start the auction now: repay to keep the NFT."
              : "Loan-to-value reached 70%. Anyone can start the auction now: repay or add collateral to keep the NFT."}
          </Notice>
        ) : null}

        <div className={styles.loanStats}>
          <Stat label="Debt" value={formatMusd(loan.debt)} unit="MUSD" />
          <Stat
            label="Collateral"
            value={formatBtc(loan.lock.amount)}
            unit="BTC"
            hint={loan.collateralValue === null ? "Price feed stale" : `$${formatUsdWad(loan.collateralValue)}`}
          />
          <Stat
            label="Auction if BTC falls to"
            value={loan.liquidationPriceWad === null ? "—" : `$${formatUsdWad(loan.liquidationPriceWad)}`}
          />
          <Stat
            label="Matures"
            value={
              loan.maturity === null
                ? "No date"
                : left === null
                  ? "—"
                  : left <= 0
                    ? "Ended"
                    : left < 86_400
                      ? formatCountdown(left)
                      : `in ${formatDuration(left)}`
            }
            hint={loan.maturity === null ? "Permanent lock" : `Lock end ${formatDate(loan.maturity)}`}
            tone={left !== null && left <= 0 ? "danger" : undefined}
          />
        </div>

        <div className={styles.gauge}>
          <div className={styles.gaugeHead}>
            <span>Loan-to-value</span>
            <span className={styles.gaugeValue} style={{ color: ltvTone(loan) }}>
              {formatBps(loan.ltvBps)}
            </span>
          </div>
          <Meter
            value={ltv === null ? 0 : ltv / scale}
            color={ltvTone(loan)}
            label="Loan-to-value"
            valueText={`${formatBps(loan.ltvBps)}; auction at ${formatBps(loan.liqLtvBps, 0)}`}
            size="lg"
            markers={[
              { at: Number(loan.maxLtvBps) / 10_000, label: `max ${formatBps(loan.maxLtvBps, 0)}` },
              { at: Number(loan.liqLtvBps) / 10_000, label: `auction ${formatBps(loan.liqLtvBps, 0)}`, color: "var(--color-danger)" },
            ]}
          />
        </div>

        <div className={styles.actionBar} role="group" aria-label="Loan actions">
          {(
            [
              ["repay", inAuction ? "Repay in full" : "Repay"],
              ...(inAuction
                ? []
                : ([
                    ["more", "Borrow more"],
                    ["extend", "Extend lock"],
                    ["collateral", "Add collateral"],
                  ] as const)),
              ["escrow", "Vote and rewards"],
            ] as [Action, string][]
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={action === id ? "primary" : "secondary"}
              aria-expanded={action === id}
              onClick={() => setAction(action === id ? null : id)}
            >
              {label}
            </Button>
          ))}
        </div>

        {action ? (
          <div className={styles.actionPanel}>
            {action === "repay" ? <RepayForm env={env} loan={loan} /> : null}
            {action === "more" ? <BorrowMoreForm env={env} loan={loan} board={board} /> : null}
            {action === "extend" ? <ExtendForm env={env} loan={loan} /> : null}
            {action === "collateral" ? <AddCollateralForm env={env} loan={loan} /> : null}
            {action === "escrow" ? <EscrowForm env={env} loan={loan} /> : null}
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function RepayForm({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const tx = useTx();
  const wallet = useWallet();
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  // Interest accrues every second: a full repay sends a small buffer; the line takes only what is owed.
  const full = amount !== null && amount >= loan.debt;
  const pull = full ? loan.debt + loan.debt / 1000n + 1n : (amount ?? 0n);
  const musd = wallet.data?.musd;
  const error =
    input && amount === null
      ? "Enter a number."
      : musd !== undefined && amount !== null && pull > musd
        ? `Your wallet holds ${formatMusd(musd)} MUSD.`
        : null;

  const plan = async (): Promise<TxPlan> => {
    const line = env.deployment.contracts.veBTCLine;
    const allowance = await readAllowance(env.client, env.deployment.external.musd, env.account!, line);
    const steps: TxStep[] = [];
    if (allowance < pull) {
      steps.push({
        label: `Allow the line to take up to ${formatMusd(pull)} MUSD`,
        detail: "MUSD.approve(line, amount)",
        tx: env.client.buildApprove({ token: env.deployment.external.musd, spender: line, amount: pull }),
      });
    }
    steps.push({
      label: full ? "Repay the whole loan" : `Repay ${formatMusd(pull)} MUSD`,
      detail: "VeBTCCreditLine.repay(loanId, amount)",
      tx: env.client.buildRepay({ loanId: loan.loanId, amount: pull }),
    });
    return {
      title: `Repay loan #${loan.loanId}`,
      summary: full
        ? `Repays the full debt and returns veBTC #${loan.tokenId} to your wallet.`
        : `Repays ${formatMusd(pull)} MUSD of the ${formatMusd(loan.debt)} MUSD debt.`,
      rows: [
        { label: "Debt now", value: `${formatMusd(loan.debt)} MUSD` },
        { label: "You repay", value: full ? `${formatMusd(loan.debt)} MUSD + interest to the second` : `${formatMusd(pull)} MUSD` },
        !full && { label: "Debt after", value: `${formatMusd(loan.debt - pull)} MUSD` },
      ],
      notes: full ? ["A 0.1% buffer covers interest accrued until the block; only what is owed is taken."] : undefined,
      steps,
      confirmLabel: "Repay",
    };
  };

  return (
    <Stack gap={3}>
      <AmountField
        label="Repay"
        unit="MUSD"
        value={input}
        onChange={setInput}
        aside={`Debt ${formatMusd(loan.debt)} MUSD`}
        onMax={() => setInput(toInput(loan.debt, 18, 6))}
        maxLabel="All"
        error={error}
        help="Repaying never needs the price feed. Anyone may repay any loan."
      />
      <Button disabled={!amount || !!error} onClick={() => tx.review(plan)}>
        Review repayment
      </Button>
    </Stack>
  );
}

function BorrowMoreForm({ env, loan, board }: { env: ReadyEnv; loan: LoanView; board: Board | undefined }) {
  const tx = useTx();
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const line = board?.lines.find((l) => l.kind === "VeBTC");
  const limit = loan.collateralValue === null ? null : (loan.collateralValue * loan.maxLtvBps) / BPS;
  const room = limit === null ? null : limit > loan.debt ? limit - loan.debt : 0n;
  const error =
    input && amount === null
      ? "Enter a number."
      : room !== null && amount !== null && amount > room
        ? `At most ${formatMusd(room)} MUSD keeps the loan under ${formatBps(loan.maxLtvBps, 0)} LTV.`
        : null;
  const after = amount !== null && loan.collateralValue ? ((loan.debt + amount) * BPS) / loan.collateralValue : null;
  const plan = (): TxPlan => ({
    title: `Borrow more on loan #${loan.loanId}`,
    summary: `Adds ${formatMusd(amount!)} MUSD to the debt; the NFT stays in its escrow.`,
    rows: [
      { label: "Debt after", value: `${formatMusd(loan.debt + amount!)} MUSD` },
      { label: "Loan-to-value after", value: formatBps(after) },
    ],
    blocked: loan.collateralValue === null ? "The BTC price feed is stale, so new borrowing is refused until it updates." : undefined,
    steps: [{ label: `Borrow ${formatMusd(amount!)} MUSD`, detail: "VeBTCCreditLine.borrowMore(loanId, amount)", tx: env.client.buildBorrowMore({ loanId: loan.loanId, amount: amount! }) }],
    confirmLabel: "Borrow",
  });
  return (
    <Stack gap={3}>
      <AmountField
        label="Borrow more"
        unit="MUSD"
        value={input}
        onChange={setInput}
        aside={room === null ? "Price feed stale" : `Room ${formatMusd(room)} MUSD`}
        onMax={room ? () => setInput(toInput(room, 18, 2)) : undefined}
        error={error}
        help={line?.paused ? "The line is paused for new borrowing." : `Same limits as opening: ${formatBps(loan.maxLtvBps, 0)} max LTV, line cash permitting.`}
      />
      <Button disabled={!amount || !!error || line?.paused === true} onClick={() => tx.review(plan())}>
        Review
      </Button>
    </Stack>
  );
}

function ExtendForm({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const tx = useTx();
  const now = useChainNow();
  const [weeks, setWeeks] = useState("4");
  if (loan.lock.isPermanent) {
    return <Muted small>Permanent locks have no end date, so there is nothing to extend.</Muted>;
  }
  const duration = Number(weeks) * WEEK;
  const plan = (): TxPlan => ({
    title: `Extend the lock of veBTC #${loan.tokenId}`,
    summary: `Sets the lock end to about ${weeks} week${weeks === "1" ? "" : "s"} from now (veBTC rounds down to whole weeks). The loan's maturity moves with it.`,
    rows: [
      { label: "Lock end now", value: loan.maturity === null ? "—" : formatDate(loan.maturity) },
      { label: "New lock end", value: now === null ? "—" : `≈ ${formatDate(Math.floor(now) + duration)}` },
    ],
    notes: ["A longer lock also raises the NFT's voting power from the next epoch."],
    blocked: loan.expired ? "The lock has already ended; veBTC does not extend an expired lock. Repay the loan instead." : undefined,
    steps: [{ label: "Extend the lock", detail: "VeBTCCreditLine.extend(loanId, duration)", tx: env.client.buildExtend({ loanId: loan.loanId, duration }) }],
    confirmLabel: "Extend",
  });
  return (
    <Stack gap={3}>
      <SelectField
        label="Extend the lock to"
        value={weeks}
        onChange={setWeeks}
        options={["1", "2", "3", "4"].map((w) => ({ value: w, label: `${w} week${w === "1" ? "" : "s"} from now` }))}
        help="veBTC's maximum lock is 4 weeks from now."
      />
      <Button onClick={() => tx.review(plan())}>Review extension</Button>
    </Stack>
  );
}

function AddCollateralForm({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const tx = useTx();
  const wallet = useWallet();
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const btc = wallet.data?.btc;
  const error =
    input && amount === null
      ? "Enter a number."
      : btc !== undefined && amount !== null && amount > btc
        ? `Your wallet holds ${formatBtc(btc)} BTC.`
        : null;
  const price = loan.collateralValue !== null && loan.lock.amount > 0n ? (loan.collateralValue * 10n ** 18n) / loan.lock.amount : null;
  const after =
    amount !== null && price !== null ? (loan.debt * BPS * 10n ** 18n) / ((loan.lock.amount + amount) * price) : null;
  const plan = async (): Promise<TxPlan> => {
    const line = env.deployment.contracts.veBTCLine;
    const allowance = await readAllowance(env.client, env.deployment.external.btc, env.account!, line);
    const steps: TxStep[] = [];
    if (allowance < amount!) {
      steps.push({
        label: `Allow the line to take ${formatBtc(amount!)} BTC`,
        detail: "BTC.approve(line, amount)",
        tx: env.client.buildApprove({ token: env.deployment.external.btc, spender: line, amount: amount! }),
      });
    }
    steps.push({
      label: `Add ${formatBtc(amount!)} BTC to the lock`,
      detail: "VeBTCCreditLine.addCollateral(loanId, btcAmount)",
      tx: env.client.buildAddCollateral({ loanId: loan.loanId, btcAmount: amount! }),
    });
    return {
      title: `Add collateral to loan #${loan.loanId}`,
      summary: `Locks ${formatBtc(amount!)} more BTC into veBTC #${loan.tokenId}. It stays locked until the lock end, like the rest.`,
      rows: [
        { label: "Locked after", value: `${formatBtc(loan.lock.amount + amount!)} BTC` },
        { label: "Loan-to-value after", value: formatBps(after) },
      ],
      steps,
      confirmLabel: "Add collateral",
    };
  };
  return (
    <Stack gap={3}>
      <AmountField
        label="Add BTC"
        unit="BTC"
        value={input}
        onChange={setInput}
        aside={btc !== undefined ? `Wallet: ${formatBtc(btc)} BTC` : undefined}
        onMax={btc ? () => setInput(toInput(btc, 18, 8)) : undefined}
        error={error}
        help="Raises the collateral value and lowers the loan-to-value."
      />
      <Button disabled={!amount || !!error} onClick={() => tx.review(plan)}>
        Review
      </Button>
    </Stack>
  );
}

function EscrowForm({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const tx = useTx();
  const [pool, setPool] = useState("");
  const valid = isAddress(pool.trim(), { strict: false });
  const vote = (): TxPlan => ({
    title: `Vote veBTC #${loan.tokenId} on Mezo`,
    summary: "Votes the escrowed NFT's full boosted power on Mezo's PoolsVoter for this pool. Only you, the borrower, can do this.",
    rows: [{ label: "Pool", value: pool.trim() }],
    steps: [
      {
        label: "Vote through the escrow",
        detail: "VeBTCCreditLine.escrowVote(loanId, pools, weights)",
        tx: buildEscrowVote(env.deployment, { loanId: loan.loanId, pools: [pool.trim() as Address], weights: [10_000n] }),
      },
    ],
    confirmLabel: "Vote",
  });
  const reset = (): TxPlan => ({
    title: "Clear the escrow's Mezo votes",
    summary: "Removes the NFT's current PoolsVoter votes.",
    steps: [{ label: "Reset votes", detail: "VeBTCCreditLine.escrowReset(loanId)", tx: buildEscrowReset(env.deployment, { loanId: loan.loanId }) }],
    confirmLabel: "Reset",
  });
  const rebase = (): TxPlan => ({
    title: "Claim the veBTC rebase",
    summary: "Claims the NFT's rebase: it compounds into the lock while the lock is live (raising your collateral).",
    steps: [
      {
        label: "Claim rebase",
        detail: "VeBTCCreditLine.escrowClaimRebase(loanId)",
        tx: buildEscrowClaimRebase(env.deployment, { loanId: loan.loanId }),
      },
    ],
    confirmLabel: "Claim",
  });
  return (
    <Stack gap={4}>
      <Muted small>
        The escrow can only vote, reset, claim, extend and add BTC for this one NFT, and only on your instruction. Fees
        and bribes it claims are forwarded to you.
      </Muted>
      <div className={styles.row2}>
        <TextField
          label="Mezo pool to vote for"
          value={pool}
          onChange={setPool}
          placeholder="0x…"
          mono
          error={pool && !valid ? "Paste a pool address (0x followed by 40 hex characters)." : undefined}
          help="The gauge pool address from Mezo's voting page."
        />
        <Button disabled={!valid} onClick={() => tx.review(vote())}>
          Review vote
        </Button>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button size="sm" variant="secondary" onClick={() => tx.review(rebase())}>
          Claim rebase
        </Button>
        <Button size="sm" variant="secondary" onClick={() => tx.review(reset())}>
          Reset Mezo votes
        </Button>
      </div>
    </Stack>
  );
}
