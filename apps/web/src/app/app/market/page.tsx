import type { Metadata } from "next";

import { MarketPage } from "@/components/market/MarketView";

export const metadata: Metadata = { title: "Share market" };

export default function Page() {
  return <MarketPage />;
}
