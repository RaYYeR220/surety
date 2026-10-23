"use client";

// The first-loss waterfall as an explanatory simulation: a bad debt on the veBTC line drains the voters'
// seasoning rewards first, then the reserve, and only then the lenders' vault. Every figure here is a
// fixed illustration (labelled as one); the real cushions are on the credit board.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import s from "./Landing.module.css";
import styles from "./Waterfall.module.css";

const V = { voters: 1840, reserve: 3100, lenders: 250_000 };
const SIZES = [1200, 3500, 6000];
const LINE_LENT = 95_000;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

type Mode = "d" | "m";

interface Jar {
  x: number;
  y: number;
  w: number;
  h: number;
  lab: { x: number; y: number; a: "start" | "end" };
  sub: string[];
}

interface Layout {
  W: number;
  H: number;
  lane: { y: number; h: number; crack: number; cw: number };
  fs: number;
  jars: Jar[];
  pipes: [string, string];
  s0: string;
  season: { x: number; text: string };
}

const LAY: Record<Mode, Layout> = {
  d: {
    W: 720,
    H: 628,
    lane: { y: 6, h: 42, crack: 150, cw: 44 },
    fs: 1,
    jars: [
      { x: 96, y: 118, w: 200, h: 136, lab: { x: 330, y: 136, a: "start" }, sub: ["Pays first", "Seasons for four epochs"] },
      { x: 372, y: 318, w: 176, h: 110, lab: { x: 346, y: 334, a: "end" }, sub: ["Pays second"] },
      { x: 500, y: 476, w: 206, h: 116, lab: { x: 474, y: 492, a: "end" }, sub: ["Only after both", "are empty"] },
    ],
    pipes: ["M288 238 H452 V326", "M540 412 H612 V484"],
    s0: "M172 48 V126",
    season: { x: 74, text: "4-EPOCH SEASONING" },
  },
  m: {
    W: 358,
    H: 640,
    lane: { y: 4, h: 38, crack: 70, cw: 34 },
    fs: 0.8,
    jars: [
      { x: 30, y: 104, w: 146, h: 116, lab: { x: 192, y: 118, a: "start" }, sub: ["Pays first", "Seasons 4 epochs"] },
      { x: 188, y: 300, w: 150, h: 100, lab: { x: 170, y: 304, a: "end" }, sub: ["Pays second"] },
      { x: 30, y: 482, w: 150, h: 112, lab: { x: 196, y: 496, a: "start" }, sub: ["Only after", "both are empty"] },
    ],
    pipes: ["M168 204 H262 V306", "M196 384 H110 V488"],
    s0: "M87 42 V112",
    season: { x: 14, text: "4 EPOCHS" },
  },
};

const TITLES = ["01 · Voters’ rewards", "02 · Reserve", "03 · Lenders"];
const LIQ = ["var(--color-accent)", "var(--band-ink-reserve)", "var(--band-ink-fg)"];

function arect(x: number, y: number, w: number, h: number, a: number, b: number): string {
  return `M${x + a},${y}H${x + w - b}A${b},${b} 0 0 1 ${x + w},${y + b}V${y + h - a}A${a},${a} 0 0 1 ${x + w - a},${y + h}H${x + b}A${b},${b} 0 0 1 ${x},${y + h - b}V${y + a}A${a},${a} 0 0 1 ${x + a},${y}Z`;
}

function jarBody(j: Jar, inset = 0): string {
  const x = j.x + inset;
  const w = j.w - 2 * inset;
  const y = j.y + 10;
  const b = j.y + j.h - inset;
  const r = 26 - inset;
  return `M${x},${y}V${b - r}A${r},${r} 0 0 0 ${x + r},${b}H${x + w - r}A${r},${r} 0 0 0 ${x + w},${b - r}V${y}Z`;
}

function inner(j: Jar) {
  const top = j.y + 18;
  const bot = j.y + j.h - 6;
  return { top, bot, h: bot - top };
}

function waveD(j: Jar, f: number): string {
  const ib = inner(j);
  const y = ib.bot - f * ib.h * 0.86;
  let d = `M${j.x},${ib.bot + 8}V${y}`;
  for (let x = j.x, k = 0; x < j.x + j.w; x += 16, k++) {
    d += ` Q${x + 8},${y + (k % 2 ? 2.5 : -2.5)} ${Math.min(x + 16, j.x + j.w)},${y}`;
  }
  return `${d}V${ib.bot + 8}Z`;
}

interface Sim {
  lv: number[];
  bite: number;
  flows: number[];
  crack: number;
  amts: number[];
  notes: string[];
}

const full = (): Sim => ({
  lv: [1, 1, 1],
  bite: 0,
  flows: [0, 0, 0],
  crack: 0,
  amts: [V.voters, V.reserve, V.lenders],
  notes: ["", "", ""],
});

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

type Result = { size: number; v: number; r: number; l: number };

function statusText(result: Result | "running" | null): ReactNode {
  if (result === null) return "Flip the switch to send a bad debt down the waterfall.";
  if (result === "running") return "Running…";
  const { size, v, r, l } = result;
  if (l > 0) {
    return (
      <>
        A <b>{fmt(size)} MUSD</b> bad debt on the veBTC credit line. Voters pay <b>{fmt(v)}</b>, the reserve pays{" "}
        <b>{fmt(r)}</b>, and lenders cover the last <b>{fmt(l)}</b>: {((l / V.lenders) * 100).toFixed(2)}% of the vault.
      </>
    );
  }
  if (r > 0) {
    return (
      <>
        A <b>{fmt(size)} MUSD</b> bad debt on the veBTC credit line. Voters&rsquo; rewards pay <b>{fmt(v)}</b> and run
        dry; the reserve pays the other <b>{fmt(r)}</b>. Lenders are untouched.
      </>
    );
  }
  return (
    <>
      A <b>{fmt(size)} MUSD</b> bad debt on the veBTC credit line. Voters&rsquo; rewards cover all of it, with{" "}
      <b>{fmt(V.voters - v)} MUSD</b> left seasoning. Reserve and lenders are untouched.
    </>
  );
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Waterfall() {
  const figRef = useRef<HTMLElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const [mode, setMode] = useState<Mode>("d");
  const [on, setOn] = useState(false);
  const [size, setSize] = useState(SIZES[0]!);
  const [st, setSt] = useState<Sim>(full);
  const [lost, setLost] = useState(0);
  const [tagValue, setTagValue] = useState(0);
  const [result, setResult] = useState<Result | "running" | null>(null);
  const run = useRef(0);
  const cur = useRef<Sim>(full());

  const commit = () => {
    const c = cur.current;
    setSt({ ...c, lv: [...c.lv], flows: [...c.flows], amts: [...c.amts], notes: [...c.notes] });
  };

  const tween = (id: number, ms: number, apply: (k: number) => void) =>
    new Promise<boolean>((resolve) => {
      if (reducedMotion() || ms === 0) {
        apply(1);
        commit();
        resolve(id === run.current);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        if (id !== run.current) return resolve(false);
        const p = Math.min(1, (now - t0) / ms);
        apply(easeOut(p));
        commit();
        if (p < 1) requestAnimationFrame(step);
        else resolve(true);
      };
      requestAnimationFrame(step);
    });

  const simulate = async (amount: number) => {
    const id = ++run.current;
    const v = Math.min(amount, V.voters);
    const r = Math.min(amount - v, V.reserve);
    const l = amount - v - r;
    const c = full();
    cur.current = c;
    commit();
    setLost(0);
    setTagValue(amount);
    setResult("running");
    if (!(await tween(id, 260, (k) => (c.crack = k)))) return;
    if (!(await tween(id, 380, (k) => (c.flows[0] = k)))) return;
    if (
      !(await tween(id, 800, (k) => {
        c.lv[0] = 1 - (k * v) / V.voters;
        c.amts[0] = V.voters - k * v;
      }))
    )
      return;
    c.notes[0] = `paid ${fmt(v)}`;
    if (r > 0) {
      if (!(await tween(id, 320, (k) => (c.flows[1] = k)))) return;
      if (
        !(await tween(id, 650, (k) => {
          c.lv[1] = 1 - (k * r) / V.reserve;
          c.amts[1] = V.reserve - k * r;
        }))
      )
        return;
      c.notes[1] = `paid ${fmt(r)}`;
    } else c.notes[1] = "untouched";
    if (l > 0) {
      if (!(await tween(id, 320, (k) => (c.flows[2] = k)))) return;
      if (
        !(await tween(id, 600, (k) => {
          c.bite = k;
          c.amts[2] = V.lenders - k * l;
          setLost(k * l);
        }))
      )
        return;
      c.notes[2] = `lost ${fmt(l)} · ${((l / V.lenders) * 100).toFixed(2)}%`;
    } else c.notes[2] = "untouched";
    commit();
    setResult({ size: amount, v, r, l });
  };

  const refill = async () => {
    const id = ++run.current;
    const from = cur.current;
    const fl = [...from.lv];
    const fa = [...from.amts];
    const fb = from.bite;
    const ff = [...from.flows];
    const fc = from.crack;
    const c: Sim = { ...from, notes: ["", "", ""] };
    cur.current = c;
    const target = [V.voters, V.reserve, V.lenders];
    await tween(id, 450, (k) => {
      c.lv = fl.map((f) => f + (1 - f) * k);
      c.amts = fa.map((a, i) => a + (target[i]! - a) * k);
      c.bite = fb * (1 - k);
      c.flows = ff.map((f) => f * (1 - k));
      c.crack = fc * (1 - k);
    });
    setLost(0);
    setResult(null);
  };

  const toggle = () => {
    const next = !on;
    setOn(next);
    if (next) void simulate(size);
    else void refill();
  };

  const pick = (amount: number, focus = false) => {
    setSize(amount);
    if (focus) radios.current[SIZES.indexOf(amount)]?.focus();
    if (on) void simulate(amount);
  };

  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    pick(SIZES[(i + dir + SIZES.length) % SIZES.length]!, true);
  };

  // Layout follows the figure's width.
  useEffect(() => {
    const fig = figRef.current;
    if (!fig) return;
    const measure = () => setMode(fig.clientWidth < 560 ? "m" : "d");
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(fig);
    return () => ro.disconnect();
  }, []);

  // ?sim=3500 opens the page with that simulation already run (review shots, links from the app).
  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get("sim"));
    if (!SIZES.includes(q)) return;
    const raf = requestAnimationFrame(() => {
      setSize(q);
      setOn(true);
      void simulate(q);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);

  const L = LAY[mode];
  const sc = L.fs;
  const ln = L.lane;
  const tagW = mode === "d" ? 176 : 104;

  return (
    <section className={`${s.sec} ${styles.band}`} id="waterfall" aria-labelledby="wf-h">
      <div className={`${s.wrap} ${styles.wf}`}>
        <div className={styles.copy}>
          <span className={`${s.eb} ${s.io}`}>The waterfall · simulation</span>
          <h2 className={`${s.h2} ${s.io}`} id="wf-h">
            Who pays when a loan goes bad.
          </h2>
          <p className={`${s.lead} ${styles.lead} ${s.io}`}>
            Voters&rsquo; rewards sit in a four-epoch seasoning jar. A bad debt drains that jar first, then the reserve.
            Lenders are touched only after both are empty.
          </p>
          <div className={`${styles.sim} ${s.io}`}>
            <button type="button" className={styles.switch} role="switch" aria-checked={on} onClick={toggle} id="wf-switch">
              <span className={styles.trk} aria-hidden="true" />
              Simulate a bad debt
            </button>
            <div className={styles.sizes} role="radiogroup" aria-label="Size of the bad debt, in MUSD">
              <span className={styles.lbl} aria-hidden="true">
                Size
              </span>
              {SIZES.map((n, i) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={size === n}
                  tabIndex={size === n ? 0 : -1}
                  ref={(el) => {
                    radios.current[i] = el;
                  }}
                  onClick={() => pick(n)}
                  onKeyDown={(e) => onRadioKey(e, i)}
                >
                  {fmt(n)}
                </button>
              ))}
              <span aria-hidden="true">MUSD</span>
            </div>
          </div>
          <div className={`${styles.giant} ${s.io}`}>
            <span className={styles.gl}>Lenders lost</span>
            <output htmlFor="wf-switch" className={styles.out}>
              {fmt(lost)}
            </output>
            <span className={styles.gu}>MUSD</span>
          </div>
          <p className={styles.status} aria-live="polite">
            {statusText(result)}
          </p>
        </div>
        <figure ref={figRef} className={`${styles.fig} ${s.io}`} style={{ "--d": ".15s" } as CSSProperties}>
          <svg viewBox={`0 0 ${L.W} ${L.H}`} role="img" aria-labelledby="wf-t wf-desc">
            <title id="wf-t">Loss waterfall for the veBTC credit line</title>
            <desc id="wf-desc">
              Three jars on stepped shelves. Jar one, voters&apos; seasoning rewards, {fmt(V.voters)} MUSD, pays first. Jar
              two, the reserve, {fmt(V.reserve)} MUSD, pays second. Jar three, the lenders&apos; vault, {fmt(V.lenders)} MUSD,
              pays only after both are empty.
            </desc>
            <defs>
              <pattern id="wfh" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="8" height="8" className={styles.hb} />
                <rect width="3" height="8" className={styles.hf} />
              </pattern>
              {L.jars.map((j, i) => (
                <clipPath key={i} id={`wfc${i}`}>
                  <path d={jarBody(j, 6)} />
                </clipPath>
              ))}
            </defs>
            {/* the credit line on top */}
            <rect x={2} y={ln.y + 5} width={L.W - 4} height={ln.h} rx={ln.h / 2} className={styles.fgf} />
            <rect x={2} y={ln.y} width={L.W - 4} height={ln.h} rx={ln.h / 2} className={`${styles.lane} ${styles.fgk}`} strokeWidth={2.5} />
            <text x={L.W - 18} y={ln.y + ln.h / 2 + 5.5 * sc} textAnchor="end" className={styles.tl} fontSize={15 * sc}>
              {mode === "d" ? `veBTC credit line · ${fmt(LINE_LENT)} MUSD lent` : "veBTC credit line"}
            </text>
            <g opacity={st.crack}>
              <path
                d={`M${ln.crack},${ln.y} l8,${ln.h * 0.3} -7,${ln.h * 0.3} 8,${ln.h * 0.4} H${ln.crack + ln.cw} l-8,-${ln.h * 0.4} 7,-${ln.h * 0.3} -8,-${ln.h * 0.3}Z`}
                fill="url(#wfh)"
                className={styles.fgk}
                strokeWidth={2.5}
                strokeLinejoin="round"
              />
              <rect x={ln.crack + ln.cw + 12} y={ln.y + 7} width={tagW} height={ln.h - 14} rx={(ln.h - 14) / 2} className={styles.tagBg} />
              <text x={ln.crack + ln.cw + 12 + tagW / 2} y={ln.y + ln.h / 2 + 4.5 * sc} textAnchor="middle" className={styles.tb} fontSize={13 * sc}>
                {mode === "d" ? `bad debt −${fmt(tagValue)} MUSD` : `−${fmt(tagValue)} MUSD`}
              </text>
            </g>
            {/* shelves */}
            {L.jars.map((j, i) => {
              const d = arect(j.x - 18, j.y + j.h + 6, j.w + 36, 14, 9, 3);
              return (
                <g key={`shelf${i}`}>
                  <path d={d} className={styles.fgf} transform="translate(0 5)" />
                  <path d={d} className={`${styles.pnf} ${styles.fgk}`} strokeWidth={2} />
                </g>
              );
            })}
            {/* pipes, then the loss flowing through them */}
            {[L.s0, L.pipes[0], L.pipes[1]].map((d, i) => (
              <g key={`pipe${i}`}>
                <path d={d} className={styles.fgk} fill="none" strokeWidth={18} strokeLinejoin="round" />
                <path d={d} className={styles.bgk} fill="none" strokeWidth={11} strokeLinejoin="round" />
                <path
                  d={d}
                  fill="none"
                  stroke="url(#wfh)"
                  strokeWidth={11}
                  strokeLinejoin="round"
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - (st.flows[i] ?? 0)}
                />
              </g>
            ))}
            {/* jars */}
            {L.jars.map((j, i) => {
              const f = st.lv[i] ?? 1;
              const ib = inner(j);
              const top = ib.bot - f * ib.h * 0.86;
              return (
                <g key={`jar${i}`}>
                  <path d={jarBody(j)} className={styles.pnf} />
                  <g clipPath={`url(#wfc${i})`}>
                    {f > 0.004 ? <path d={waveD(j, f)} style={{ fill: LIQ[i] }} /> : null}
                    {i === 0
                      ? [1, 2, 3].map((k) => {
                          const y = ib.bot - (k / 4) * ib.h * 0.86;
                          return (
                            <path
                              key={k}
                              d={`M${j.x},${y}H${j.x + j.w}`}
                              className={styles.div}
                              strokeDasharray="3 4"
                              opacity={y > top + 3 ? 1 : 0}
                            />
                          );
                        })
                      : null}
                    {i === 2 ? <rect x={j.x} y={top - 3} width={j.w} height={st.bite * 11} fill="url(#wfh)" /> : null}
                  </g>
                  <path d={jarBody(j)} fill="none" className={styles.fgk} strokeWidth={2.5} strokeLinejoin="round" />
                  <rect x={j.x - 7} y={j.y} width={j.w + 14} height={12} rx={6} className={`${styles.pnf} ${styles.fgk}`} strokeWidth={2.5} />
                </g>
              );
            })}
            {/* labels */}
            {L.jars.map((j, i) => {
              const a = j.lab.a;
              let y = j.lab.y;
              const rows: ReactNode[] = [];
              rows.push(
                <text key="t" x={j.lab.x} y={y} textAnchor={a} className={styles.t1} fontSize={17 * sc}>
                  {TITLES[i]}
                </text>,
              );
              y += 22 * sc;
              j.sub.forEach((t, k) => {
                rows.push(
                  <text key={`s${k}`} x={j.lab.x} y={y} textAnchor={a} className={styles.t2} fontSize={Math.max(12, 13.5 * sc)}>
                    {t}
                  </text>,
                );
                y += Math.max(16, 18 * sc);
              });
              y += 12 * sc;
              rows.push(
                <text key="a" x={j.lab.x} y={y} textAnchor={a} className={styles.t3} fontSize={22 * sc}>
                  {fmt(st.amts[i] ?? 0)} MUSD
                </text>,
              );
              y += 20 * sc;
              rows.push(
                <text key="n" x={j.lab.x} y={y} textAnchor={a} className={styles.t4} fontSize={Math.max(12, 13 * sc)}>
                  {st.notes[i]}
                </text>,
              );
              return <g key={`lab${i}`}>{rows}</g>;
            })}
            <text
              x={L.season.x}
              y={L.jars[0]!.y + L.jars[0]!.h / 2 + 10}
              textAnchor="middle"
              className={styles.t5}
              fontSize={11 * sc}
              transform={`rotate(-90 ${L.season.x} ${L.jars[0]!.y + L.jars[0]!.h / 2 + 10})`}
            >
              {L.season.text}
            </text>
          </svg>
          <figcaption>
            <span className={s.tag}>Simulation</span>
            One credit line, example cushions. The live ones are on the credit board.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
