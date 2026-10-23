import type { Metadata } from "next";

import { BorrowPage } from "@/components/borrow/BorrowView";

export const metadata: Metadata = { title: "Borrow" };

export default function Page() {
  return <BorrowPage />;
}
