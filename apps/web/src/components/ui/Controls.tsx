"use client";

import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { useSurety } from "@/lib/env";
import { shortAddress, shortHash } from "@/lib/format";
import { isLineColor } from "@/lib/lines";

import styles from "./Controls.module.css";

const cx = (...p: (string | false | undefined | null)[]) => p.filter(Boolean).join(" ");

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Tab ids are `${idPrefix}-tab-${id}`; panels should use aria-labelledby with that id. */
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + tabs.length) % tabs.length;
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${idPrefix}-tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className={styles.tab}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`}>
      {children}
    </div>
  );
}

/* ---------- Fields ---------- */

export function AmountField({
  label,
  value,
  onChange,
  unit,
  aside,
  help,
  error,
  onMax,
  maxLabel = "Max",
  disabled,
  placeholder = "0.00",
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  /** Right side of the label row, e.g. "Wallet: 2,500 MUSD". */
  aside?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  onMax?: () => void;
  maxLabel?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className={cx(styles.field, !!error && styles.invalid)}>
      <label className={styles.label} htmlFor={id}>
        <span>{label}</span>
        {aside ? <span className={styles.labelAside}>{aside}</span> : null}
      </label>
      <div className={styles.control}>
        <input
          id={id}
          className={styles.input}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={help || error ? helpId : undefined}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
        />
        <span className={styles.unit}>{unit}</span>
        {onMax ? (
          <button type="button" className={styles.max} onClick={onMax} disabled={disabled}>
            {maxLabel}
          </button>
        ) : null}
      </div>
      {error ? (
        <span id={helpId} className={styles.error} role="alert">
          {error}
        </span>
      ) : help ? (
        <span id={helpId} className={styles.help}>
          {help}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  help,
  error,
  placeholder,
  mono,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  help?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className={cx(styles.field, !!error && styles.invalid)}>
      <label className={styles.label} htmlFor={id}>
        <span>{label}</span>
      </label>
      <div className={styles.control}>
        <input
          id={id}
          className={cx(styles.input, !mono && styles.inputText)}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {error ? <span className={styles.error}>{error}</span> : help ? <span className={styles.help}>{help}</span> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: ReactNode;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  help?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        <span>{label}</span>
      </label>
      <select id={id} className={styles.select} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {help ? <span className={styles.help}>{help}</span> : null}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  valueText,
  color,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  valueText?: string;
  /** Track fill colour (token reference). */
  color?: string;
  disabled?: boolean;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className={styles.slider}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={valueText}
      data-line={isLineColor(color) || undefined}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ "--pct": `${pct}%`, ...(color ? { "--thumb": color } : {}) } as CSSProperties}
    />
  );
}

/* ---------- Radio cards ---------- */

export function ChoiceList<T extends string>({
  name,
  value,
  onChange,
  options,
  label,
}: {
  name: string;
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; content: ReactNode; disabled?: boolean }[];
  label: string;
}) {
  return (
    <div className={styles.choices} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={styles.choice}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
          />
          <div className={styles.choiceBody}>{o.content}</div>
        </label>
      ))}
    </div>
  );
}

/* ---------- Check list (multi-select cards) ---------- */

export function CheckList<T extends string>({
  values,
  onChange,
  options,
  label,
}: {
  values: T[];
  onChange: (next: T[]) => void;
  options: { value: T; content: ReactNode; disabled?: boolean }[];
  label: string;
}) {
  return (
    <div className={styles.choices} role="group" aria-label={label}>
      {options.map((o) => {
        const checked = values.includes(o.value);
        return (
          <label key={o.value} className={styles.choice}>
            <input
              type="checkbox"
              value={o.value}
              checked={checked}
              disabled={o.disabled}
              onChange={() => onChange(checked ? values.filter((v) => v !== o.value) : [...values, o.value])}
            />
            <span className={styles.checkBox} aria-hidden="true" />
            <div className={styles.choiceBody}>{o.content}</div>
          </label>
        );
      })}
    </div>
  );
}

/* ---------- Dialog ---------- */

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className={styles.dialogInner}>
          <div className={styles.dialogHead}>
            <h2 id={titleId} className={styles.dialogTitle}>
              {title}
            </h2>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {children}
          {footer ? <div className={styles.dialogFoot}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/* ---------- Table ---------- */

export interface Column<R> {
  key: string;
  header: string;
  cell: (row: R) => ReactNode;
  align?: "start" | "end";
}

export function DataTable<R>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  caption?: string;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === "end" ? styles.end : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.header} className={c.align === "end" ? styles.end : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Explorer link ---------- */

export function ExplorerLink({
  kind,
  value,
  label,
  full,
}: {
  kind: "tx" | "address" | "block";
  value: string;
  label?: ReactNode;
  /** Show the whole value instead of a shortened one. */
  full?: boolean;
}) {
  const env = useSurety();
  const href = env.status === "ready" ? env.explorer(kind, value) : null;
  const short = kind === "tx" ? shortHash(value) : shortAddress(value);
  // Full values shorten on phones so long addresses never wrap into a block of hex.
  const text =
    label ??
    (full ? (
      <>
        <span className={styles.addrFull}>{value}</span>
        <span className={styles.addrShort}>{short}</span>
      </>
    ) : (
      short
    ));
  if (!href) {
    return (
      <span className={styles.mono} title={value}>
        {text}
      </span>
    );
  }
  return (
    <a className={cx(styles.extLink, styles.mono)} href={href} target="_blank" rel="noreferrer" title={value}>
      {text}
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M3 1h6v6M9 1 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className="sr-only">(opens the Mezo explorer)</span>
    </a>
  );
}
