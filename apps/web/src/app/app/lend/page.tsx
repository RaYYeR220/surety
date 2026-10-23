import type { Metadata } from "next";

import { LendPage } from "@/components/lend/LendView";

export const metadata: Metadata = { title: "Lend" };

export default function Page() {
  return <LendPage />;
}
