"use client";

import type { Board } from "@surety/sdk";
import { useState } from "react";

import { Split, Stack } from "@/components/layout/Layout";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { LineName, Muted, PageHead, Skeleton, StackBar, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, TabPanel, Tabs } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, formatMusd, formatPct, fraction, parseAmount, toInput, wadToFraction } from "@/lib/format";
import { lineColor } from "@/lib/lines";
import { useBoard, useReserve, useWallet } from "@/lib/queries";
import { previewDeposit, previewWithdraw, readAllowance } from "@/lib/reads";

import styles from "./Lend.module.css";

export function LendPage() {
  return <EnvGate>{(env) => <LendView env={env} />}</EnvGate>;
}

function LendView({ env }: { env: ReadyEnv }) {
  const board = useBoard();
  return (
    <Stack gap={6}>
      <PageHead
        title="Lend"
        lead="Deposit MUSD into the Surety vault and get srMUSD. The vault lends it to the lines veBTC holders vote for, and the voters' rewards stand in front of you if a line takes a loss."
      />
      {board.error ? <ReadError what="the vault" error={board.error} onRetry={() => void board.refetch()} /> : null}
      <Split main="1fr" side="1fr" gap={5}>
        <Stack gap={5}>
          <PositionCard env={env} board={board.data} />
          {board.data ? <DepositWithdraw env={env} board={board.data} /> : <Skeleton height={260} />}
        </Stack>
        <Stack gap={5}>
          {board.data ? <WhereItIs board={board.data} /> : <Skeleton height={260} label="Loading allocation" />}
          {board.data ? <Waterfall board={board.data} /> : <Skeleton height={300} />}
        </Stack>
      </Split>
    </Stack>
  );
}

function PositionCard({ env, board }: { env: ReadyEnv; board: Board | undefined }) {
  const wallet = useWallet();
  const dialog = useWalletDialog();
  const symbol = board?.vault.symbol || "srMUSD";
  if (!env.account) {
    return (
      <Card title="Your position" description="Connect a wallet to see your srMUSD and deposit.">
        <Button onClick={dialog.open}>Connect wallet</Button>
      </Card>
    );
  }
  return (
    <Card title="Your position">
      {wallet.error ? (
        <ReadError what="your balances" error={wallet.error} onRetry={() => void wallet.refetch()} />
      ) : !wallet.data ? (
        <Skeleton height={90} label="Loading your balances" />
      ) : (
        <div className={styles.position}>
          <Stat label={`${symbol} held`} value={formatMusd(wallet.data.shares)} unit={symbol} size="lg" />
          <Stat label="Worth now" value={formatMusd(wallet.data.sharesValue)} unit="MUSD" size="lg" />
          <Stat label="MUSD in wallet" value={formatMusd(wallet.data.musd)} unit="MUSD" size="sm" />
          <Stat
            label="Withdrawable right now"
            value={formatMusd(wallet.data.maxWithdraw)}
            unit="MUSD"
            size="sm"
            hint="Paid from the vault's idle MUSD"
          />
        </div>
      )}
    </Card>
  );
}

type Mode = "deposit" | "withdraw";

function DepositWithdraw({ env, board }: { env: ReadyEnv; board: Board }) {
  const tx = useTx();
  const wallet = useWallet();
  const [mode, setMode] = useState<Mode>("deposit");
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const symbol = board.vault.symbol || "srMUSD";
  const w = wallet.data;
  const account = env.account;

  let error: string | null = null;
  if (input && amount === null) error = "Enter a number, like 250 or 99.5.";
  else if (amount !== null && w) {
    if (mode === "deposit" && amount > w.musd) error = `Your wallet holds ${formatMusd(w.musd)} MUSD.`;
    if (mode === "withdraw" && amount > w.sharesValue) error = `Your position is worth ${formatMusd(w.sharesValue)} MUSD.`;
    else if (mode === "withdraw" && w.maxWithdraw !== null && amount > w.maxWithdraw)
      error = `The vault can pay ${formatMusd(w.maxWithdraw)} MUSD right now from idle funds. The rest frees up at the next rebalance.`;
  }
  const ready = !!account && amount !== null && amount > 0n && !error;

  const depositPlan = async (): Promise<TxPlan> => {
    const a = amount!;
    const c = env.deployment.contracts;
    const [allowance, shares] = await Promise.all([
      readAllowance(env.client, env.deployment.external.musd, account!, c.vault),
      previewDeposit(env.client, a),
    ]);
    const steps: TxStep[] = [];
    if (allowance < a) {
      steps.push({
        label: `Allow the vault to take ${formatMusd(a)} MUSD`,
        detail: "MUSD.approve(vault, amount): exactly this amount, nothing more",
        tx: env.client.buildApprove({ token: env.deployment.external.musd, spender: c.vault, amount: a }),
      });
    }
    steps.push({
      label: `Deposit ${formatMusd(a)} MUSD`,
      detail: "Vault.deposit(assets, you)",
      tx: env.client.buildDeposit({ assets: a, receiver: account! }),
    });
    return {
      title: "Deposit MUSD",
      summary: `You deposit ${formatMusd(a)} MUSD and receive ${symbol}, which grows as the lines pay interest.`,
      rows: [
        { label: "You deposit", value: `${formatMusd(a)} MUSD` },
        { label: "You receive (about)", value: shares === null ? "—" : `${formatMusd(shares)} ${symbol}` },
        { label: `1 ${symbol}`, value: `${formatMusd(board.vault.sharePrice, 4)} MUSD` },
        { label: "Depositor APY (est.)", value: formatPct(board.vault.supplyApy, 2) },
      ],
      notes: [
        "veBTC votes decide which lines your MUSD goes to, inside caps set per line.",
        "If a line takes bad debt, the voters' seasoning rewards and the reserve pay first; lenders only lose what is left.",
        `Withdrawals are paid from idle MUSD (target ${formatBps(board.vault.idleBufferBps, 0)} of the vault).`,
      ],
      steps,
      confirmLabel: steps.length > 1 ? "Approve and deposit" : "Deposit",
    };
  };

  const withdrawPlan = async (): Promise<TxPlan> => {
    const a = amount!;
    const all = w !== undefined && a >= w.sharesValue;
    const shares = all ? w!.shares : await previewWithdraw(env.client, a);
    return {
      title: "Withdraw MUSD",
      summary: all
        ? `You redeem all your ${symbol} for MUSD.`
        : `You withdraw ${formatMusd(a)} MUSD; the matching ${symbol} is burned.`,
      rows: [
        { label: "You receive", value: `${all ? "about " : ""}${formatMusd(all ? w!.sharesValue : a)} MUSD` },
        { label: `${symbol} burned`, value: shares === null ? "—" : `${formatMusd(shares)} ${symbol}` },
      ],
      steps: [
        all
          ? {
              label: `Redeem ${formatMusd(w!.shares)} ${symbol}`,
              detail: "Vault.redeem(shares, you, you): exits the whole position without dust",
              tx: env.client.buildRedeem({ shares: w!.shares, receiver: account!, owner: account! }),
            }
          : {
              label: `Withdraw ${formatMusd(a)} MUSD`,
              detail: "Vault.withdraw(assets, you, you)",
              tx: env.client.buildWithdraw({ assets: a, receiver: account!, owner: account! }),
            },
      ],
      confirmLabel: "Withdraw",
    };
  };

  return (
    <Card title="Deposit or withdraw">
      <Stack gap={4}>
        <Tabs
          idPrefix="lend"
          label="Deposit or withdraw"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setInput("");
          }}
          tabs={[
            { id: "deposit", label: "Deposit" },
            { id: "withdraw", label: "Withdraw" },
          ]}
        />
        <TabPanel idPrefix="lend" id={mode}>
          <Stack gap={4}>
            <AmountField
              label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
              unit="MUSD"
              value={input}
              onChange={setInput}
              aside={
                w
                  ? mode === "deposit"
                    ? `Wallet: ${formatMusd(w.musd)} MUSD`
                    : `Position: ${formatMusd(w.sharesValue)} MUSD`
                  : undefined
              }
              onMax={
                w
                  ? () =>
                      setInput(
                        toInput(
                          mode === "deposit"
                            ? w.musd
                            : w.maxWithdraw !== null && w.maxWithdraw < w.sharesValue
                              ? w.maxWithdraw
                              : w.sharesValue,
                        ),
                      )
                  : undefined
              }
              error={error}
              help={
                mode === "deposit"
                  ? `Est. APY ${formatPct(board.vault.supplyApy, 2)} · voters' fee ${formatPct(wadToFraction(board.vault.performanceFee), 0)} of interest`
                  : "No fee to withdraw. Large exits can wait for idle MUSD after the next rebalance."
              }
            />
            <Button
              block
              disabled={!ready}
              onClick={() => tx.review(mode === "deposit" ? depositPlan : withdrawPlan)}
            >
              {mode === "deposit" ? "Review deposit" : "Review withdrawal"}
            </Button>
            {!account ? <Muted small>Connect a wallet to deposit.</Muted> : null}
          </Stack>
        </TabPanel>
      </Stack>
    </Card>
  );
}

function WhereItIs({ board }: { board: Board }) {
  const total = board.vault.totalAssets;
  const parts = [
    ...board.lines.map((l) => ({
      key: `line-${l.id}`,
      id: l.id,
      name: l.name,
      amount: l.allocation ?? 0n,
      color: lineColor(l.id),
    })),
  ];
  return (
    <Card
      title="Where the vault's MUSD is now"
      description={`${formatMusd(total, 0)} MUSD in total, split by last epoch's votes inside each line's cap.`}
    >
      <StackBar
        label="Vault allocation by line"
        segments={[
          ...parts.map((p) => ({
            key: p.key,
            value: fraction(p.amount, total),
            color: p.color,
            label: `${p.name}: ${formatMusd(p.amount, 0)} MUSD`,
          })),
          { key: "idle", value: fraction(board.vault.idle, total), color: "var(--line-idle)", label: "Idle", hatched: true },
        ]}
      />
      <ul className={styles.legend}>
        {parts.map((p) => (
          <li key={p.key} className={styles.legendRow}>
            <LineName id={p.id} name={p.name} />
            <span className="num">{formatMusd(p.amount, 0)} MUSD</span>
            <span className="num">{formatPct(fraction(p.amount, total))}</span>
          </li>
        ))}
        <li className={styles.legendRow}>
          <span className={styles.idleName}>
            <span className={styles.idleSwatch} aria-hidden="true" />
            Idle (withdrawals and cover)
          </span>
          <span className="num">{formatMusd(board.vault.idle, 0)} MUSD</span>
          <span className="num">{formatPct(fraction(board.vault.idle, total))}</span>
        </li>
      </ul>
    </Card>
  );
}

function Waterfall({ board }: { board: Board }) {
  const reserve = useReserve();
  const reserveAssets = reserve.data?.assets ?? null;
  const cohorts = board.lines.map((l) => ({
    l,
    amount:
      l.coverCapacity === null
        ? null
        : reserveAssets === null
          ? l.coverCapacity
          : l.coverCapacity > reserveAssets
            ? l.coverCapacity - reserveAssets
            : 0n,
  }));
  return (
    <Card
      title="If a line goes bad"
      description="Who pays a recorded loss, in this order. The contracts never take more than the recorded loss."
    >
      <ol className={styles.waterfall}>
        <li className={`${styles.fall} ${styles.fallFirst}`}>
          <span className={styles.step}>1</span>
          <div>
            <div className={styles.fallTitle}>That line&apos;s voters</div>
            <div className={styles.fallText}>Their seasoning rewards for the line, pro rata.</div>
          </div>
          <div className={styles.fallValue}>
            {cohorts.map(({ l, amount }) => (
              <div key={l.id}>
                {formatMusd(amount, 0)} <Muted small>{l.name.split(" (")[0]}</Muted>
              </div>
            ))}
          </div>
        </li>
        <li className={styles.fall}>
          <span className={styles.step}>2</span>
          <div>
            <div className={styles.fallTitle}>Pool reserve</div>
            <div className={styles.fallText}>Fees no line could claim, shared by all lines.</div>
          </div>
          <div className={styles.fallValue}>{reserveAssets === null ? "—" : `${formatMusd(reserveAssets, 0)} MUSD`}</div>
        </li>
        <li className={`${styles.fall} ${styles.fallLast}`}>
          <span className={styles.step}>3</span>
          <div>
            <div className={styles.fallTitle}>Lenders</div>
            <div className={styles.fallText}>Only what is left, through the vault&apos;s share price.</div>
          </div>
          <div className={styles.fallValue}>{formatMusd(board.vault.totalAssets, 0)} MUSD lent</div>
        </li>
      </ol>
    </Card>
  );
}
