import type { Metadata } from "next";

import { loadLedgerSnapshots } from "@/lib/snapshot.server";

import { LedgerView } from "./LedgerView";

export const metadata: Metadata = {
  title: "Who uses Surety",
  description: "Every wallet that has used Surety on Mezo mainnet and testnet, with team wallets labelled.",
};

export default function Page() {
  return <LedgerView initial={loadLedgerSnapshots()} />;
}
