"use client";

import { MEZO_TESTNET_ID } from "@surety/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, type Connector, type CreateConnectorFn } from "wagmi";

import { Notice } from "@/components/ui/Bits";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Dialog, ExplorerLink } from "@/components/ui/Controls";
import { BURNER_ID, useBurnerKey } from "@/lib/burner";
import { CHAIN_NAMES, useSurety } from "@/lib/env";
import { explainError } from "@/lib/errors";
import { shortAddress } from "@/lib/format";
import type { PassportWallet } from "@/lib/passport";

import { AppLink } from "./AppLink";
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

type PassportState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "ready"; chainId: number; wallets: PassportWallet[] }
  | { s: "failed" };

/** Whether a Bitcoin wallet Passport supports (Unisat, OKX, Xverse) has injected itself into the page. */
function hasBitcoinWallet(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { unisat?: unknown; okxwallet?: { bitcoin?: unknown }; XverseProviders?: unknown };
  return !!(w.unisat || w.okxwallet?.bitcoin || w.XverseProviders);
}

/**
 * Mezo Passport's Bitcoin wallets: a separate chunk that never ships with the first page. It loads as the dialog
 * opens when a Bitcoin wallet is installed, otherwise only when asked for (it weighs about 430 KB compressed).
 */
function usePassport(chainId: number): [PassportState, () => void] {
  const [wanted, setWanted] = useState(hasBitcoinWallet);
  const [loaded, setLoaded] = useState<{ chainId: number; wallets: PassportWallet[] } | "failed" | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    import("@/lib/passport")
      .then(({ passportWallets }) => {
        if (alive) setLoaded({ chainId, wallets: passportWallets(chainId) });
      })
      .catch(() => {
        if (alive) setLoaded("failed");
      });
    return () => {
      alive = false;
    };
  }, [chainId, wanted]);
  let state: PassportState = { s: "idle" };
  if (loaded === "failed") state = { s: "failed" };
  else if (loaded && loaded.chainId === chainId) state = { s: "ready", ...loaded };
  else if (wanted) state = { s: "loading" };
  return [state, () => setWanted(true)];
}

function WalletPanel({ onDone }: { onDone: () => void }) {
  const env = useSurety();
  const { address, isConnected, chainId, connector } = useAccount();
  const connectors = useConnectors();
  const { connectAsync, isPending, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const burnerKey = useBurnerKey();
  const [passport, loadPassport] = usePassport(env.chainId);
  const [error, setError] = useState<string | null>(null);

  const onTestnet = env.chainId === MEZO_TESTNET_ID;
  const pending = (c: Connector | CreateConnectorFn) => isPending && variables?.connector === c;

  const connect = async (c: Connector | CreateConnectorFn) => {
    setError(null);
    try {
      await connectAsync({ connector: c, chainId: env.chainId as 31611 | 31612 });
      onDone();
    } catch (e) {
      setError(explainError(e).title);
    }
  };

  if (isConnected && address) {
    const burner = connector?.id === BURNER_ID;
    return (
      <div className={styles.walletPanel}>
        <p className={styles.walletLine}>
          Connected with {burner ? "the testnet key in this browser" : (connector?.name ?? "your wallet")} on{" "}
          {chainId !== undefined ? (CHAIN_NAMES[chainId] ?? `chain ${chainId}`) : "an unknown network"}.
        </p>
        <p className={styles.walletAddress}>
          <ExplorerLink kind="address" value={address} full />
        </p>
        {burner ? (
          <Notice tone="warning">
            This key lives in this browser only and holds test funds. Export or reset it on the{" "}
            <AppLink href="/app/try">Try it</AppLink> page.
          </Notice>
        ) : null}
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

  // EIP-6963 wallets announce themselves; the generic injected entry is only a fallback.
  const evm = connectors.filter((c) => c.id !== BURNER_ID);
  const announced = evm.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = announced.length ? [...announced, ...evm.filter((c) => c.type !== "injected")] : evm;
  const hasInjected = typeof window !== "undefined" && "ethereum" in window;
  const burner = connectors.find((c) => c.id === BURNER_ID);

  return (
    <div className={styles.walletPanel}>
      <p className={styles.walletLine}>
        Surety never holds keys. Your wallet signs each transaction after you review it here.
      </p>

      <section className={styles.walletGroup} aria-labelledby="wallet-evm">
        <h3 id="wallet-evm" className={styles.walletGroupTitle}>
          EVM wallets
        </h3>
        <ul className={styles.connectorList}>
          {list.map((c) => {
            const label =
              c.id === "injected" ? (hasInjected ? "Browser wallet" : "Browser wallet (none found)") : c.name;
            return (
              <li key={c.uid}>
                <Button
                  variant="secondary"
                  block
                  loading={pending(c)}
                  disabled={c.id === "injected" && !hasInjected}
                  onClick={() => void connect(c)}
                >
                  {c.icon ? (
                    // Wallet icons are data URIs announced by the wallet itself (EIP-6963); next/image adds nothing here.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" width={20} height={20} />
                  ) : null}
                  {label}
                </Button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={styles.walletGroup} aria-labelledby="wallet-btc" aria-busy={passport.s === "loading"}>
        <h3 id="wallet-btc" className={styles.walletGroupTitle}>
          Bitcoin wallets <span className={styles.walletGroupNote}>through Mezo Passport</span>
        </h3>
        {passport.s === "idle" ? (
          <Button variant="secondary" block onClick={loadPassport}>
            Show Bitcoin wallets
          </Button>
        ) : passport.s === "loading" ? (
          <p className={styles.walletHint}>Loading Mezo Passport…</p>
        ) : passport.s === "failed" ? (
          <p className={styles.walletHint}>Mezo Passport could not load. Check your connection and reopen this dialog.</p>
        ) : (
          <>
            <ul className={styles.connectorList}>
              {passport.wallets.map((w) => (
                <li key={w.id}>
                  {w.installed ? (
                    <Button variant="secondary" block loading={pending(w.connector)} onClick={() => void connect(w.connector)}>
                      {w.name}
                    </Button>
                  ) : w.downloadUrl ? (
                    <ButtonLink variant="quiet" block href={w.downloadUrl} external>
                      Install {w.name}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </ButtonLink>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className={styles.walletHint}>
              Your Bitcoin wallet signs; a Mezo smart account it controls acts on chain, so you need no EVM wallet.
            </p>
          </>
        )}
      </section>

      <section className={styles.walletGroup} aria-labelledby="wallet-try">
        <h3 id="wallet-try" className={styles.walletGroupTitle}>
          No wallet?
        </h3>
        {onTestnet && burner && burnerKey ? (
          <Button variant="secondary" block loading={pending(burner)} onClick={() => void connect(burner)}>
            Use the testnet key in this browser ({shortAddress(burnerKey.address)})
          </Button>
        ) : (
          <ButtonLink variant="secondary" block href="/app/try">
            Try it on testnet with a key kept in this browser
          </ButtonLink>
        )}
      </section>

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
