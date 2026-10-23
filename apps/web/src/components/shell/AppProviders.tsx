"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { TxProvider } from "@/components/tx/TxProvider";
import type { DemoScenario } from "@/lib/demo";
import { SuretyProvider } from "@/lib/env";
import { wagmiConfig } from "@/lib/wagmi";

import { WalletDialogProvider } from "./WalletDialog";

function demoFrom(param: string | null): DemoScenario | null {
  if (param === null || param === "0" || param === "false") return null;
  return param === "stale" || param === "paused" ? param : "default";
}

export function AppProviders({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const demo = demoFrom(params.get("demo"));
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SuretyProvider demo={demo}>
          <WalletDialogProvider>
            <TxProvider>{children}</TxProvider>
          </WalletDialogProvider>
        </SuretyProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
