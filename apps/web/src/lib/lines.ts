import type { LineKind } from "@surety/sdk";

/** The categorical colour token of a credit line (line id 0 uses --line-1). */
export function lineColor(id: number): string {
  return `var(--line-${(id % 5) + 1})`;
}

/** Whether a colour is a credit-line token (those fills get an ink outline). */
export function isLineColor(color: string | undefined): boolean {
  return !!color && color.startsWith("var(--line-");
}

export function kindLabel(kind: LineKind): string {
  return kind === "Morpho" ? "Morpho market" : "veBTC credit line";
}

/** "1-hour epochs" on the compressed testnet deployment, "weekly epochs" on mainnet. */
export function epochCadence(epochLength: bigint): string {
  const s = Number(epochLength);
  if (s === 604_800) return "weekly epochs";
  if (s % 86_400 === 0) return `${s / 86_400}-day epochs`;
  if (s % 3600 === 0) return `${s / 3600}-hour epochs`;
  return `${Math.round(s / 60)}-minute epochs`;
}

/** Epoch number counted from the unix epoch, for compact labels ("Epoch 497,992"). */
export function epochIndex(epochStart: bigint, epochLength: bigint): bigint {
  return epochLength === 0n ? 0n : epochStart / epochLength;
}
