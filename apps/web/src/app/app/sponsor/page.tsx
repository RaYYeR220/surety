import type { Metadata } from "next";

import { SponsorPage } from "@/components/sponsor/SponsorView";

export const metadata: Metadata = { title: "Sponsor" };

export default function Page() {
  return <SponsorPage />;
}
