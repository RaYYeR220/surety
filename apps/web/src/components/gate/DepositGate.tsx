"use client";

// The vault's DepositGate, made visible. While SuretyPool.depositsPaused() is true the gate holds every new srMUSD
// receiver other than the pool: deposits, srMUSD transfers, voters' claims and sponsors' refunds wait (they would
// revert), withdrawals never do. The app blocks those buttons with this explanation instead of sending a doomed tx.
import type { Board } from "@surety/sdk";

import { Notice } from "@/components/ui/Bits";
import { formatMusd } from "@/lib/format";
import { useLossChecks } from "@/lib/queries";

export type GateContext = "deposit" | "claim" | "refund";

/** Whether the gate is holding new shares now (false when open or unknown). */
export function isPaused(board: Board | undefined): boolean {
  return board?.vault.depositsPaused === true;
}

/** Shown on a blocked button or in a review that cannot be sent. */
export const GATE_BLOCKED: Record<GateContext, string> = {
  deposit: "Deposits are paused while voters' cover is being re-recognised. Withdrawals stay open.",
  claim: "Claims wait while deposits are paused. Your matured rewards stay yours: claim them once deposits reopen.",
  refund: "Refunds wait while deposits are paused. Your refund stays yours: claim it back once deposits reopen.",
};

/** What is holding the gate shut right now, in one sentence (null while open or unknown). */
export function useGateReason(board: Board | undefined): string | null {
  const paused = isPaused(board);
  const checks = useLossChecks(paused ? board?.lines.map((l) => l.id) : undefined);
  if (!paused || !board) return null;
  const name = (id: number) => board.lines.find((l) => l.id === id)?.name ?? `line ${id}`;
  const pending = checks.data?.find((c) => (c.pendingLoss ?? 0n) > 0n);
  if (pending) {
    return `${formatMusd(pending.pendingLoss)} MUSD of bad debt on ${name(pending.lineId)} is not recorded yet. Anyone can record it from the board, and cover then pays it.`;
  }
  const uncovered = board.lines.find((l) => (l.uncoveredLoss ?? 0n) > 0n && (l.coverCapacity ?? 0n) > 0n);
  if (uncovered) {
    return `${formatMusd(uncovered.uncoveredLoss)} MUSD of recorded loss on ${uncovered.name} is waiting for cover.`;
  }
  if (checks.isPending) return null;
  return "MUSD a cover paid back is still being re-recognised in the srMUSD price, which the vault does at a capped rate.";
}

const COPY: Record<GateContext, { title: string; body: string }> = {
  deposit: {
    title: "Deposits are paused while voters' cover is being re-recognised",
    body: "This stops newcomers from skimming the cover meant for the lenders who took the loss. Withdrawals stay open.",
  },
  claim: {
    title: "Claims wait while deposits are paused",
    body: "Rewards are paid in srMUSD, and new srMUSD waits while voters' cover is being re-recognised, so newcomers cannot skim the cover. Nothing is lost: matured rewards stay claimable and pay out once deposits reopen.",
  },
  refund: {
    title: "Refunds wait while deposits are paused",
    body: "Refunds are paid in srMUSD, and new srMUSD waits while voters' cover is being re-recognised, so newcomers cannot skim the cover. Your refund stays yours. Posting a new incentive still works.",
  },
};

/** The paused state, explained: why it exists, what still works, and what is holding it now. */
export function GateNotice({ board, context }: { board: Board; context: GateContext }) {
  const reason = useGateReason(board);
  if (!isPaused(board)) return null;
  const { title, body } = COPY[context];
  return (
    <Notice tone="warning" title={title} role="status">
      {body}
      {reason ? (
        <>
          {" "}
          <strong>Now:</strong> {reason} Deposits reopen on their own once the loss is covered and back in the share price.
        </>
      ) : null}
    </Notice>
  );
}
