"use client";

import { MEZO_TESTNET_ID } from "@surety/sdk";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Cluster, Grid, Stack } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Notice, Skeleton } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { CHAIN_NAMES, useSurety, type ReadyEnv } from "@/lib/env";
import { explainError } from "@/lib/errors";

import styles from "./Shell.module.css";

export function PageSkeleton() {
  return (
    <Stack gap={5}>
      <Skeleton width="38%" height={44} label="Loading" />
      <Skeleton width="62%" height={18} />
      <Grid min="260px" gap={4}>
        <Skeleton height={140} />
        <Skeleton height={140} />
        <Skeleton height={140} />
      </Grid>
      <Skeleton height={220} />
    </Stack>
  );
}

/** Renders the page once the network has a deployment (or example mode is on); explains why not otherwise. */
export function EnvGate({ children }: { children: (env: ReadyEnv) => ReactNode }) {
  const env = useSurety();
  const path = usePathname() ?? "/app";
  const router = useRouter();
  if (env.status === "loading") return <PageSkeleton />;
  if (env.status === "error") {
    return (
      <div className={styles.gate}>
        <Notice tone="danger" title="The app could not start" role="alert">
          {explainError(env.error).title} Reload the page; if it keeps happening, switch network or use example data.
        </Notice>
      </div>
    );
  }
  if (env.status === "undeployed") {
    const onTestnet = env.chainId === MEZO_TESTNET_ID;
    return (
      <div className={styles.gate}>
        <Card
          tone="strong"
          eyebrow={env.chainName}
          title={`Surety is not deployed on ${env.chainName} yet`}
          description={
            onTestnet
              ? "The contracts go live here first, with one-hour epochs so a full cycle fits in an afternoon. This page fills in from chain as soon as the deployment is published."
              : "Mainnet follows the testnet rehearsal, with weekly epochs aligned to Mezo and small caps. This page fills in from chain as soon as the deployment is published."
          }
        >
          <Stack gap={4}>
            <p>Until then you can click through every page with example data from the SDK's test fixture. Nothing is sent in that mode.</p>
            <Cluster gap={3}>
              <Button onClick={() => router.push(`${path}?demo=1`)}>Show example data</Button>
              {!onTestnet ? (
                <Button variant="secondary" onClick={() => env.selectChain(MEZO_TESTNET_ID)}>
                  Switch to {CHAIN_NAMES[MEZO_TESTNET_ID]}
                </Button>
              ) : null}
            </Cluster>
          </Stack>
        </Card>
      </div>
    );
  }
  return <>{children(env)}</>;
}

/** Inline error for one failed read, with a retry. */
export function ReadError({ what, error, onRetry }: { what: string; error: unknown; onRetry?: () => void }) {
  const ex = explainError(error);
  return (
    <Notice
      tone="danger"
      title={`Could not read ${what} from chain`}
      role="alert"
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {ex.title}
      {ex.detail ? ` (${ex.detail})` : ""}
    </Notice>
  );
}
