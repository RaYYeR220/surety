// Placeholder landing hero. The chosen landing design replaces this file (and Hero.module.css);
// nothing else in the app depends on it.
import Link from "next/link";

import { ButtonLink } from "@/components/ui/Button";

import styles from "./Hero.module.css";

export function Hero() {
  return (
    <main className={styles.hero}>
      <span className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        Surety
      </span>
      <h1 className={styles.claim}>Bitcoin decides where MUSD credit goes.</h1>
      <p className={styles.sub}>
        Lend MUSD. veBTC holders vote where it is lent, and their rewards take the first loss if they are wrong.
      </p>
      <div className={styles.ctas}>
        <ButtonLink href="/app" size="lg">
          Open the credit board
        </ButtonLink>
        <ButtonLink href="/app/borrow" variant="secondary" size="lg">
          Borrow against your veBTC without unlocking it
        </ButtonLink>
      </div>
      <p className={styles.note}>
        Not deployed yet? <Link href="/app?demo=1">Look around with example data</Link>.
      </p>
    </main>
  );
}
