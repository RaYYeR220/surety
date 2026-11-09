import type { ReactNode } from "react";

import { AppProviders } from "@/components/shell/AppProviders";
import { AppShell } from "@/components/shell/AppShell";
import { appRoutes } from "@/lib/routes.server";
import { loadChainSnapshots } from "@/lib/snapshot.server";

export default function AppLayout({ children }: { children: ReactNode }) {
  // The build snapshot seeds the app, so the static HTML of every page already carries real figures.
  return (
    <AppProviders snapshots={loadChainSnapshots()}>
      <AppShell routes={appRoutes()}>{children}</AppShell>
    </AppProviders>
  );
}
