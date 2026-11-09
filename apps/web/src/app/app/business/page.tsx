import type { Metadata } from "next";

import { BusinessPage } from "@/components/business/BusinessView";

export const metadata: Metadata = { title: "Business" };

export default function Page() {
  return <BusinessPage />;
}
