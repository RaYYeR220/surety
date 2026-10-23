import type { Metadata } from "next";

import { ProofPage } from "@/components/proof/ProofView";

export const metadata: Metadata = { title: "Proof" };

export default function Page() {
  return <ProofPage />;
}
