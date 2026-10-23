"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";

import { Notice } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Dialog, ExplorerLink } from "@/components/ui/Controls";
import { CHAIN_NAMES, useSurety } from "@/lib/env";
import { explainError } from "@/lib/errors";

import styles from "./Shell.module.css";

const WalletContext = createContext<{ open: () => void } | null>(null);

export function useWalletDialog() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletDialog outside WalletDialogProvider");
  return ctx;
}

export function WalletDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <WalletContext.Provider value={value}>
      {children}
      <Dialog open={isOpen} onClose={() => setOpen(false)} title="Wallet">
        {isOpen ? <WalletPanel onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </WalletContext.Provider>
  );
}

function WalletPanel({ onDone }: { onDone: () => void }) {
  const env = useSurety();
  const { address, isConnected, chainId, connector } = useAccount();
  const connectors = useConnectors();
  const { connectAsync, isPending, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const [error, setError] = useState<string | null>(null);

  // EIP-6963 wallets announce themselves; the generic injected entry is only a fallback.
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = announced.length ? [...announced, ...connectors.filter((c) => c.type !== "injected")] : connectors;
  const hasInjected = typeof window !== "undefined" && "ethereum" in window;

  if (isConnected && address) {
    return (
      <div className={styles.walletPanel}>
        <p className={styles.walletLine}>
          Connected with {connector?.name ?? "your wallet"} on{" "}
          {chainId !== undefined ? (CHAIN_NAMES[chainId] ?? `chain ${chainId}`) : "an unknown network"}.
        </p>
        <p className={styles.walletAddress}>
          <ExplorerLink kind="address" value={address} full />
        </p>
        {env.demo ? (
          <Notice tone="info">
            Example mode is on, so pages show the fixture wallet instead of yours. Leave example mode to use your
            own.
          </Notice>
        ) : null}
        <div className={styles.walletActions}>
          <Button
            variant="secondary"
            onClick={() => {
              disconnect();
              onDone();
            }}
          >
            Disconnect
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.walletPanel}>
      <p className={styles.walletLine}>
        Surety never holds keys. Your wallet signs each transaction after you review it here.
      </p>
      <ul className={styles.connectorList}>
        {list.map((c) => {
          const label = c.id === "injected" ? (hasInjected ? "Browser wallet" : "Browser wallet (none found)") : c.name;
          return (
            <li key={c.uid}>
              <Button
                variant="secondary"
                block
                loading={isPending && variables?.connector === c}
                disabled={c.id === "injected" && !hasInjected}
                onClick={async () => {
                  setError(null);
                  try {
                    await connectAsync({ connector: c, chainId: env.chainId as 31611 | 31612 });
                    onDone();
                  } catch (e) {
                    setError(explainError(e).title);
                  }
                }}
              >
                {c.icon ? <img src={c.icon} alt="" width={20} height={20} /> : null}
                {label}
              </Button>
            </li>
          );
        })}
      </ul>
      {!hasInjected ? (
        <Notice tone="info">
          No browser wallet found. Install an EVM wallet such as MetaMask or Rabby, then reload. Surety adds the Mezo
          network to it when you connect.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
