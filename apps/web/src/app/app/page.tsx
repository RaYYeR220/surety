import type { Metadata } from "next";

import { BoardPage } from "@/components/board/BoardView";

export const metadata: Metadata = { title: "Credit board" };

export default function Page() {
  return <BoardPage />;
}
