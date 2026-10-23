"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { formatMusd, formatPct } from "@/lib/format";

import styles from "./BoardPreview.module.css";
import s from "./Landing.module.css";
import { formatFlip, periodWord, useFlip, useLanding } from "./LandingData";
import { Arrow } from "./Nav";

function delta(now: number, prev: number | null): string {
  if (prev === null) return "first tally";
  const d = Math.round(now - prev);
  if (d === 0) return "no change";
  return `${d > 0 ? "↑" : "↓"} ${Math.abs(d)} pt${Math.abs(d) === 1 ? "" : "s"}`;
}

export function BoardPreview() {
  const d = useLanding();
  const flip = useFlip(d.epochLength, d.clockSkew);
  const live = d.source !== "illustrative";
  const period = periodWord(d.epochLength);
  const max = Math.max(1, ...d.lines.map((l) => l.share));
  const scale = max > 50 ? 100 : 50;
  const title = d.source === "closed" ? `Last ${period}'s split.` : `This ${period}'s split.`;

  return (
    <section className={`${s.sec} ${styles.board}`} id="board" aria-labelledby="bd-h">
      <div className={s.wrap}>
        <div className={styles.head}>
          <div className={s.io}>
            <span className={s.eb}>The credit board</span>
            <h2 className={s.h2} id="bd-h">
              {title}
            </h2>
          </div>
          <div className={`${styles.meta} ${s.io}`} style={{ "--d": ".1s" } as CSSProperties}>
            <span className={`${s.tag} ${live ? s.tagLive : ""}`}>
              {live ? `Live · ${d.chainName}` : `Illustrative · ${d.read === "undeployed" ? "not deployed here yet" : "no votes yet"}`}
            </span>
            <div className={styles.row}>
              Next split in <strong>{flip ? formatFlip(flip.secondsLeft) : "—"}</strong>
            </div>
          </div>
        </div>
        <table className={`${styles.bd} ${s.io}`} style={{ "--d": ".15s" } as CSSProperties}>
          <caption className={s.srOnly}>
            {live ? `Live credit board on ${d.chainName}` : "Illustrative credit board"}: vote share, MUSD lent, borrow
            rate, voters&apos; first-loss cover and utilisation per credit line
          </caption>
          <thead>
            <tr>
              <th scope="col">Credit line</th>
              <th scope="col">Vote share</th>
              <th scope="col" className={styles.n}>
                Lent
              </th>
              <th scope="col" className={styles.n}>
                Borrow APY
              </th>
              <th scope="col" className={styles.n}>
                Voters&rsquo; cover
              </th>
              <th scope="col" className={styles.n}>
                Used
              </th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td className={styles.nm}>
                  <span>
                    <i className={s.sw} style={{ "--sw": l.color } as CSSProperties} />
                    {l.name}
                  </span>
                </td>
                <td className={styles.sh}>
                  <div className={styles.bar}>
                    <span className={styles.tr}>
                      <span
                        className={styles.fl}
                        style={{ width: `${Math.min(100, (l.share / scale) * 100)}%`, background: l.color }}
                      />
                    </span>
                    <b>{Math.round(l.share)}%</b>
                    <span className={styles.dl}>{delta(l.share, l.prevShare)}</span>
                  </div>
                </td>
                <td className={styles.n} data-l="Lent">
                  {formatMusd(l.lent, 0)}
                </td>
                <td className={styles.n} data-l="Borrow APY">
                  {formatPct(l.borrowApy, 1)}
                </td>
                <td className={styles.n} data-l="Voters’ cover">
                  {formatMusd(l.cover, 0)}
                </td>
                <td className={styles.n} data-l="Used">
                  {formatPct(l.utilization, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={`${styles.foot} ${s.io}`}>
          <span>
            Vault <strong>{formatMusd(d.vault.total, 0)} MUSD</strong>
          </span>
          <span>
            Reserve <strong>{d.vault.reserve === null ? "—" : `${formatMusd(d.vault.reserve, 0)} MUSD`}</strong>
          </span>
          <span>
            Sponsor incentives this {period} <strong>{formatMusd(d.vault.incentives, 0)} MUSD</strong>
          </span>
          <span>Voters&rsquo; cover = their seasoning rewards on that line, plus the reserve. It pays first.</span>
        </div>
        <div className={`${styles.cta} ${s.io}`}>
          <Link className={`${s.ledge} ${s.pri}`} href="/app">
            Open the credit board
            <span className={s.arr}>
              <Arrow />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
