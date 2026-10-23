import type { Metadata } from "next";

import { AuctionsPage } from "@/components/auctions/AuctionsView";

export const metadata: Metadata = { title: "Auctions" };

export default function Page() {
  return <AuctionsPage />;
}
