import { formatUnits, parseUnits } from "viem";

const WAD = 10n ** 18n;

function grouped(value: number, min: number, max: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max }).format(value);
}

/** Token amount (18 decimals) as a display string with grouping, e.g. "12,345.67". */
export function formatAmount(value: bigint, options: { decimals?: number; max?: number; min?: number } = {}): string {
  const decimals = options.decimals ?? 18;
  const max = options.max ?? 2;
  const min = options.min ?? Math.min(2, max);
  const n = Number(formatUnits(value, decimals));
  if (value !== 0n && Math.abs(n) < 10 ** -max) return `<${grouped(10 ** -max, max, max)}`;
  return grouped(n, min, max);
}

/**
 * MUSD with up to `max` decimals. A whole-MUSD figure (`max` 0) under 100 MUSD keeps up to two decimals, so a small
 * balance reads 2.5 or 0.25 instead of rounding to 3 or showing <1.
 */
export function formatMusd(value: bigint | null | undefined, max = 2): string {
  if (value === null || value === undefined) return "—";
  const small = max === 0 && value < 100n * WAD && value > -100n * WAD;
  return small ? formatAmount(value, { max: 2, min: 0 }) : formatAmount(value, { max });
}

/** Compact MUSD, e.g. 12.3K, for tight spots; exact value belongs in a title. */
export function formatMusdCompact(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(formatUnits(value, 18));
  if (Math.abs(n) < 10_000) return grouped(n, 0, 2);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatBtc(value: bigint | null | undefined, max = 6): string {
  if (value === null || value === undefined) return "—";
  return formatAmount(value, { max, min: 2 });
}

/** USD price in WAD, e.g. "80,000.00". */
export function formatUsdWad(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return grouped(Number(formatUnits(value, 18)), 2, 2);
}

/** USD price in WAD with a dollar sign, e.g. "$80,000.00"; "—" when unknown. */
export function formatUsd(value: bigint | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return `$${grouped(Number(formatUnits(value, 18)), digits, digits)}`;
}

/** MUSD/USD in WAD to four decimals, e.g. "$0.9914", where a basis point shows. */
export function formatPegUsd(value: bigint | null | undefined): string {
  return formatUsd(value, 4);
}

/** MUSD per share (WAD) to exactly four decimals, so a column of prices lines up: "0.9980". */
export function formatPerShare(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return formatAmount(value, { min: 4, max: 4 });
}

/** A plain number of MUSD (not WAD), e.g. for modelled figures: "5,120", "20.5" or "0.07". */
export function formatMusdNumber(value: number, max = 0): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = max > 0 ? max : abs < 1 ? 2 : abs < 100 ? 1 : 0;
  return grouped(value, 0, digits);
}

/** Fraction 0..1 as a percentage string. */
export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${grouped(value * 100, digits, digits)}%`;
}

export function formatBps(value: bigint | number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return formatPct(Number(value) / 10_000, digits);
}

export function wadToFraction(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number((value * 1_000_000n) / WAD) / 1_000_000;
}

/** Ratio of two bigints as a float (0 when the denominator is 0). */
export function fraction(part: bigint | null | undefined, whole: bigint | null | undefined): number {
  if (part === null || part === undefined || whole === null || whole === undefined || whole === 0n) return 0;
  return Number((part * 1_000_000n) / whole) / 1_000_000;
}

/** Parses a user-typed decimal amount; null when it is not a valid non-negative number. */
export function parseAmount(input: string, decimals = 18): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (s === "" || !/^\d*\.?\d*$/.test(s) || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  try {
    return parseUnits(`${whole || "0"}.${frac || "0"}`, decimals);
  } catch {
    return null;
  }
}

/** bigint amount to an input string without grouping (for Max buttons). */
export function toInput(value: bigint, decimals = 18, max = 6): string {
  const s = formatUnits(value, decimals);
  const [w, f = ""] = s.split(".");
  const trimmed = f.slice(0, max).replace(/0+$/, "");
  return trimmed ? `${w}.${trimmed}` : (w ?? "0");
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Seconds as a countdown, e.g. "2d 04:12:09" or "04:12:09". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return d > 0 ? `${d}d ${clock}` : clock;
}

/** Seconds as a human duration, e.g. "3 days", "5 h 20 min", "45 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  // Round to the unit shown first, so 13 h 59.6 min reads "14 h", never "13 h 60 min".
  const hours = Math.round(s / 3600);
  if (hours >= 48) return `${Math.round(s / 86_400)} days`;
  if (hours >= 24) return hours === 24 ? "1 day" : `1 day ${hours - 24} h`;
  const minutes = Math.round(s / 60);
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (s >= 60) return `${minutes} min`;
  return `${s} s`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** Unix seconds as "12 Nov 2026". */
export function formatDate(unix: bigint | number): string {
  return dateFmt.format(new Date(Number(unix) * 1000));
}

/** Unix seconds as "12 Nov, 16:00 UTC". */
export function formatDateTime(unix: bigint | number): string {
  return `${dateTimeFmt.format(new Date(Number(unix) * 1000))} UTC`;
}
