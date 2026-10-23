import type { CSSProperties, ReactNode } from "react";

import { lineColor } from "@/lib/lines";

import styles from "./Bits.module.css";

const cx = (...p: (string | false | undefined | null)[]) => p.filter(Boolean).join(" ");
const cssVars = (v: Record<string, string>) => v as CSSProperties;

/* ---------- Pill ---------- */

export type PillTone = "neutral" | "outline" | "accent" | "positive" | "warning" | "danger" | "danger-soft";

export function Pill({
  tone = "neutral",
  dot,
  children,
  title,
}: {
  tone?: PillTone;
  /** Show a leading dot in the current colour. */
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cx(styles.pill, styles[`pill-${tone}`])} title={title}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** Small label that says where a number comes from: "est.", "derived", "example". */
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className={styles.tag} title={title}>
      {children}
    </span>
  );
}

/* ---------- Stat ---------- */

export function Stat({
  label,
  value,
  unit,
  hint,
  tag,
  size = "md",
  tone,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  tag?: ReactNode;
  size?: "sm" | "md" | "lg";
  tone?: "danger" | "positive";
  title?: string;
}) {
  return (
    <div
      className={cx(
        styles.stat,
        size === "lg" && styles.statLg,
        size === "sm" && styles.statSm,
        tone === "danger" && styles.statDanger,
        tone === "positive" && styles.statPositive,
      )}
    >
      <span className={styles.statLabel}>
        {label}
        {tag ? <Tag>{tag}</Tag> : null}
      </span>
      <span className={styles.statValue} title={title}>
        {value}
        {unit ? <span className={styles.statUnit}>{unit}</span> : null}
      </span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </div>
  );
}

/* ---------- Meter ---------- */

export interface MeterMarker {
  at: number;
  label?: string;
  color?: string;
}

export function Meter({
  value,
  label,
  valueText,
  color,
  markers,
  size = "md",
}: {
  /** 0..1 (clamped). */
  value: number;
  /** Accessible name. */
  label: string;
  valueText?: string;
  /** CSS colour (a token reference), defaults to the accent. */
  color?: string;
  markers?: MeterMarker[];
  size?: "sm" | "md" | "lg";
}) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div
      className={cx(
        styles.meter,
        size === "sm" && styles.meterSm,
        size === "lg" && styles.meterLg,
        markers?.some((m) => m.label) && styles.meterLabelled,
      )}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-valuetext={valueText}
    >
      <span
        className={styles.meterFill}
        style={{ width: `${v * 100}%`, ...(color ? cssVars({ "--fill": color }) : {}) }}
      />
      {markers?.map((m) => (
        <span
          key={`${m.at}-${m.label ?? ""}`}
          className={styles.marker}
          style={{ left: `${Math.min(1, Math.max(0, m.at)) * 100}%`, ...(m.color ? cssVars({ "--marker": m.color }) : {}) }}
          aria-hidden="true"
        >
          {m.label ? (
            <span
              className={styles.markerLabel}
              style={{ transform: `translateX(${m.at > 0.85 ? "calc(-100% + 2px)" : m.at < 0.15 ? "0" : "-50%"})` }}
            >
              {m.label}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/* ---------- Stacked bar ---------- */

export interface Segment {
  key: string;
  value: number;
  color: string;
  label: string;
  hatched?: boolean;
}

export function StackBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  return (
    <div className={styles.stackBar} role="img" aria-label={label}>
      {total > 0
        ? segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <span
                key={s.key}
                className={cx(styles.stackSeg, s.hatched && styles.hatched)}
                style={{ flexGrow: s.value / total, ...cssVars({ "--seg": s.color }) }}
                title={s.label}
              />
            ))
        : null}
    </div>
  );
}

/* ---------- Line identity ---------- */

export function Swatch({ color }: { color: string }) {
  return <span className={styles.swatch} style={cssVars({ "--swatch": color })} aria-hidden="true" />;
}

export function LineName({ id, name }: { id: number; name: string }) {
  return (
    <span className={styles.lineName}>
      <Swatch color={lineColor(id)} />
      <span>{name}</span>
    </span>
  );
}

/* ---------- Skeleton ---------- */

export function Skeleton({ width = "100%", height = 16, label }: { width?: string | number; height?: number; label?: string }) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height }}
      aria-hidden={label ? undefined : true}
      role={label ? "status" : undefined}
      aria-label={label}
    />
  );
}

/* ---------- Notice ---------- */

export type NoticeTone = "info" | "positive" | "warning" | "danger" | "neutral";

function NoticeIcon({ tone }: { tone: NoticeTone }) {
  if (tone === "positive") {
    return (
      <svg className={styles.noticeIcon} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6 10.4 8.6 13 14 7.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tone === "warning" || tone === "danger") {
    return (
      <svg className={styles.noticeIcon} viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.5 18 17H2L10 2.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M10 8v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="14.6" r="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className={styles.noticeIcon} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 9v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="10" cy="6.2" r="1" fill="currentColor" />
    </svg>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={cx(styles.notice, tone !== "neutral" && styles[`notice-${tone}`])} role={role}>
      <NoticeIcon tone={tone} />
      <div className={styles.noticeBody}>
        {title ? <span className={styles.noticeTitle}>{title}</span> : null}
        {children ? <div className={styles.noticeText}>{children}</div> : null}
      </div>
      {action ? <div className={styles.noticeAction}>{action}</div> : null}
    </div>
  );
}

/* ---------- Empty ---------- */

export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {children ? <div className={styles.emptyText}>{children}</div> : null}
      {action}
    </div>
  );
}

/* ---------- Key / value list ---------- */

export interface KV {
  label: ReactNode;
  value: ReactNode;
  rule?: boolean;
}

export function KeyValues({ items, label }: { items: (KV | false | null | undefined)[]; label?: string }) {
  return (
    <dl className={styles.kv} aria-label={label}>
      {items.filter((x): x is KV => !!x).map((it, i) =>
        it.rule ? (
          <div key={`rule-${i}`} className={styles.kvRule} role="presentation" />
        ) : (
          <div key={i} style={{ display: "contents" }}>
            <dt>{it.label}</dt>
            <dd>{it.value}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

/* ---------- Disclosure ---------- */

export function InfoTip({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className={styles.info}>
      <summary>{summary}</summary>
      <div className={styles.infoBody}>{children}</div>
    </details>
  );
}

/* ---------- Headings ---------- */

export function PageHead({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {lead ? <p className={styles.pageLead}>{lead}</p> : null}
      </div>
      {actions}
    </header>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 className={styles.sectionTitle} id={id}>
      {children}
    </h2>
  );
}

export function Muted({ children, small }: { children: ReactNode; small?: boolean }) {
  return <span className={cx(styles.muted, small && styles.small)}>{children}</span>;
}
