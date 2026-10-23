import Link from "next/link";

import { ThemeToggle } from "@/components/shell/ThemeToggle";

import styles from "./Nav.module.css";

export function Arrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M1 6h9M6.5 2.5 10 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <Link className={`${styles.brand} ${className ?? ""}`} href="/" aria-label="Surety home">
      <i aria-hidden="true" />
      Surety
    </Link>
  );
}

export function Nav() {
  return (
    <nav className={styles.nav} aria-label="Main">
      <Brand />
      <div className={styles.links}>
        <a href="#how">How it works</a>
        <a href="#waterfall">Who pays</a>
        <a href="#borrow">Borrow</a>
        <a href="#board">Credit board</a>
        <a href="#proof">Proof</a>
      </div>
      <div className={styles.right}>
        <ThemeToggle />
        <Link className={styles.cta} href="/app">
          Launch app
        </Link>
      </div>
    </nav>
  );
}
