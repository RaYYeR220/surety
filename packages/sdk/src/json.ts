/** Deep copy with every bigint turned into its decimal string, so the value survives JSON.stringify. */
export type JsonSafe<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? JsonSafe<U>[]
    : T extends readonly (infer U)[]
      ? readonly JsonSafe<U>[]
      : T extends object
        ? { [K in keyof T]: JsonSafe<T[K]> }
        : T;

export function toJsonSafe<T>(value: T): JsonSafe<T> {
  if (typeof value === "bigint") return value.toString() as JsonSafe<T>;
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v)) as JsonSafe<T>;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toJsonSafe(v);
    return out as JsonSafe<T>;
  }
  return value as JsonSafe<T>;
}

/** JSON.stringify that writes bigints as decimal strings. */
export function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), space);
}
