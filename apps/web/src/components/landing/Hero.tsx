"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import styles from "./Hero.module.css";
import s from "./Landing.module.css";
import { formatFlip, formatFlipAt, periodWord, useFlip, useLanding, type LandingData } from "./LandingData";
import { Marquee } from "./Marquee";
import { Arrow } from "./Nav";
import { Pour } from "./Pour";

const delay = (d: string) => ({ "--d": d }) as CSSProperties;

/** Caption under the pour: where the split comes from, said plainly. */
export function splitStatus(d: LandingData): { live: boolean; text: string } {
  const period = periodWord(d.epochLength);
  if (d.source === "current") return { live: true, text: `${d.chainName} · this ${period}'s veBTC vote` };
  if (d.source === "closed") return { live: true, text: `${d.chainName} · the last closed ${period}'s veBTC vote` };
  if (d.read === "undeployed") return { live: false, text: `Surety is not deployed on ${d.chainName} yet` };
  if (d.read === "loading") return { live: false, text: `Reading the vote on ${d.chainName}…` };
  if (d.read === "error") return { live: false, text: `Could not reach ${d.chainName}; showing an example split` };
  return { live: false, text: `No veBTC votes on ${d.chainName} yet this ${period}` };
}

function EpochChip() {
  const d = useLanding();
  const flip = useFlip(d.epochLength, d.clockSkew);
  return (
    <div className={`${styles.chip} ${s.rv}`} style={delay(".05s")}>
      <b>Next split</b>
      <span>
        <span className={styles.lg}>Votes re-split the vault </span>in{" "}
        <span className={styles.cd} role="timer" aria-live="off">
          {flip ? formatFlip(flip.secondsLeft) : "—"}
        </span>
        {flip ? <span className={styles.lg}> · {formatFlipAt(flip.nextFlip, d.epochLength)}</span> : null}
      </span>
    </div>
  );
}

export function Hero() {
  const d = useLanding();
  const status = splitStatus(d);
  const period = periodWord(d.epochLength);
  const whose = d.source === "closed" ? `last ${period}'s` : `this ${period}'s`;
  const label =
    `${status.live ? "Live" : "Illustrative"}: the vault's MUSD poured into ${d.lines.length} credit lines, ` +
    `each lane as wide as its share of ${whose} veBTC vote. ` +
    d.lines.map((l) => `${l.name} ${Math.round(l.share)} percent`).join(", ") +
    ".";

  return (
    <header className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.claim}>
          <EpochChip />
          <h1 className={`${styles.h1} ${s.rv}`} style={delay(".12s")}>
            Bitcoin decides where{" "}
            <span className={styles.mk}>
              MUSD credit
              <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                <path pathLength={1} d="M2 7 C 22 2, 48 3, 66 5 S 90 8, 98 3" />
              </svg>
            </span>{" "}
            goes.
          </h1>
          <p className={`${styles.sub} ${s.rv}`} style={delay(".25s")}>
            Lend MUSD. veBTC holders vote where it&rsquo;s lent, and their rewards take the first loss if they&rsquo;re
            wrong.
          </p>
          <div className={`${styles.ctas} ${s.rv}`} style={delay(".35s")}>
            <Link className={`${s.ledge} ${s.pri}`} href="/app">
              Open the credit board
              <span className={s.arr}>
                <Arrow />
              </span>
            </Link>
            <Link className={`${s.ledge} ${s.secBtn}`} href="/app/borrow">
              Borrow against your veBTC without unlocking it
            </Link>
          </div>
        </div>
        <figure className={`${styles.pour} ${s.rv}`} style={delay(".3s")}>
          <Pour
            lines={d.lines}
            annotation={{ long: `lane width = ${whose} veBTC vote`, short: `width = ${whose} vote` }}
            label={label}
          />
          <figcaption className={styles.caption}>
            <span className={`${s.tag} ${status.live ? s.tagLive : ""}`}>{status.live ? "Live" : "Illustrative"}</span>
            <span>{status.text}</span>
          </figcaption>
        </figure>
      </div>
      <Marquee />
    </header>
  );
}
