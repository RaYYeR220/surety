"use client";

import type { Board, BoardLine } from "@surety/sdk";
import { useState } from "react";

import { Split, Stack } from "@/components/layout/Layout";
import { ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { Empty, KeyValues, Meter, Muted, Notice, Pill, Skeleton, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, SelectField, TabPanel, Tabs } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBtc, formatMusd, formatPct, formatUsdWad, parseAmount, toInput, wadToFraction } from "@/lib/format";
import { useMorphoPosition, useWallet } from "@/lib/queries";
import { readAllowance, type MorphoPosition } from "@/lib/reads";

import styles from "./Borrow.module.css";

const WAD = 10n ** 18n;
type Op = "supply" | "borrow" | "repay" | "withdraw";

/** LTV as a fraction for a position with `collateral` BTC and `debt` MUSD at `priceWad`. */
function ltvOf(collateral: bigint, debt: bigint, priceWad: bigint | null): number | null {
  if (priceWad === null) return null;
  const value = (collateral * priceWad) / WAD;
  if (value === 0n) return debt === 0n ? 0 : null;
  return Number((debt * 1_000_000n) / value) / 1_000_000;
}

export function MorphoPanel({ env, board }: { env: ReadyEnv; board: Board }) {
  const lines = board.lines.filter((l) => l.kind === "Morpho");
  const [lineId, setLineId] = useState<string>(lines[0]?.id.toString() ?? "");
  const line = lines.find((l) => l.id.toString() === lineId);
  if (!line) return <Empty title="No Morpho market listed">This deployment has no BTC line yet.</Empty>;
  return (
    <Stack gap={5}>
      {lines.length > 1 ? (
        <SelectField
          label="Market"
          value={lineId}
          onChange={setLineId}
          options={lines.map((l) => ({ value: l.id.toString(), label: l.name }))}
        />
      ) : null}
      <MarketView env={env} line={line} />
    </Stack>
  );
}

function MarketView({ env, line }: { env: ReadyEnv; line: BoardLine }) {
  const pos = useMorphoPosition(line);
  const wallet = useWalletDialog();
  const p = pos.data;
  const lltv = wadToFraction(line.marketParams?.lltv ?? null) ?? 0;
  const ltv = p ? ltvOf(p.collateral, p.debt, p.priceWad) : null;
  const liqPrice =
    p && p.collateral > 0n && p.debt > 0n && line.marketParams
      ? (p.debt * WAD * WAD) / (p.collateral * line.marketParams.lltv)
      : null;
  const tone = ltv === null ? "var(--color-ink-3)" : ltv >= lltv ? "var(--color-danger)" : ltv > lltv * 0.85 ? "var(--color-warning)" : "var(--color-positive)";

  return (
    <Split main="1fr" side="1fr" gap={5}>
      <Stack gap={5}>
        <Card
          title={line.name}
          description="A Morpho Blue market the vault lends into. Borrowers use Morpho directly; liquidations follow Morpho's own rules."
        >
          {pos.error ? <ReadError what="the market" error={pos.error} onRetry={() => void pos.refetch()} /> : null}
          <KeyValues
            label="Market"
            items={[
              { label: "Liquidation LTV (LLTV)", value: formatPct(lltv, 0) },
              {
                label: "BTC price (market oracle)",
                value: p ? (p.priceWad === null ? "stale" : `$${formatUsdWad(p.priceWad)}`) : "—",
              },
              { label: "Borrow APY (est.)", value: formatPct(line.borrowApy, 2) },
              { label: "Utilisation", value: formatPct(wadToFraction(line.utilizationWad)) },
              { label: "MUSD free to borrow", value: p ? `${formatMusd(p.liquidity, 0)} MUSD` : "—" },
            ]}
          />
          {p && p.priceWad === null ? (
            <div style={{ marginTop: "var(--space-4)" }}>
              <Notice tone="danger" title="Price feed stale">
                The oracle refuses to quote, so Morpho refuses new borrows and collateral withdrawals until it updates.
                Repaying and adding collateral still work.
              </Notice>
            </div>
          ) : null}
        </Card>
        <Card title="Your position">
          {!env.account ? (
            <Stack gap={3}>
              <Muted small>Connect a wallet to see and manage your position.</Muted>
              <div>
                <Button onClick={wallet.open}>Connect wallet</Button>
              </div>
            </Stack>
          ) : !p ? (
            <Skeleton height={140} label="Loading your position" />
          ) : (
            <Stack gap={4}>
              <div className={styles.loanStats} style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                <Stat label="Collateral" value={formatBtc(p.collateral)} unit="BTC" />
                <Stat label="Debt" value={formatMusd(p.debt)} unit="MUSD" />
                <Stat label="Can borrow up to" value={formatMusd(p.maxBorrow)} unit="MUSD" hint="At the LLTV, before any buffer" />
                <Stat
                  label="Liquidation if BTC falls to"
                  value={liqPrice === null ? "—" : `$${formatUsdWad(liqPrice)}`}
                />
              </div>
              <div className={styles.gauge}>
                <div className={styles.gaugeHead}>
                  <span>Loan-to-value</span>
                  <span className={styles.gaugeValue} style={{ color: tone }}>
                    {formatPct(ltv)}
                  </span>
                </div>
                <Meter
                  value={ltv ?? 0}
                  color={tone}
                  size="lg"
                  label="Loan-to-value"
                  valueText={`${formatPct(ltv)}; liquidation at ${formatPct(lltv, 0)}`}
                  markers={[{ at: lltv, label: `liquidation ${formatPct(lltv, 0)}`, color: "var(--color-danger)" }]}
                />
                <Muted small>
                  Health {p.health === null ? "—" : p.health.toFixed(2)} · below 1.00 the position can be liquidated.
                </Muted>
              </div>
            </Stack>
          )}
        </Card>
      </Stack>
      {env.account && p ? <MorphoActions env={env} line={line} p={p} /> : <span />}
    </Split>
  );
}

function MorphoActions({ env, line, p }: { env: ReadyEnv; line: BoardLine; p: MorphoPosition }) {
  const tx = useTx();
  const wallet = useWallet();
  const [op, setOp] = useState<Op>("supply");
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const account = env.account!;
  const params = p.params;
  const morpho = env.deployment.contracts.morpho;
  const btcToken = params.collateralToken;
  const musd = params.loanToken;
  const lltv = wadToFraction(params.lltv) ?? 0;

  const repayAll = op === "repay" && amount !== null && amount >= p.debt && p.debt > 0n;
  const nextCollateral =
    op === "supply" ? p.collateral + (amount ?? 0n) : op === "withdraw" ? p.collateral - (amount ?? 0n) : p.collateral;
  const nextDebt = op === "borrow" ? p.debt + (amount ?? 0n) : op === "repay" ? (repayAll ? 0n : p.debt - (amount ?? 0n)) : p.debt;
  const nextLtv = ltvOf(nextCollateral < 0n ? 0n : nextCollateral, nextDebt < 0n ? 0n : nextDebt, p.priceWad);
  const w = wallet.data;

  let error: string | null = null;
  if (input && amount === null) error = "Enter a number.";
  else if (amount !== null && amount > 0n) {
    if (op === "supply" && w && amount > w.btc) error = `Your wallet holds ${formatBtc(w.btc)} BTC.`;
    if (op === "withdraw" && amount > p.collateral) error = `You have ${formatBtc(p.collateral)} BTC supplied.`;
    if (op === "repay" && w && (repayAll ? p.debt : amount) > w.musd) error = `Your wallet holds ${formatMusd(w.musd)} MUSD.`;
    if (op === "borrow" && amount > p.liquidity) error = `The market has ${formatMusd(p.liquidity)} MUSD free.`;
    if ((op === "borrow" || op === "withdraw") && nextLtv !== null && nextLtv >= lltv)
      error = `That would put the position at ${formatPct(nextLtv)} LTV, past the ${formatPct(lltv, 0)} liquidation line.`;
    if ((op === "borrow" || op === "withdraw") && p.priceWad === null)
      error = "The price feed is stale: Morpho refuses this until it updates.";
  }

  const approveStep = async (token: `0x${string}`, need: bigint, what: string): Promise<TxStep | null> => {
    const allowance = await readAllowance(env.client, token, account, morpho);
    if (allowance >= need) return null;
    return {
      label: `Allow Morpho to take ${what}`,
      detail: "approve(Morpho, amount)",
      tx: env.client.buildApprove({ token, spender: morpho, amount: need }),
    };
  };

  const plan = async (): Promise<TxPlan> => {
    const a = amount!;
    const rows = [
      { label: "Collateral after", value: `${formatBtc(nextCollateral)} BTC` },
      { label: "Debt after", value: `${formatMusd(nextDebt)} MUSD` },
      { label: "Loan-to-value after", value: `${formatPct(nextLtv)} (liquidation ${formatPct(lltv, 0)})` },
    ];
    if (op === "supply") {
      const approve = await approveStep(btcToken, a, `${formatBtc(a)} BTC`);
      return {
        title: "Supply BTC collateral",
        summary: `Moves ${formatBtc(a)} BTC into your Morpho position as collateral.`,
        rows,
        steps: [
          ...(approve ? [approve] : []),
          {
            label: `Supply ${formatBtc(a)} BTC`,
            detail: "Morpho.supplyCollateral(market, assets, you)",
            tx: env.client.buildSupplyCollateral({ marketParams: params, assets: a, onBehalf: account }),
          },
        ],
        confirmLabel: "Supply",
      };
    }
    if (op === "borrow") {
      return {
        title: "Borrow MUSD",
        summary: `Borrows ${formatMusd(a)} MUSD from the market against your BTC.`,
        rows,
        notes: ["Interest follows Morpho's adaptive curve: it rises when the market is busy."],
        steps: [
          {
            label: `Borrow ${formatMusd(a)} MUSD`,
            detail: "Morpho.borrow(market, assets, 0, you, you)",
            tx: env.client.buildBorrow({ marketParams: params, assets: a, onBehalf: account, receiver: account }),
          },
        ],
        confirmLabel: "Borrow",
      };
    }
    if (op === "repay") {
      const need = repayAll ? p.debt + p.debt / 1000n + 1n : a;
      const approve = await approveStep(musd, need, `up to ${formatMusd(need)} MUSD`);
      return {
        title: repayAll ? "Repay the whole debt" : "Repay MUSD",
        summary: repayAll
          ? "Repays every borrow share, so no dust is left. Interest to the block is included."
          : `Repays ${formatMusd(a)} MUSD of your debt.`,
        rows,
        steps: [
          ...(approve ? [approve] : []),
          {
            label: repayAll ? "Repay all borrow shares" : `Repay ${formatMusd(a)} MUSD`,
            detail: repayAll ? "Morpho.repay(market, 0, shares, you)" : "Morpho.repay(market, assets, 0, you)",
            tx: repayAll
              ? env.client.buildRepayMorpho({ marketParams: params, shares: p.borrowShares, onBehalf: account })
              : env.client.buildRepayMorpho({ marketParams: params, assets: a, onBehalf: account }),
          },
        ],
        confirmLabel: "Repay",
      };
    }
    return {
      title: "Withdraw BTC collateral",
      summary: `Returns ${formatBtc(a)} BTC from your position to your wallet.`,
      rows,
      steps: [
        {
          label: `Withdraw ${formatBtc(a)} BTC`,
          detail: "Morpho.withdrawCollateral(market, assets, you, you)",
          tx: env.client.buildWithdrawCollateral({ marketParams: params, assets: a, onBehalf: account, receiver: account }),
        },
      ],
      confirmLabel: "Withdraw",
    };
  };

  const unit = op === "supply" || op === "withdraw" ? "BTC" : "MUSD";
  const max =
    op === "supply"
      ? w?.btc
      : op === "withdraw"
        ? p.collateral
        : op === "repay"
          ? p.debt
          : p.maxBorrow !== null && p.maxBorrow > p.debt
            ? ((p.maxBorrow - p.debt) * 95n) / 100n
            : 0n;

  return (
    <Card title="Manage" description={`Against ${line.name}. Every action previews the position after it.`}>
      <Stack gap={4}>
        <Tabs
          idPrefix="morpho"
          label="Action"
          value={op}
          onChange={(o) => {
            setOp(o);
            setInput("");
          }}
          tabs={[
            { id: "supply", label: "Supply BTC" },
            { id: "borrow", label: "Borrow" },
            { id: "repay", label: "Repay" },
            { id: "withdraw", label: "Withdraw BTC" },
          ]}
        />
        <TabPanel idPrefix="morpho" id={op}>
          <Stack gap={4}>
            <AmountField
              label={op === "supply" ? "Supply" : op === "borrow" ? "Borrow" : op === "repay" ? "Repay" : "Withdraw"}
              unit={unit}
              value={input}
              onChange={setInput}
              onMax={max !== undefined && max > 0n ? () => setInput(toInput(max, 18, unit === "BTC" ? 8 : 6)) : undefined}
              maxLabel={op === "borrow" ? "95% of max" : op === "repay" ? "All" : "Max"}
              aside={
                op === "supply" && w
                  ? `Wallet: ${formatBtc(w.btc)} BTC`
                  : op === "repay" && w
                    ? `Wallet: ${formatMusd(w.musd)} MUSD`
                    : undefined
              }
              error={error}
            />
            <KeyValues
              label="After"
              items={[
                { label: "Loan-to-value after", value: formatPct(nextLtv) },
                { label: "Liquidation at", value: formatPct(lltv, 0) },
              ]}
            />
            {nextLtv !== null && nextLtv > lltv * 0.85 && nextLtv < lltv ? (
              <Pill tone="warning" dot>
                Close to the liquidation line
              </Pill>
            ) : null}
            <Button block disabled={!amount || !!error} onClick={() => tx.review(plan)}>
              Review
            </Button>
          </Stack>
        </TabPanel>
      </Stack>
    </Card>
  );
}
