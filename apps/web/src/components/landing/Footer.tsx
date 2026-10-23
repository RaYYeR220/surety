import Link from "next/link";

import styles from "./Footer.module.css";
import { Brand } from "./Nav";

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

export function Footer() {
  return (
    <footer className={styles.foot}>
      <div className={styles.inner}>
        <div className={styles.about}>
          <Brand />
          <p>
            Lending gauges for Mezo. veBTC holders vote where the vault&rsquo;s MUSD is lent, and their rewards pay first
            if they&rsquo;re wrong.
          </p>
        </div>
        <div>
          <h2>Product</h2>
          <ul>
            <li>
              <Link href="/app">Credit board</Link>
            </li>
            <li>
              <Link href="/app/lend">Lend</Link>
            </li>
            <li>
              <Link href="/app/vote">Vote</Link>
            </li>
            <li>
              <Link href="/app/borrow">Borrow</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2>Learn</h2>
          <ul>
            <li>
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="#waterfall">Who pays</a>
            </li>
            <li>
              <Link href="/app/proof">Contracts and proof</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2>Mezo</h2>
          <ul>
            <li>
              <a href="https://mezo.org" {...EXT}>
                Mezo
              </a>
            </li>
            <li>
              <a href="https://mezo.org/docs/users/mezo-earn/overview/" {...EXT}>
                Mezo Earn
              </a>
            </li>
            <li>
              <a href="https://faucet.test.mezo.org/" {...EXT}>
                Testnet faucet
              </a>
            </li>
          </ul>
        </div>
      </div>
      <span className={styles.wordmark} aria-hidden="true">
        Sure<i>ty</i>
      </span>
    </footer>
  );
}
