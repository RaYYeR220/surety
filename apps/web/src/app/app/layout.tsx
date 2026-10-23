import { Suspense, type ReactNode } from "react";

import { AppProviders } from "@/components/shell/AppProviders";
import { AppShell } from "@/components/shell/AppShell";
import { PageSkeleton } from "@/components/shell/EnvGate";
import { ShellFallback } from "@/components/shell/ShellFallback";

export default function AppLayout({ children }: { children: ReactNode }) {
  // The app reads ?demo from the URL, which a static export resolves in the browser.
  return (
    <Suspense
      fallback={
        <ShellFallback>
          <PageSkeleton />
        </ShellFallback>
      }
    >
      <AppProviders>
        <AppShell>{children}</AppShell>
      </AppProviders>
    </Suspense>
  );
}
