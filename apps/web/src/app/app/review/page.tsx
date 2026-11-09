import type { Metadata } from "next";

import { ReviewPage } from "@/components/review/ReviewView";

export const metadata: Metadata = { title: "Review in 5 minutes" };

export default function Page() {
  return <ReviewPage />;
}
