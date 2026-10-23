"use client";

import { explorerUrl, getDeployment, MEZO_TESTNET_ID, type SuretyDeployment } from "@surety/sdk";
import type { CSSProperties } from "react";

import { CHAIN_NAMES } from "@/lib/networks";
import { MEZO_LENDING_GAUGES_POST } from "@/lib/proof";

import styles from "./BuiltOnMezo.module.css";
import s from "./Landing.module.css";
import { useLanding } from "./LandingData";

interface Coin {
  name: string;
  small: string;
  note: string;
  tone?: "ac" | "dk";
  address: (d: SuretyDeployment) => string;
}

const COINS: Coin[] = [
  { name: "MUSD", small: "the dollar", note: "What lenders deposit and borrowers draw.", address: (d) => d.external.musd },
  {
    name: "veBTC",
    small: "Mezo Earn",
    note: "The votes, and the lock you can borrow against.",
    tone: "ac",
    address: (d) => d.external.veBTC,
  },
  { name: "Morpho Blue", small: "on Mezo", note: "The markets each credit line lends into.", address: (d) => d.contracts.morpho },
  { name: "VaultV2", small: "Morpho", note: "The one vault lenders hold.", tone: "dk", address: (d) => d.contracts.vault },
  {
    name: "Skip",
    small: "BTC / USD",
    note: "The price for loan-to-value and auctions.",
    address: (d) => d.external.skipAggregator,
  },
];

function fallbackDeployment(): SuretyDeployment | null {
  try {
    return getDeployment(MEZO_TESTNET_ID) ?? null;
  } catch {
    return null;
  }
}

export function BuiltOnMezo() {
  const d = useLanding();
  const deployment = d.deployment ?? fallbackDeployment();
  const chainId = d.deployment ? d.chainId : MEZO_TESTNET_ID;
  return (
    <section className={s.sec} id="built" aria-labelledby="bt-h">
      <div className={`${s.wrap} ${styles.bt}`}>
        <div className={s.io}>
          <span className={s.eb}>Built on Mezo</span>
          <h2 className={s.h2} id="bt-h">
            Made from Mezo&rsquo;s own parts.
          </h2>
          <p className={styles.quote}>
            Built for the{" "}
            <a href={MEZO_LENDING_GAUGES_POST} target="_blank" rel="noopener noreferrer">
              <q>Aerodrome for lending</q>
            </a>{" "}
            idea on Mezo&rsquo;s blog: lending gauges, where veBTC votes decide where credit goes.
          </p>
          {deployment ? (
            <p className={styles.hint}>Each coin opens its contract on the {CHAIN_NAMES[chainId]} explorer.</p>
          ) : null}
        </div>
        <ul className={styles.coins}>
          {COINS.map((c, i) => {
            const inner = (
              <>
                {c.name}
                <small>{c.small}</small>
              </>
            );
            const cls = `${styles.coin} ${c.tone ? styles[c.tone] : ""}`;
            return (
              <li key={c.name} className={s.io} style={{ "--d": `${i * 0.06}s` } as CSSProperties}>
                {deployment ? (
                  <a
                    className={cls}
                    href={explorerUrl(chainId, "address", c.address(deployment))}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${c.name} (${c.small}) on the ${CHAIN_NAMES[chainId]} explorer`}
                  >
                    {inner}
                  </a>
                ) : (
                  <span className={cls}>{inner}</span>
                )}
                <p>{c.note}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
