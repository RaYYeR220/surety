"use client";

// A veBTC loan's loan-to-value against the line's three lines: the most it may borrow, the auction trigger and the
// auction floor. Between the trigger and the floor is the cushion: an auction that starts at the trigger and sells
// as low as the floor still repays the debt in full.
import type { CSSProperties } from "react";

import { formatBps } from "@/lib/format";

import styles from "./HealthBar.module.css";

export interface HealthLines {
  maxLtvBps: number;
  /** LTV at which anyone can start the auction. */
  liqLtvBps: number;
  /** Lowest auction price, as a share of the collateral value. */
  floorBps: number;
}

export function ltvZone(ltvBps: number, l: HealthLines): "safe" | "over-max" | "auction" | "shortfall" {
  if (ltvBps >= l.floorBps) return "shortfall";
  if (ltvBps >= l.liqLtvBps) return "auction";
  if (ltvBps > l.maxLtvBps) return "over-max";
  return "safe";
}

const ZONE_TEXT = {
  safe: "under the max loan-to-value",
  "over-max": "over the max loan-to-value: no more borrowing, not auctionable yet",
  auction: "past the auction trigger: anyone can auction the veBTC, and a sale at the floor still repays the debt",
  shortfall: "past the floor: an auction may sell below the debt, and the voters' cover pays the gap",
} as const;

export function HealthBar({
  ltvBps,
  lines,
  label = "Loan-to-value",
  compact,
}: {
  /** null while the price is unknown. */
  ltvBps: number | null;
  lines: HealthLines;
  label?: string;
  compact?: boolean;
}) {
  const at = (bps: number) => `${Math.min(100, Math.max(0, bps / 100))}%`;
  const zone = ltvBps === null ? null : ltvZone(ltvBps, lines);
  const cushion = lines.floorBps - lines.liqLtvBps;
  const valueText =
    ltvBps === null
      ? "Unknown while the price feed is stale"
      : `${formatBps(ltvBps)}, ${ZONE_TEXT[zone!]}. Max ${formatBps(lines.maxLtvBps, 0)}, auction at ${formatBps(lines.liqLtvBps, 0)}, floor ${formatBps(lines.floorBps, 0)}.`;
  return (
    <div className={styles.wrap} data-compact={compact || undefined}>
      <div className={styles.head}>
        <span>{label}</span>
        <span className={styles.value} data-zone={zone ?? undefined}>
          {ltvBps === null ? "—" : formatBps(ltvBps)}
        </span>
      </div>
      <div
        className={styles.bar}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ltvBps === null ? undefined : Math.min(100, Math.round(ltvBps / 100))}
        aria-valuetext={valueText}
        style={
          {
            "--max": at(lines.maxLtvBps),
            "--trigger": at(lines.liqLtvBps),
            "--floor": at(lines.floorBps),
          } as CSSProperties
        }
      >
        <span className={styles.safe} aria-hidden="true" />
        <span className={styles.over} aria-hidden="true" />
        <span className={styles.cushion} aria-hidden="true" />
        <span className={styles.short} aria-hidden="true" />
        {ltvBps !== null ? (
          <span className={styles.needle} style={{ left: at(ltvBps) }} data-zone={zone} aria-hidden="true" />
        ) : null}
      </div>
      <div className={styles.marks} aria-hidden="true">
        <span style={{ left: at(lines.maxLtvBps) }}>max {formatBps(lines.maxLtvBps, 0)}</span>
        <span style={{ left: at(lines.liqLtvBps) }} data-strong>
          auction {formatBps(lines.liqLtvBps, 0)}
        </span>
        <span style={{ left: at(lines.floorBps) }} data-strong>
          floor {formatBps(lines.floorBps, 0)}
        </span>
      </div>
      {compact ? null : (
        <p className={styles.note}>
          {zone ? <>Now {ZONE_TEXT[zone]}. </> : null}
          The {formatBps(cushion, 0)} between the auction trigger and the floor is the cushion: an auction started at the
          trigger repays the debt even if it sells at the floor.
        </p>
      )}
    </div>
  );
}
