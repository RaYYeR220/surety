"use client";

import type { Board } from "@surety/sdk";
import { useState } from "react";

import { GATE_BLOCKED, GateNotice, isPaused } from "@/components/gate/DepositGate";
import { Split, Stack } from "@/components/layout/Layout";
import { PegBadge } from "@/components/peg/PegBadge";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { KeyValues, LineName, Muted, PageHead, Skeleton, StackBar, Stat, Tag } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, ExplorerLink, TabPanel, Tabs } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, formatMusd, formatPct, fraction, parseAmount, toInput, wadToFraction } from "@/lib/format";
import { lineColor } from "@/lib/lines";
import { isV2, useBoard, useFees, useReserve, useSavings, useWallet } from "@/lib/queries";
import { previewDeposit, previewWithdraw, readAllowance, type WalletState } from "@/lib/reads";

import styles from "./Lend.module.css";

/** sMUSD's recent yield, for the honest label next to the parked cash (Mezo's MUSD Savings Rate, Nov 2026). */
const SMUSD_YIELD_NOTE = "about 0.05% a year lately";

/**
 * What a withdrawal can take right now: the position, up to the MUSD that is not lent out. VaultV2 answers zero to
 * maxWithdraw, so this is worked out from the vault's idle MUSD (its own plus what is parked in sMUSD on v2, which
 * withdrawals pull from first).
 */
export function withdrawableNow(w: WalletState, board: Board): bigint {
  return w.sharesValue < board.vault.idle ? w.sharesValue : board.vault.idle;
}

export function LendPage() {
  return <EnvGate>{(env) => <LendView env={env} />}</EnvGate>;
}

function LendView({ env }: { env: ReadyEnv }) {
  const board = useBoard();
  const v2 = isV2(env);
  return (
    <Stack gap={6}>
      <PageHead
        title="Lend"
        lead="Deposit MUSD into the Surety vault and get srMUSD. The vault lends it to the lines veBTC holders vote for, and the voters' rewards stand in front of you if a line takes a loss."
        actions={<PegBadge />}
      />
      {board.error ? <ReadError what="the vault" error={board.error} onRetry={() => void board.refetch()} /> : null}
      {board.data ? <GateNotice board={board.data} context="deposit" /> : null}
      <Split main="1fr" side="1fr" gap={5}>
        <Stack gap={5}>
          <PositionCard env={env} board={board.data} />
          {board.data ? <DepositWithdraw env={env} board={board.data} /> : <Skeleton height={260} />}
          {board.data ? <Fees env={env} board={board.data} /> : <Skeleton height={200} />}
        </Stack>
        <Stack gap={5}>
          {board.data ? <WhereItIs board={board.data} /> : <Skeleton height={260} label="Loading allocation" />}
          {v2 ? <IdleCash env={env} /> : null}
          {board.data ? <Waterfall board={board.data} /> : <Skeleton height={300} />}
        </Stack>
      </Split>
    </Stack>
  );
}

/* ---------- Idle cash in sMUSD (v2) ---------- */

function IdleCash({ env }: { env: ReadyEnv }) {
  const tx = useTx();
  const savings = useSavings();
  const s = savings.data;
  const harvest = (): TxPlan => ({
    title: "Harvest the sMUSD yield",
    summary: `Claims ${formatMusd(s!.claimableYield, 4)} MUSD of yield sMUSD owes the vault's parked cash and parks it again. Anyone can do this; it raises the share price for every lender.`,
    steps: [
      {
        label: "Harvest and re-park",
        detail: "SavingsAdapter.harvest()",
        tx: env.client.buildSavingsHarvest(),
      },
    ],
    confirmLabel: "Harvest",
  });
  return (
    <Card
      title="Idle cash, parked in sMUSD"
      description="MUSD that is not lent out sits in Mezo's MUSD Savings Rate vault (sMUSD) instead of doing nothing. Deposits land there and withdrawals draw from it first."
    >
      {savings.error ? (
        <ReadError what="the vault's savings" error={savings.error} onRetry={() => void savings.refetch()} />
      ) : !s ? (
        <Skeleton height={160} label="Reading the vault's savings" />
      ) : (
        <Stack gap={4}>
          <div className={styles.idle}>
            <Stat label="In the vault" value={formatMusd(s.vaultIdle, 0)} unit="MUSD" size="sm" />
            <Stat label="Parked in sMUSD" value={formatMusd(s.parked, 0)} unit="MUSD" size="sm" />
            <Stat label="Idle in total" value={formatMusd(s.idle, 0)} unit="MUSD" size="sm" hint="Pays withdrawals and cover" />
          </div>
          <KeyValues
            label="Savings"
            items={[
              {
                label: "Parking",
                value: s.parking === null ? "—" : s.parking ? "On: sMUSD is the vault's liquidity adapter" : "Off: idle MUSD stays in the vault",
              },
              {
                label: (
                  <>
                    sMUSD yield <Tag title="Mezo's MUSD Savings Rate pays what its strategy earns; it has been very small.">approx.</Tag>
                  </>
                ),
                value: SMUSD_YIELD_NOTE,
              },
              { label: "Yield claimable now", value: s.claimableYield === null ? "—" : `${formatMusd(s.claimableYield, 4)} MUSD` },
              { label: "Yield paid so far", value: s.yieldClaimed === null ? "—" : `${formatMusd(s.yieldClaimed, 4)} MUSD` },
              { label: "Adapter", value: <ExplorerLink kind="address" value={s.adapter} /> },
            ]}
          />
          <Muted small>
            The yield is tiny today, so parking is about keeping idle MUSD in a Mezo-native place that pays something,
            not about returns. It never takes votes and is never lent; the voters&apos; fee on its yield goes to the pool reserve, not to a
            line&apos;s voters.
          </Muted>
          {s.claimableYield !== null && s.claimableYield > 0n ? (
            <div>
              <Button size="sm" variant="secondary" onClick={() => tx.review(harvest())}>
                Harvest yield (anyone can)
              </Button>
            </div>
          ) : null}
        </Stack>
      )}
    </Card>
  );
}

/* ---------- What lending costs ---------- */

function Fees({ env, board }: { env: ReadyEnv; board: Board }) {
  const fees = useFees();
  const v2 = isV2(env);
  const perf = wadToFraction(fees.data?.performanceFee ?? board.vault.performanceFee);
  const mgmt = fees.data ? wadToFraction(fees.data.managementFeeAprWad) : null;
  const market = fees.data?.shareMarketFeeBps ?? null;
  return (
    <Card title="What lending costs" description="Every fee a lender meets, read from the contracts.">
      {v2 && fees.error ? (
        <ReadError what="the fee schedule" error={fees.error} onRetry={() => void fees.refetch()} />
      ) : v2 && !fees.data ? (
        <Skeleton height={140} label="Reading the fee schedule" />
      ) : (
        <Stack gap={3}>
          <KeyValues
            label="Lender fees"
            items={[
              { label: "Deposit or withdraw", value: "No fee" },
              {
                label: "Voters' fee",
                value: `${formatPct(perf, 0)} of interest, to the voters' first-loss pool`,
              },
              v2 && {
                label: "Management fee",
                value: `${formatPct(mgmt, 2)} a year of vault assets, to the treasury`,
              },
              v2 &&
                market !== null && {
                  label: "Share market",
                  value: `${formatBps(market, 2)} of a fill, only if you sell shares there`,
                },
            ]}
          />
          <Muted small>
            {v2
              ? "The management fee is taken as new srMUSD, so it shows up as a slightly slower share price, never as a charge on your wallet. "
              : "This deployment charges no management fee. "}
            The voters&apos; fee is what pays veBTC holders to stand first in line for losses.{" "}
            <AppLink href="/app/business">Who pays whom</AppLink>
          </Muted>
        </Stack>
      )}
    </Card>
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
            value={board ? formatMusd(withdrawableNow(wallet.data, board)) : "—"}
            unit="MUSD"
            size="sm"
            hint={isV2(env) ? "Paid from idle MUSD and sMUSD" : "Paid from the vault's idle MUSD"}
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
  // The DepositGate refuses new srMUSD while a loss or its cover is pending; withdrawals are never gated.
  const gated = mode === "deposit" && isPaused(board);

  const canWithdraw = w ? withdrawableNow(w, board) : null;
  const fees = useFees();
  const mgmtLabel = fees.data ? formatPct(wadToFraction(fees.data.managementFeeAprWad), 2) : "small";
  let error: string | null = null;
  if (input && amount === null) error = "Enter a number, like 250 or 99.5.";
  else if (amount !== null && w) {
    if (mode === "deposit" && amount > w.musd) error = `Your wallet holds ${formatMusd(w.musd)} MUSD.`;
    if (mode === "withdraw" && amount > w.sharesValue) error = `Your position is worth ${formatMusd(w.sharesValue)} MUSD.`;
    else if (mode === "withdraw" && canWithdraw !== null && amount > canWithdraw)
      error = `The vault can pay ${formatMusd(canWithdraw)} MUSD right now from idle funds. The rest frees up as loans repay and at the next rebalance${isV2(env) ? ", or sell srMUSD on the share market now" : ""}.`;
  }
  const ready = !!account && amount !== null && amount > 0n && !error && !gated;

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
        `Withdrawals are paid from idle MUSD (target ${formatBps(board.vault.idleBufferBps, 0)} of the vault)${isV2(env) ? ", which is parked in sMUSD until it is lent or withdrawn" : ""}.`,
        ...(isV2(env)
          ? [`A ${mgmtLabel} yearly management fee goes to the treasury as new srMUSD; it shows as a slightly slower share price.`]
          : []),
        "While a loss or its cover is pending, the vault's DepositGate pauses deposits so newcomers cannot skim the cover. Withdrawals never pause.",
      ],
      blocked: isPaused(board) ? GATE_BLOCKED.deposit : undefined,
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
                      setInput(toInput(mode === "deposit" ? w.musd : (canWithdraw ?? w.sharesValue)))
                  : undefined
              }
              error={error}
              help={
                mode === "deposit"
                  ? `Est. APY ${formatPct(board.vault.supplyApy, 2)} · voters' fee ${formatPct(wadToFraction(board.vault.performanceFee), 0)} of interest`
                  : `${isPaused(board) ? "Withdrawals stay open while deposits are paused. " : "No fee to withdraw. "}Paid from ${formatMusd(board.vault.idle, 0)} MUSD idle${isV2(env) ? " (the vault's own plus what is parked in sMUSD)" : ""}; larger exits wait for repayments or the next rebalance.`
              }
            />
            {mode === "withdraw" && isV2(env) && w && canWithdraw !== null && canWithdraw < w.sharesValue ? (
              <Muted small>
                Need out sooner than the idle cash allows? List srMUSD at a discount on the{" "}
                <AppLink href="/app/market">share market</AppLink>.
              </Muted>
            ) : null}
            <Button
              block
              disabled={!ready}
              title={gated ? GATE_BLOCKED.deposit : undefined}
              onClick={() => tx.review(mode === "deposit" ? depositPlan : withdrawPlan)}
            >
              {gated ? "Deposits paused" : mode === "deposit" ? "Review deposit" : "Review withdrawal"}
            </Button>
            {gated ? (
              <Muted small>
                Deposits reopen on their own once the loss is covered and back in the share price. Withdrawals stay
                open: switch to Withdraw.
              </Muted>
            ) : !account ? (
              <Muted small>Connect a wallet to deposit.</Muted>
            ) : null}
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
            {board.vault.parked ? "Idle, in the vault and sMUSD" : "Idle (withdrawals and cover)"}
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
                <Muted small>{l.kind === "Morpho" ? "Morpho" : "veBTC"}</Muted> {formatMusd(amount, 0)} MUSD
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
