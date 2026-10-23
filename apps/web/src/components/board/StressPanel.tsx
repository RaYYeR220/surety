"use client";

import { MEZO_TESTNET_ID } from "@surety/sdk";
import { useState } from "react";

import { Stack } from "@/components/layout/Layout";
import { useTx } from "@/components/tx/TxProvider";
import { KeyValues, Muted, Notice } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SelectField, Slider } from "@/components/ui/Controls";
import { buildShock } from "@/lib/builders";
import type { ReadyEnv } from "@/lib/env";
import { formatDateTime, formatDuration, formatUsdWad } from "@/lib/format";
import { useChainNow, useStress } from "@/lib/queries";

import styles from "./Board.module.css";

const DURATIONS = ["600", "1800", "3600", "7200"] as const;

/** Testnet only: shock the BTC price the lines use, to watch liquidations, auctions and first loss happen. */
export function StressPanel({ env }: { env: ReadyEnv }) {
  const stress = useStress();
  const now = useChainNow();
  const tx = useTx();
  const [pct, setPct] = useState(30);
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]>("1800");

  if (env.chainId !== MEZO_TESTNET_ID) return null;
  if (!stress.data) return null;
  const s = stress.data;
  const maxPct = Math.floor(s.maxHaircutBps / 100);
  const active = s.haircutBps > 0 && now !== null && now < Number(s.shockEndsAt);
  const base = s.basePriceWad;
  const shocked = base === null ? null : (base * BigInt(10_000 - pct * 100)) / 10_000n;
  const durations = DURATIONS.filter((d) => Number(d) <= s.maxDuration);

  const review = () =>
    tx.review({
      title: "Shock the BTC price (testnet)",
      summary: `Every Surety line on testnet values BTC ${pct}% lower for ${formatDuration(Number(duration))}. Use it to watch enforcement happen on chain.`,
      rows: [
        { label: "BTC price now", value: `$${formatUsdWad(s.priceWad)}` },
        { label: "BTC price during the shock", value: `$${formatUsdWad(shocked)}` },
        { label: "Lasts", value: formatDuration(Number(duration)) },
      ],
      notes: [
        "veBTC loans at or above 70% LTV become auctionable; anyone can start the Dutch auction.",
        "Morpho positions above the 86% liquidation LTV can be liquidated by Morpho's own rules.",
        "If an auction or liquidation closes below the debt, the shortfall is recorded and cover takes it from the voters' seasoning rewards first.",
        "A new shock replaces the current one. Mainnet has no stress source: it reads the Skip price directly.",
      ],
      steps: [
        {
          label: `Apply a ${pct}% haircut for ${formatDuration(Number(duration))}`,
          detail: "StressedPriceSource.shock(bps, duration)",
          tx: buildShock(env.deployment, { bps: pct * 100, duration: Number(duration) }),
        },
      ],
      confirmLabel: "Apply shock",
    });

  return (
    <Card
      tone="warning"
      eyebrow={<span className={styles.testnetBadge}>Testnet only</span>}
      title="Stress test: shock the BTC price"
      description="Anyone can apply a temporary haircut to the price the testnet lines use. It is how a live bad-debt event is produced on demand, so you can watch the safeguards work."
    >
      <div className={styles.stress}>
        <Stack gap={3}>
          <KeyValues
            label="Price source"
            items={[
              { label: "BTC price the lines use", value: `$${formatUsdWad(s.priceWad)}` },
              { label: "Unstressed (Skip) price", value: `$${formatUsdWad(s.basePriceWad)}` },
              {
                label: "Shock",
                value: active
                  ? `−${(s.haircutBps / 100).toFixed(0)}% until ${formatDateTime(s.shockEndsAt)}`
                  : "None active",
              },
            ]}
          />
          {s.priceWad === null ? (
            <Notice tone="danger" title="Price feed stale">
              The lines are failing closed: no new loans, no auctions, no new allocation. Repaying still works.
            </Notice>
          ) : null}
        </Stack>
        <div className={styles.stressControls}>
          <div>
            <Muted small>Haircut: {pct}%</Muted>
            <Slider
              value={pct}
              onChange={setPct}
              min={5}
              max={maxPct}
              step={5}
              label="Price haircut in percent"
              valueText={`${pct}%`}
              color="var(--color-warning)"
            />
          </div>
          <SelectField
            label="Duration"
            value={duration}
            onChange={setDuration}
            options={durations.map((d) => ({ value: d, label: formatDuration(Number(d)) }))}
          />
          <p className={styles.preview}>
            ${formatUsdWad(base)} → ${formatUsdWad(shocked)}
          </p>
          <Button variant="secondary" onClick={review}>
            Review shock
          </Button>
        </div>
      </div>
    </Card>
  );
}
