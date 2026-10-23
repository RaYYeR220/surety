import Link from "next/link";
import type { ReactNode } from "react";

import { Container } from "@/components/layout/Layout";

import styles from "./Shell.module.css";

const NAV = ["Board", "Vote", "Lend", "Borrow", "Sponsor", "Auctions", "Proof"];

/** Static frame shown before the app has read the URL (first paint of the static export). */
export function ShellFallback({ children }: { children: ReactNode }) {
  return (
    <>
      <header className={styles.header}>
        <Container>
          <div className={styles.headerInner}>
            <Link href="/" className={styles.brand}>
              <span className={styles.brandMark} aria-hidden="true" />
              Surety
            </Link>
            <nav className={styles.nav} aria-label="App">
              {NAV.map((label) => (
                <Link
                  key={label}
                  className={styles.navLink}
                  href={label === "Board" ? "/app" : `/app/${label.toLowerCase()}`}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </Container>
      </header>
      <main className={styles.main}>
        <Container>{children}</Container>
      </main>
    </>
  );
}
