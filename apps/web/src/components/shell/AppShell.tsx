"use client";

import { MEZO_MAINNET_ID, MEZO_TESTNET_ID, isMezoChainId } from "@surety/sdk";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";

import { Container } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { CHAIN_NAMES, useSurety } from "@/lib/env";
import { shortAddress } from "@/lib/format";

import { AppLink } from "./AppLink";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { useWalletDialog } from "./WalletDialog";

export const NAV = [
  { href: "/app", label: "Board" },
  { href: "/app/vote", label: "Vote" },
  { href: "/app/lend", label: "Lend" },
  { href: "/app/borrow", label: "Borrow" },
  { href: "/app/sponsor", label: "Sponsor" },
  { href: "/app/auctions", label: "Auctions" },
  { href: "/app/proof", label: "Proof" },
] as const;

function normalise(path: string | null): string {
  if (!path) return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = normalise(usePathname());
  return (
    <>
      {NAV.map((item) => (
        <AppLink
          key={item.href}
          href={item.href}
          className={styles.navLink}
          aria-current={path === item.href ? "page" : undefined}
          onClick={onNavigate}
        >
          {item.label}
        </AppLink>
      ))}
    </>
  );
}

function NetworkPicker() {
  const env = useSurety();
  const { isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  if (env.demo) {
    return (
      <span className={styles.network}>
        <span className={styles.networkDot} data-tone="warning" aria-hidden="true" />
        <select className={styles.networkSelect} disabled aria-label="Network" value="demo">
          <option value="demo">Example data</option>
        </select>
      </span>
    );
  }
  return (
    <span className={styles.network}>
      <span className={styles.networkDot} aria-hidden="true" data-tone={env.chainId === MEZO_TESTNET_ID ? "warning" : undefined} />
      <select
        className={styles.networkSelect}
        aria-label="Network"
        value={env.chainId}
        onChange={(e) => {
          const id = Number(e.target.value);
          env.selectChain(id);
          if (isConnected) switchChain({ chainId: id as 31611 | 31612 });
        }}
      >
        <option value={MEZO_TESTNET_ID}>{CHAIN_NAMES[MEZO_TESTNET_ID]}</option>
        <option value={MEZO_MAINNET_ID}>{CHAIN_NAMES[MEZO_MAINNET_ID]}</option>
      </select>
    </span>
  );
}

function WalletButton() {
  const env = useSurety();
  const { address, isConnected } = useAccount();
  const wallet = useWalletDialog();
  if (env.demo && env.status === "ready" && env.account) {
    return (
      <span className={styles.walletButton} title="The fixture's example wallet (read-only)">
        <span className={styles.walletDot} aria-hidden="true" />
        <span className={styles.walletLabelLong}>Example </span>
        {shortAddress(env.account)}
      </span>
    );
  }
  if (isConnected && address) {
    return (
      <button type="button" className={styles.walletButton} onClick={wallet.open} aria-label={`Wallet ${address}`}>
        <span className={styles.walletDot} aria-hidden="true" />
        {shortAddress(address)}
      </button>
    );
  }
  return (
    <button type="button" className={`${styles.walletButton} ${styles.walletButtonPrimary}`} onClick={wallet.open}>
      Connect<span className={styles.walletLabelLong}>&nbsp;wallet</span>
    </button>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return (
    <header className={styles.header}>
      <Container>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand} aria-label="Surety home">
            <span className={styles.brandMark} aria-hidden="true" />
            Surety
          </Link>
          <nav className={styles.nav} aria-label="App">
            <NavLinks />
          </nav>
          <div className={styles.headerRight}>
            <span className={styles.networkWrap}>
              <NetworkPicker />
            </span>
            <ThemeToggle />
            <WalletButton />
            <button
              type="button"
              className={styles.menuButton}
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                {open ? (
                  <path d="M3 3l12 12M15 3 3 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                ) : (
                  <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                )}
              </svg>
            </button>
          </div>
        </div>
        <nav id="mobile-nav" className={styles.mobileNav} data-open={open} aria-label="App (menu)">
          <NavLinks onNavigate={() => setOpen(false)} />
        </nav>
      </Container>
    </header>
  );
}

function DemoBanner() {
  const env = useSurety();
  const path = normalise(usePathname());
  if (!env.demo) return null;
  return (
    <div className={`${styles.banner} ${styles.bannerDemo}`} role="note">
      <Container>
        <div className={styles.bannerInner}>
          <span className={styles.bannerText}>
            <span className={styles.bannerBadge}>Example data</span>
            {env.demo === "stale"
              ? "Mocked testnet with the BTC price feed down, to show how lines fail closed. Nothing is live and nothing is sent."
              : "Every number comes from the SDK's mocked testnet fixture. Nothing is live and nothing is sent."}
          </span>
          <Link className={styles.bannerLink} href={path}>
            Leave example mode
          </Link>
        </div>
      </Container>
    </div>
  );
}

function WrongNetworkBanner() {
  const env = useSurety();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  if (env.demo || !isConnected || chainId === undefined || isMezoChainId(chainId)) return null;
  return (
    <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert">
      <Container>
        <div className={styles.bannerInner}>
          <span className={styles.bannerText}>
            Your wallet is on another network. Surety runs on Mezo; switch to sign transactions here.
          </span>
          <Button size="sm" loading={isPending} onClick={() => switchChain({ chainId: env.chainId as 31611 | 31612 })}>
            Switch to {env.chainName}
          </Button>
        </div>
      </Container>
    </div>
  );
}

function Footer() {
  const env = useSurety();
  return (
    <footer className={styles.footer}>
      <Container>
        <div className={styles.footerInner}>
          <span>
            Surety on {env.chainName}. Every figure is read from chain through @surety/sdk; estimates are tagged.
          </span>
          <span>
            <AppLink href="/app/proof">Contracts and proof</AppLink>
          </span>
        </div>
      </Container>
    </footer>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <DemoBanner />
      <WrongNetworkBanner />
      <main id="main" className={styles.main}>
        <Container>{children}</Container>
      </main>
      <Footer />
    </>
  );
}
