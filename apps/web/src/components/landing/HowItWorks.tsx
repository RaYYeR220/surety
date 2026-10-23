"use client";

import type { CSSProperties } from "react";

import styles from "./HowItWorks.module.css";
import s from "./Landing.module.css";
import { useLanding } from "./LandingData";

const delay = (d: string) => ({ "--d": d }) as CSSProperties;

function Hop() {
  return (
    <svg className={styles.hop} viewBox="0 0 56 40" aria-hidden="true">
      <path d="M3 30 C 14 6, 34 4, 50 18 M41 11 l9 7 -11 3" />
    </svg>
  );
}

function LendGlyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 300 110" aria-hidden="true">
      <g className={styles.stroke}>
        <rect x="92" y="34" width="116" height="10" rx="5" />
        <path d="M100 44 V86 A18 18 0 0 0 118 104 H182 A18 18 0 0 0 200 86 V44" />
      </g>
      <path
        d="M104 70 Q 117 66 130 70 T 156 70 T 182 70 T 196 70 V86 A14 14 0 0 1 182 100 H118 A14 14 0 0 1 104 86 Z"
        className={styles.wash}
      />
      <text x="150" y="91" textAnchor="middle" className={styles.gl}>
        VAULT
      </text>
      <path d="M40 8 Q 120 0 146 26" className={styles.dots} />
      <circle cx="32" cy="10" r="9" className={styles.coin} />
      <text x="32" y="14" textAnchor="middle" className={styles.gl} fontSize="10">
        M
      </text>
      <g className={styles.stack}>
        <rect x="232" y="92" width="52" height="12" rx="6" />
        <rect x="236" y="80" width="52" height="12" rx="6" />
        <rect x="230" y="68" width="52" height="12" rx="6" />
        <rect x="234" y="56" width="52" height="12" rx="6" />
      </g>
      <text x="260" y="48" textAnchor="middle" className={styles.gl} fontSize="11" letterSpacing=".06em">
        MUSD
      </text>
    </svg>
  );
}

function VoteGlyph() {
  const d = useLanding();
  const lines = d.lines.slice(0, 4);
  const max = Math.max(1, ...lines.map((l) => l.share));
  const rowH = lines.length <= 2 ? 34 : 26;
  const barH = lines.length <= 2 ? 26 : 20;
  return (
    <svg className={styles.glyph} viewBox="0 0 300 110" aria-hidden="true">
      {lines.map((l, i) => {
        const w = Math.max(24, (l.share / max) * 232);
        const y = 4 + i * rowH;
        return (
          <g key={l.id}>
            <rect x="0" y={y} width={w} height={barH} rx={barH / 2} className={styles.bar} style={{ fill: l.color }} />
            <text x={w + 10} y={y + barH / 2 + 5} className={styles.gl}>
              {Math.round(l.share)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function UnderwriteGlyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 300 120" aria-hidden="true">
      <rect x="2" y="8" width="296" height="26" rx="13" className={styles.coral} />
      <path d="M120 8 l8 9 -7 8 9 9 h22 l-8 -9 7 -8 -9 -9 Z" className={styles.crack} />
      <rect x="2" y="48" width="296" height="30" rx="8" className={styles.jar} />
      <path d="M76 50 V76 M150 50 V76 M224 50 V76" className={styles.jarRule} />
      <g className={styles.jarText}>
        <text x="20" y="68">
          EP 1
        </text>
        <text x="94" y="68">
          EP 2
        </text>
        <text x="168" y="68">
          EP 3
        </text>
        <text x="242" y="68">
          EP 4
        </text>
      </g>
      <rect x="2" y="90" width="296" height="24" rx="8" className={styles.last} />
      <text x="150" y="107" textAnchor="middle" className={styles.gl} fontSize="12" letterSpacing=".06em">
        LENDERS: LAST IN LINE
      </text>
    </svg>
  );
}

export function HowItWorks() {
  return (
    <section className={s.sec} id="how" aria-labelledby="how-h">
      <div className={s.wrap}>
        <div className={styles.head}>
          <div className={s.io}>
            <span className={s.eb}>How it works</span>
            <h2 className={s.h2} id="how-h">
              Three verbs, <em>one</em> vault.
            </h2>
          </div>
          <p className={`${s.lead} ${styles.headLead} ${s.io}`} style={delay(".1s")}>
            Lenders bring the MUSD. veBTC holders steer it, and stand behind their picks. Every epoch (a week on mainnet,
            an hour on the testnet) the same three things happen, in this order.
          </p>
        </div>
        <ol className={styles.stairs}>
          <li className={`${styles.step} ${styles.s1} ${s.io}`}>
            <div className={styles.top}>
              <span className={styles.num}>01</span>
              <span className={styles.who}>for lenders</span>
            </div>
            <LendGlyph />
            <h3 className={styles.verb}>
              Lend<i>.</i>
            </h3>
            <p>Deposit MUSD into one vault. You hold one position; the vote decides where it&rsquo;s lent.</p>
          </li>
          <li className={`${styles.step} ${styles.s2} ${s.io}`} style={delay(".12s")}>
            <Hop />
            <div className={styles.top}>
              <span className={styles.num}>02</span>
              <span className={styles.who}>for veBTC holders</span>
            </div>
            <VoteGlyph />
            <h3 className={styles.verb}>
              Vote<i>.</i>
            </h3>
            <p>
              Every epoch, veBTC holders split the vault across credit lines. Voters earn a share of the interest, plus
              incentives that sponsors post.
            </p>
          </li>
          <li className={`${styles.step} ${styles.s3} ${s.io}`} style={delay(".24s")}>
            <Hop />
            <div className={styles.top}>
              <span className={styles.num}>03</span>
              <span className={styles.who}>for the voters, again</span>
            </div>
            <UnderwriteGlyph />
            <h3 className={styles.verb}>
              Under<i>write.</i>
            </h3>
            <p>Those rewards season for four epochs. If a line they backed goes bad, the rewards pay first.</p>
          </li>
        </ol>
        <p className={`${styles.foot} ${s.io}`}>
          <span className={styles.pill}>In one line</span>
          If a loan goes bad, voters&rsquo; rewards pay before any lender does.
        </p>
      </div>
    </section>
  );
}
