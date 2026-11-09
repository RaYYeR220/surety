import type { Metadata } from "next";

import { TryPage } from "./TryView";

export const metadata: Metadata = {
  title: "Try it on testnet",
  description: "Borrow against veBTC on Mezo Testnet in about a minute, with a key kept in your browser and a starter kit.",
};

export default function Page() {
  return <TryPage />;
}
