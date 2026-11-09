"use client";

import { MEZO_TESTNET_ID, WAD, type PegView } from "@surety/sdk";
import { useState } from "react";

import { Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { useTx, type TxPlan } from "@/components/tx/TxProvider";
import { KeyValues, Muted, Notice } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SelectField } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatDateTime, formatDuration, formatPegUsd } from "@/lib/format";
import { pegUnderStress, stressedSourceIndex } from "@/lib/peg";
import { useChainNow } from "@/lib/queries";

import styles from "./Peg.module.css";

const PRICES = [
  { value: "0.95", label: "$0.95 (5% under the peg)" },
  { value: "0.97", label: "$0.97 (3% under)" },
  { value: "0.90", label: "$0.90 (10% under)" },
  { value: "0", label: "No reading (source offline)" },
] as const;

const DURATIONS = [
  { value: "7200", label: "2 hours" },
  { value: "3600", label: "1 hour" },
  { value: "1800", label: "30 minutes" },
  { value: "600", label: "10 minutes" },
] as const;

type Price = (typeof PRICES)[number]["value"];
type Duration = (typeof DURATIONS)[number]["value"];

const toWad = (p: Price): bigint => (p === "0" ? 0n : (BigInt(Math.round(Number(p) * 1e6)) * WAD) / 1_000_000n);

/**
 * Testnet only: push the StressedPegSource off the peg so anyone can watch the breaker refuse new loans live.
 * Renders nothing on a network without the switch.
 */
export function DepegSimulator({ env, peg }: { env: ReadyEnv; peg: PegView }) {
  const tx = useTx();
  const now = useChainNow();
  const [price, setPrice] = useState<Price>("0.95");
  const [duration, setDuration] = useState<Duration>("7200");
  const switchAddress = env.deployment.contracts.stressedPegSource;
  const index = stressedSourceIndex(peg, switchAddress);

  if (!switchAddress || index === null) {
    if (env.chainId !== MEZO_TESTNET_ID) {
      return (
        <Muted small>
          This network has no depeg switch: its peg reads only Mezo&apos;s markets. The testnet deployment has one, so
          anyone can trip the breaker there.
        </Muted>
      );
    }
    return null;
  }

  const wad = toWad(price);
  const seconds = Number(duration);
  const after = pegUnderStress(peg, index, wad);
  const active = peg.stress?.active === true && (now === null || now < Number(peg.stress.endsAt));
  const left = active && now !== null && peg.stress ? Number(peg.stress.endsAt) - now : null;
  const choice = PRICES.find((p) => p.value === price)!.label;
  const span = DURATIONS.find((d) => d.value === duration)!.label;

  const verdict = !after.healthy
    ? `Trips the breaker: the median would read ${formatPegUsd(after.medianWad)}${after.offPegBps !== null ? `, ${after.offPegBps} bps from $1` : ""}. New loans revert until it ends.`
    : `Does not trip the breaker here: the other sources would hold the median at ${formatPegUsd(after.medianWad)}, inside the band. Pick a deeper depeg, or an outage when the switch is one of the few sources.`;

  const plan = (): TxPlan => ({
    title: "Simulate a MUSD depeg (testnet)",
    summary: `The testnet switch reads ${price === "0" ? "nothing" : `$${price}`} for ${formatDuration(seconds)}. ${after.healthy ? "With the other sources' readings now, the peg would still pass." : "The peg check fails, so the veBTC line refuses new loans until it ends."}`,
    rows: [
      { label: "Switch reads", value: price === "0" ? "No reading" : `$${price}` },
      { label: "Lasts", value: formatDuration(seconds) },
      { label: "Median after", value: formatPegUsd(after.medianWad) },
      { label: "New loans", value: after.healthy ? "Still open" : "Refused (PegUnhealthy)" },
    ],
    notes: [
      "Anyone can do this on testnet. It ends on its own; a new simulation replaces the running one.",
      "Repaying, auctions, deposits and withdrawals keep working while it runs.",
      "Mainnet has no switch: its peg reads only Mezo's markets.",
    ],
    steps: [
      {
        label: `Push the switch to ${price === "0" ? "no reading" : `$${price}`} for ${formatDuration(seconds)}`,
        detail: "StressedPegSource.stress(musdUsdWad, duration)",
        tx: env.client.buildStressPeg({ musdUsdWad: wad, duration: seconds }),
      },
    ],
    confirmLabel: "Simulate depeg",
    successMessage: (
      <>
        The switch is pushed. Try opening a loan on the <AppLink href="/app/borrow">Borrow page</AppLink>: the quote shows
        the refusal, and the line reverts with PegUnhealthy.
      </>
    ),
  });

  const end = (): TxPlan => ({
    title: "End the simulated depeg",
    summary: "Sets the switch back to $1 at once, so the peg reads Mezo's markets again.",
    steps: [
      {
        label: "End the simulation now",
        detail: "StressedPegSource.stress(1e18, 0)",
        tx: env.client.buildStressPeg({ musdUsdWad: WAD, duration: 0 }),
      },
    ],
    confirmLabel: "End it",
  });

  return (
    <Card
      tone="warning"
      eyebrow={<span className={styles.testnetBadge}>Testnet only</span>}
      title={`Simulate a MUSD depeg for ${span}`}
      description="Anyone can push the testnet's peg switch off $1 for up to two hours, then watch the veBTC line refuse new loans live."
    >
      <div className={styles.sim}>
        <Stack gap={3}>
          <KeyValues
            label="Depeg switch"
            items={[
              {
                label: "Switch now",
                value: active
                  ? `${peg.stress!.musdUsdWad === 0n ? "No reading" : formatPegUsd(peg.stress!.musdUsdWad)} until ${formatDateTime(peg.stress!.endsAt)}`
                  : "Reads $1 (nothing running)",
              },
              left !== null && { label: "Ends in", value: formatDuration(Math.max(0, left)) },
              { label: "Peg now", value: peg.healthyOnChain ? "Healthy" : "Unhealthy: new loans refused" },
            ]}
          />
          {active ? (
            <Button size="sm" variant="secondary" onClick={() => tx.review(end())}>
              End the simulation now
            </Button>
          ) : null}
        </Stack>
        <Stack gap={3}>
          <SelectField label="MUSD reads" value={price} onChange={setPrice} options={[...PRICES]} />
          <SelectField label="For" value={duration} onChange={setDuration} options={[...DURATIONS]} />
          <Notice tone={after.healthy ? "info" : "warning"} title={`With ${choice.toLowerCase()}`}>
            {verdict}
          </Notice>
          <Button onClick={() => tx.review(plan())}>Simulate a MUSD depeg for {span}</Button>
        </Stack>
      </div>
    </Card>
  );
}
