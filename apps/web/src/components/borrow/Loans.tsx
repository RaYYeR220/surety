"use client";

import { originationFee, type Board, type LoanView } from "@surety/sdk";
import { useState } from "react";

import { Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { ReadError } from "@/components/shell/EnvGate";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { Empty, Muted, Notice, Pill, SectionTitle, Skeleton, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, SelectField, Switch } from "@/components/ui/Controls";
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
import { isV2, useChainNow, useLineParams, useLoans, usePeg, useWallet } from "@/lib/queries";
import { readAllowance } from "@/lib/reads";

import styles from "./Borrow.module.css";
import { EscrowPanel } from "./EscrowPanel";
import { HealthBar } from "./HealthBar";

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

function LoanCard({ env, loan, board }: { env: ReadyEnv; loan: LoanView; board: Board | undefined }) {
  const now = useChainNow();
  const params = useLineParams().data;
  const [action, setAction] = useState<Action | null>(null);
  const inAuction = loan.state === "Auction";
  const left = loan.maturity === null || now === null ? null : Number(loan.maturity) - now;
  // v2 lines value BTC in MUSD (BTC/USD over the MUSD peg); v1 lines took MUSD as $1.
  const money = (wad: bigint) => (isV2(env) ? `${formatUsdWad(wad)} MUSD` : `$${formatUsdWad(wad)}`);

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
            someone bids and the NFT comes back to you. Repaying works even while the price feed is stale. Until then
            the escrow cannot vote or reset the NFT on Mezo; claiming its fees, bribes and rebase still works.
          </Notice>
        ) : loan.liquidatable ? (
          <Notice tone="danger" title="Past the liquidation line" role="alert">
            {loan.liquidationReason === "expiry"
              ? "The lock has ended. Anyone can start the auction now: repay to keep the NFT."
              : `Loan-to-value reached ${formatBps(loan.liqLtvBps, 0)}. Anyone can start the auction now: repay or add collateral to keep the NFT.`}
          </Notice>
        ) : null}

        <div className={styles.loanStats}>
          <Stat label="Debt" value={formatMusd(loan.debt)} unit="MUSD" />
          <Stat
            label="Collateral"
            value={formatBtc(loan.lock.amount)}
            unit="BTC"
            hint={loan.collateralValue === null ? "Price feed stale" : money(loan.collateralValue)}
          />
          <Stat
            label="Auction if BTC falls to"
            value={loan.liquidationPriceWad === null ? "—" : money(loan.liquidationPriceWad)}
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

        <HealthBar
          ltvBps={loan.ltvBps === null ? null : Number(loan.ltvBps)}
          lines={{
            maxLtvBps: Number(loan.maxLtvBps),
            liqLtvBps: Number(loan.liqLtvBps),
            // The floor is a line parameter; until it is read, draw it at the trigger.
            floorBps: params?.floorBps ?? Number(loan.liqLtvBps),
          }}
        />

        {isV2(env) ? <AutoRepay env={env} loan={loan} /> : null}

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
              ["escrow", inAuction ? "Rewards" : isV2(env) ? "Vote, rewards, harvest" : "Vote and rewards"],
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
            {action === "escrow" ? <EscrowPanel env={env} loan={loan} /> : null}
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

/** v2: let anyone harvest the escrowed NFT's fees and bribes into repayment. The switch follows the chain. */
function AutoRepay({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const tx = useTx();
  const mine = !!env.account && env.account.toLowerCase() === loan.borrower.toLowerCase();
  const plan = (enabled: boolean): TxPlan => ({
    title: enabled ? `Turn on auto-repay for loan #${loan.loanId}` : `Turn off auto-repay for loan #${loan.loanId}`,
    summary: enabled
      ? `From now on anyone may harvest veBTC #${loan.tokenId}'s Mezo fees and bribes into this loan: MUSD repays the debt, other tokens go to your wallet, and the rebase compounds into the lock. The keeper harvests after each Mezo epoch flip.`
      : "Only you will be able to harvest; fees and bribes wait until you claim or harvest them yourself.",
    notes: [
      "Harvesting never reads the price feed or the peg, and works while the loan is in auction.",
      "Repaying the whole debt through a harvest closes the loan and returns the NFT to you.",
    ],
    steps: [
      {
        label: enabled ? "Turn on auto-repay" : "Turn off auto-repay",
        detail: "VeBTCCreditLine.setAutoRepay(loanId, enabled)",
        tx: env.client.buildSetAutoRepay({ loanId: loan.loanId, enabled }),
      },
    ],
    confirmLabel: enabled ? "Turn on" : "Turn off",
  });
  return (
    <div className={styles.autoRepay}>
      <Switch
        checked={loan.autoRepay}
        onChange={(next) => tx.review(plan(next))}
        disabled={!mine}
        label={`Auto-repay ${loan.autoRepay ? "on" : "off"}`}
        description={
          loan.autoRepay
            ? "Anyone may harvest this loan's Mezo fees and bribes into repayment; the keeper does after each Mezo epoch."
            : "Turn it on and the NFT's Mezo fees and bribes pay the loan down, harvested by anyone."
        }
      />
    </div>
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
  const params = useLineParams().data;
  const peg = usePeg();
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const line = board?.lines.find((l) => l.kind === "VeBTC");
  const feeBps = params?.originationFeeBps ?? 0;
  const fee = amount === null ? 0n : originationFee(amount, feeBps);
  const offPeg = peg.data ? !peg.data.healthyOnChain : false;
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
    summary:
      fee > 0n
        ? `You receive ${formatMusd(amount! - fee)} MUSD and your debt grows by ${formatMusd(amount!)} MUSD; the NFT stays in its escrow.`
        : `Adds ${formatMusd(amount!)} MUSD to the debt; the NFT stays in its escrow.`,
    rows: [
      { label: "You receive", value: `${formatMusd(amount! - fee)} MUSD` },
      fee > 0n && { label: `Origination fee (${formatBps(feeBps, 2)})`, value: `${formatMusd(fee)} MUSD to the treasury` },
      { label: "Debt after", value: `${formatMusd(loan.debt + amount!)} MUSD` },
      { label: "Loan-to-value after", value: formatBps(after) },
    ],
    blocked:
      loan.collateralValue === null
        ? "The BTC price feed is stale, so new borrowing is refused until it updates."
        : offPeg
          ? "MUSD is off its peg, so the line refuses new borrowing until it recovers. Repaying still works."
          : undefined,
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
        help={
          line?.paused
            ? "The line is paused for new borrowing."
            : offPeg
              ? "MUSD is off its peg, so the line takes no new borrowing until it recovers."
              : fee > 0n
                ? `You receive ${formatMusd(amount! - fee)} MUSD after the ${formatBps(feeBps, 2)} origination fee; your debt grows by the full amount.`
                : `Same limits as opening: ${formatBps(loan.maxLtvBps, 0)} max LTV, line cash permitting.`
        }
      />
      {offPeg ? (
        <Notice tone="danger" title="New borrowing is paused">
          MUSD is off its peg. Repaying, adding collateral and harvesting still work. <AppLink href="/app/peg">See the peg</AppLink>
        </Notice>
      ) : null}
      <Button disabled={!amount || !!error || line?.paused === true || offPeg} onClick={() => tx.review(plan())}>
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
