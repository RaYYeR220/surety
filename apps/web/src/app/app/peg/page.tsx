import type { Metadata } from "next";

import { PegPage } from "@/components/peg/PegView";

export const metadata: Metadata = { title: "MUSD peg" };

export default function Page() {
  return <PegPage />;
}
