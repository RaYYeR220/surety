import type { Metadata } from "next";

import { VotePage } from "@/components/vote/VoteView";

export const metadata: Metadata = { title: "Vote" };

export default function Page() {
  return <VotePage />;
}
