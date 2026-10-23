"use client";

import type { CSSProperties } from "react";

import s from "./Landing.module.css";
import { useLanding } from "./LandingData";
import styles from "./Marquee.module.css";

const PHRASES = ["voters pay first", "rewards season four epochs", "no redemption risk"];
/** Copies of the sequence on the track; even, so translating by -50% loops seamlessly. */
const COPIES = 6;

export function Marquee() {
  const d = useLanding();
  const live = d.source !== "illustrative";
  const items: ({ kind: "line"; id: number; name: string; color: string; share: number } | { kind: "phrase"; text: string })[] =
    [];
  const n = Math.max(d.lines.length, PHRASES.length);
  for (let i = 0; i < n; i++) {
    const l = d.lines[i];
    if (l) items.push({ kind: "line", id: l.id, name: l.name, color: l.color, share: l.share });
    if (PHRASES[i]) items.push({ kind: "phrase", text: PHRASES[i]! });
  }
  const summary = d.lines.map((l) => `${l.name} ${Math.round(l.share)}%`).join(", ");
  return (
    <div className={styles.marquee}>
      <p className={s.srOnly}>
        Vote shares, {live ? `live on ${d.chainName}` : "illustrative"}: {summary}.
      </p>
      <div className={styles.track} aria-hidden="true">
        {Array.from({ length: COPIES }, (_, c) =>
          items.map((it, i) =>
            it.kind === "line" ? (
              <span key={`${c}-${i}`} className={styles.it}>
                <i className={s.sw} style={{ "--sw": it.color } as CSSProperties} />
                {it.name}
                <em>{Math.round(it.share)}%</em>
              </span>
            ) : (
              <span key={`${c}-${i}`} className={styles.ph}>
                {it.text}
              </span>
            ),
          ),
        )}
      </div>
      <div className={styles.note} aria-hidden="true">
        Vote shares · {live ? `live, ${d.chainName}` : "illustrative"}
      </div>
    </div>
  );
}
