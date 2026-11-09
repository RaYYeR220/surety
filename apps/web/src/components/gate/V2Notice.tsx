"use client";

// What a page shows in place of a panel that needs the v2 contracts (the MUSD peg, fees, savings, ShareMarket,
// harvests) while the network it reads still runs the first deployment.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Notice } from "@/components/ui/Bits";
import { ButtonLink } from "@/components/ui/Button";
import { useSurety } from "@/lib/env";

export function V2Notice({ what, children }: { what: string; children?: ReactNode }) {
  const env = useSurety();
  const path = usePathname() ?? "/app";
  return (
    <Notice
      tone="info"
      title={`${what} arrives with the v2 contracts`}
      action={
        env.demo ? undefined : (
          <ButtonLink size="sm" variant="secondary" href={`${path}?demo=1`}>
            Show with example data
          </ButtonLink>
        )
      }
    >
      {children ??
        `${env.chainName} still runs Surety's first deployment, which does not have this yet. It fills in from chain as soon as the v2 deployment is published.`}
    </Notice>
  );
}
