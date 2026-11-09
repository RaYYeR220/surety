"use client";

import { MEZO_MAINNET_ID, MEZO_TESTNET_ID, isMezoChainId } from "@surety/sdk";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";

import { Container } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { BURNER_CHAIN_ID, BURNER_ID } from "@/lib/burner";
import type { DemoScenario } from "@/lib/demo";
import { useSurety } from "@/lib/env";
import { shortAddress } from "@/lib/format";

import { AppLink } from "./AppLink";
import { PageSkeleton } from "./EnvGate";
import { FreshnessStrip } from "./Freshness";
import { MORE_NAV, normalisePath, PRIMARY_NAV, present, TRY_NAV, type NavItem } from "./nav";
import styles from "./Shell.module.css";
import { ThemeToggle } from "./ThemeToggle";
import { useWalletDialog } from "./WalletDialog";

/** @deprecated The primary links only; the full set lives in ./nav. */
export const NAV = PRIMARY_NAV;

function NavLink({ item, path, onNavigate, className }: { item: NavItem; path: string; onNavigate?: () => void; className?: string }) {
  return (
    <AppLink
      href={item.href}
      className={className ?? styles.navLink}
      aria-current={path === item.href ? "page" : undefined}
      onClick={onNavigate}
    >
      {item.label}
    </AppLink>
  );
}

/** "More" disclosure: a button and a list of links; Escape, a click outside or leaving it with Tab closes it. */
function MoreMenu({ items, path }: { items: NavItem[]; path: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = items.find((i) => i.href === path);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div
      className={styles.more}
      ref={wrap}
      onBlur={(e) => {
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={styles.navLink}
        aria-expanded={open}
        aria-controls={panelId}
        data-active={active ? "true" : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {active ? active.label : "More"}
        <svg className={styles.moreChevron} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <ul id={panelId} className={styles.morePanel} hidden={!open}>
        {items.map((item) => (
          <li key={item.href}>
            <NavLink item={item} path={path} className={styles.moreLink} onNavigate={() => setOpen(false)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mainnet or testnet, one click each way. The choice is remembered in this browser. */
function NetworkSwitch() {
  const env = useSurety();
  const { isConnected, connector } = useAccount();
  const { switchChain } = useSwitchChain();
  const { disconnect } = useDisconnect();
  if (env.demo) {
    return (
      <span className={styles.netDemo}>
        <span className={styles.networkDot} data-tone="warning" aria-hidden="true" />
        Example data
      </span>
    );
  }
  const pick = (id: number) => {
    if (id === env.chainId) return;
    // The testnet key only works on testnet: leaving testnet disconnects it (the key stays in this browser).
    if (connector?.id === BURNER_ID && id !== BURNER_CHAIN_ID) disconnect();
    else if (isConnected) switchChain({ chainId: id as 31611 | 31612 });
    env.selectChain(id);
  };
  return (
    <div className={styles.netSwitch} role="group" aria-label="Network">
      {[MEZO_MAINNET_ID, MEZO_TESTNET_ID].map((id) => (
        <button key={id} type="button" aria-pressed={env.chainId === id} onClick={() => pick(id)}>
          <span className={styles.networkDot} data-tone={id === MEZO_TESTNET_ID ? "warning" : undefined} aria-hidden="true" />
          {id === MEZO_MAINNET_ID ? "Mainnet" : "Testnet"}
        </button>
      ))}
    </div>
  );
}

function WalletButton() {
  const env = useSurety();
  const { address, isConnected, connector } = useAccount();
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
    const burner = connector?.id === BURNER_ID;
    return (
      <button
        type="button"
        className={styles.walletButton}
        onClick={wallet.open}
        aria-label={`${burner ? "Testnet key" : "Wallet"} ${address}`}
      >
        <span className={styles.walletDot} data-tone={burner ? "warning" : undefined} aria-hidden="true" />
        {burner ? <span className={styles.walletLabelLong}>Test key </span> : null}
        {shortAddress(address)}
      </button>
    );
  }
  return (
    <button type="button" className={`${styles.walletButton} ${styles.walletButtonPrimary}`} onClick={wallet.open}>
      <span>
        Connect<span className={styles.walletLabelLong}> wallet</span>
      </span>
    </button>
  );
}

function Header({ routes }: { routes: string[] | null }) {
  const rawPath = usePathname();
  const path = normalisePath(rawPath);
  const primary = present(PRIMARY_NAV, routes);
  const more = present(MORE_NAV, routes);
  const tryIt = present([TRY_NAV], routes)[0];
  // The menu belongs to the page it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === rawPath;
  const close = () => setOpenOn(null);
  return (
    <header className={styles.header}>
      <Container>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand} aria-label="Surety home">
            <span className={styles.brandMark} aria-hidden="true" />
            Surety
          </Link>
          <nav className={styles.nav} aria-label="App">
            {primary.map((item) => (
              <NavLink key={item.href} item={item} path={path} />
            ))}
            <MoreMenu items={more} path={path} />
            {tryIt ? <NavLink item={tryIt} path={path} className={`${styles.navLink} ${styles.tryLink}`} /> : null}
          </nav>
          <div className={styles.headerRight}>
            <span className={styles.networkWrap}>
              <NetworkSwitch />
            </span>
            <ThemeToggle />
            <WalletButton />
            <button
              type="button"
              className={styles.menuButton}
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpenOn(open ? null : rawPath)}
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
          {open ? (
            <>
              {[...primary, ...(tryIt ? [tryIt] : [])].map((item) => (
                <NavLink key={item.href} item={item} path={path} onNavigate={close} />
              ))}
              {more.length ? <span className={styles.mobileGroup}>More</span> : null}
              {more.map((item) => (
                <NavLink key={item.href} item={item} path={path} onNavigate={close} />
              ))}
              <span className={styles.mobileNetwork}>
                <NetworkSwitch />
              </span>
            </>
          ) : null}
        </nav>
      </Container>
    </header>
  );
}

const DEMO_TEXT: Record<DemoScenario, string> = {
  default: "Every number comes from the SDK's mocked testnet fixture. Nothing is live and nothing is sent.",
  stale:
    "Mocked testnet with the BTC price feed down, to show how lines fail closed. Nothing is live and nothing is sent.",
  paused:
    "Mocked testnet with a loss waiting for cover, to show how deposits pause. Nothing is live and nothing is sent.",
  depeg:
    "Mocked testnet with MUSD off its peg, to show the breaker refusing new loans and new allocations. Nothing is live and nothing is sent.",
  v1: "Mocked testnet on the first contracts, without the peg, fees, savings or the share market. Nothing is live and nothing is sent.",
};

function DemoBanner() {
  const env = useSurety();
  const path = normalisePath(usePathname());
  if (!env.demo) return null;
  return (
    <div className={`${styles.banner} ${styles.bannerDemo}`} role="note">
      <Container>
        <div className={styles.bannerInner}>
          <span className={styles.bannerText}>
            <span className={styles.bannerBadge}>Example data</span>
            {DEMO_TEXT[env.demo] ?? DEMO_TEXT.default}
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

function Footer({ routes }: { routes: string[] | null }) {
  const env = useSurety();
  const links = present(
    [
      { href: "/app/review", label: "Review in 5 minutes" },
      { href: "/app/ledger", label: "Who uses Surety" },
      { href: "/app/proof", label: "Contracts and proof" },
    ],
    routes,
  );
  return (
    <footer className={styles.footer}>
      <Container>
        <div className={styles.footerInner}>
          <span>
            Surety on {env.chainName}. Every figure is read from chain through @surety/sdk; estimates are tagged.
          </span>
          <span className={styles.footerLinks}>
            {links.map((l) => (
              <AppLink key={l.href} href={l.href}>
                {l.label}
              </AppLink>
            ))}
          </span>
        </div>
      </Container>
    </footer>
  );
}

export function AppShell({ routes, children }: { routes: string[] | null; children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header routes={routes} />
      <FreshnessStrip />
      <DemoBanner />
      <WrongNetworkBanner />
      <main id="main" className={styles.main}>
        <Container>
          {/* Pages that read the URL (useSearchParams) render in the browser; the rest are in the static HTML. */}
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </Container>
      </main>
      <Footer routes={routes} />
    </>
  );
}
