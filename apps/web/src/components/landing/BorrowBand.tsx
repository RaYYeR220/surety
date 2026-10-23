"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import styles from "./BorrowBand.module.css";
import s from "./Landing.module.css";
import { useLanding } from "./LandingData";
import { Arrow } from "./Nav";

/* The gauge: a 0-100% LTV half circle, centre (120, 118), radius 92. */
const CX = 120;
const CY = 118;
const R = 92;
const at = (f: number, r = R) => {
  const t = Math.PI * (1 - f);
  return { x: CX + r * Math.cos(t), y: CY - r * Math.sin(t) };
};
const arc = (f0: number, f1: number) => {
  const a = at(f0);
  const b = at(f1);
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${R} ${R} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

/** The example loan: 1.20 BTC locked, 42,000 MUSD drawn against 120,000 MUSD of lock value. */
const LTV = 0.35;

function Gauge({ liq }: { liq: number }) {
  const knob = at(LTV);
  const tick0 = at(liq, 66);
  const tick1 = at(liq, 118);
  const lbl = at(liq, 134);
  return (
    <svg className={styles.gauge} viewBox="0 -22 240 172" aria-hidden="true">
      <defs>
        <pattern id="borrow-gh" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className={styles.hb} />
          <rect width="2" height="6" className={styles.hf} />
        </pattern>
      </defs>
      <path d={arc(0, 1)} fill="none" className={styles.k} strokeWidth={26} strokeLinecap="round" />
      <path d={arc(0, 1)} fill="none" className={styles.track} strokeWidth={21} strokeLinecap="round" />
      <path d={arc(liq, 1)} fill="none" stroke="url(#borrow-gh)" strokeWidth={21} />
      <path d={arc(0, LTV)} fill="none" className={styles.fill} strokeWidth={21} strokeLinecap="round" />
      <path d={`M${tick0.x} ${tick0.y} L${tick1.x} ${tick1.y}`} className={styles.tickBg} strokeWidth={9} strokeLinecap="round" />
      <path d={`M${tick0.x} ${tick0.y} L${tick1.x} ${tick1.y}`} className={styles.k} strokeWidth={3.5} strokeLinecap="round" />
      <text x={Math.min(lbl.x, 206)} y={Math.max(8, lbl.y)} textAnchor="middle" className={styles.sm}>
        {Math.round(liq * 100)}% LINE
      </text>
      <circle cx={knob.x} cy={knob.y} r={10} className={`${styles.knob} ${styles.k}`} strokeWidth={2.5} />
      <text x={CX} y={112} textAnchor="middle" className={styles.big}>
        {Math.round(LTV * 100)}%
      </text>
      <text x={CX} y={140} textAnchor="middle" className={styles.sm}>
        LOAN-TO-VALUE
      </text>
    </svg>
  );
}

export function BorrowBand() {
  const d = useLanding();
  const liq = d.ltv.liqBps / 10_000;
  const maxTimed = Math.round(d.ltv.maxTimedBps / 100);
  const maxPermanent = Math.round(d.ltv.maxPermanentBps / 100);
  const liqPct = Math.round(liq * 100);
  const veLine = d.lines.find((l) => /vebtc/i.test(l.name)) ?? d.lines[1] ?? d.lines[0];

  return (
    <section className={`${s.sec} ${styles.band}`} id="borrow" aria-labelledby="bw-h">
      <div className={`${s.wrap} ${styles.bw}`}>
        <figure
          className={`${styles.loan} ${s.io}`}
          aria-label={`Illustrative veBTC loan: lock number 4182, 1.20 BTC locked for three more weeks, 42,000 MUSD borrowed at 35 percent loan-to-value, under the ${liqPct} percent line, still voting and earning.`}
        >
          <div className={styles.stamp} aria-hidden="true">
            Illus&shy;trative
            <br />
            loan
          </div>
          <div className={styles.card} aria-hidden="true">
            <div className={styles.top}>
              <div className={styles.lock}>
                <span>veBTC</span>
                <b>#4182</b>
              </div>
              <div className={styles.id}>
                <strong>Your lock, still locked.</strong>
                <span>1.20 BTC · lock ends in 3 weeks</span>
                <span className={styles.cl}>
                  <i className={s.sw} style={{ "--sw": veLine?.color ?? "var(--line-2)" } as CSSProperties} />
                  {veLine?.name ?? "veBTC credit line"}
                </span>
              </div>
            </div>
            <div className={styles.mid}>
              <Gauge liq={liq} />
              <dl className={styles.facts}>
                <div>
                  <dt>Borrowed</dt>
                  <dd>42,000 MUSD</dd>
                </div>
                <div>
                  <dt>Lock value</dt>
                  <dd>120,000 MUSD</dd>
                </div>
                <div>
                  <dt>Matures</dt>
                  <dd>With the lock</dd>
                </div>
              </dl>
            </div>
            <ul className={styles.pills}>
              <li>
                <i />
                Still voting
              </li>
              <li>
                <i />
                Still earning
              </li>
              <li className={styles.au}>On default: Dutch auction</li>
            </ul>
            <div className={styles.foot}>
              <span className={`${s.ledge} ${s.pri} ${styles.draw}`}>Draw MUSD</span>
              <small>Priced by the Skip BTC/USD oracle on Mezo.</small>
            </div>
          </div>
        </figure>
        <div className={styles.copy}>
          <span className={`${s.eb} ${s.io}`}>For veBTC holders</span>
          <h2 className={`${s.h2} ${styles.h2} ${s.io}`} id="bw-h">
            Borrow against your veBTC without unlocking it.
          </h2>
          <ul className={`${styles.list} ${s.io}`} style={{ "--d": ".1s" } as CSSProperties}>
            <li>
              <b>Stays locked</b>
              <span>The lock goes into escrow and keeps voting and earning while you borrow.</span>
            </li>
            <li>
              <b>Matures with it</b>
              <span>The loan&rsquo;s maturity is your lock&rsquo;s end date. Nothing to roll.</span>
            </li>
            <li>
              <b>No redemptions</b>
              <span>MUSD comes from the vault, so nobody can redeem against your position.</span>
            </li>
            <li>
              <b>The {liqPct}% line</b>
              <span>
                Borrow up to {maxTimed}% of the lock&rsquo;s value ({maxPermanent}% for permanent locks). At {liqPct}%, or
                if the lock ends unpaid, it is sold in a Dutch auction.
              </span>
            </li>
          </ul>
          <Link className={`${s.ledge} ${s.alt} ${styles.cta} ${s.io}`} href="/app/borrow">
            Borrow against your veBTC
            <span className={s.arr}>
              <Arrow />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
