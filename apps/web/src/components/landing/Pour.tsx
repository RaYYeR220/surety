"use client";

// The hero's focal object: the vault pours its MUSD into one outlined lane per credit line, each lane as
// wide as the line's share of the veBTC vote. Shares tween from the previous epoch to the current one
// once; MUSD coins riding the lanes are the only idle loop (paused offscreen, off under reduced motion).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import styles from "./Pour.module.css";

export interface PourLine {
  id: number;
  name: string;
  color: string;
  /** 0..100 */
  share: number;
  prevShare: number | null;
}

interface Geo {
  W: number;
  H: number;
  m: boolean;
  vw: number;
  tagW: number;
  tagH: number;
  cap: number;
  gapS: number;
  gapD: number;
  top: number;
  bot: number;
  sh: number;
  k: number;
  dTop: number;
  dBot: number;
  fs: number;
  pad: number;
  xEnd: number;
  dx: number;
  x0: number;
  mx: number;
  avail: number;
}

interface Lane {
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Asymmetric rounded rect: a = top-left / bottom-right radius, b = top-right / bottom-left (the 24/4 ledge). */
function arect(x: number, y: number, w: number, h: number, a: number, b: number): string {
  return `M${x + a},${y}H${x + w - b}A${b},${b} 0 0 1 ${x + w},${y + b}V${y + h - a}A${a},${a} 0 0 1 ${x + w - a},${y + h}H${x + b}A${b},${b} 0 0 1 ${x},${y + h - b}V${y + a}A${a},${a} 0 0 1 ${x + a},${y}Z`;
}

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, px: number): number {
  if (measureCtx === undefined && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * px * 0.58;
  measureCtx.font = `500 ${px}px "Clash Display", system-ui, sans-serif`;
  return measureCtx.measureText(text).width;
}

function geometry(width: number, lines: PourLine[], measured: boolean): Geo {
  const W = Math.max(300, Math.round(width));
  const m = W < 520;
  const H = m ? Math.round(W * 0.86) : Math.round(Math.min(W * 0.98, 590));
  const pad = m ? 11 : 15;
  let fs = m ? 11.5 : 15;
  const tagFor = (size: number) =>
    Math.max(...lines.map((l) => (measured ? textWidth(l.name, size) : l.name.length * size * 0.58))) +
    (measured ? textWidth("100%", size) : size * 2.4) +
    pad * 2 +
    (m ? 10 : 16);
  let tagW = tagFor(fs);
  const maxTag = W * (m ? 0.52 : 0.46);
  if (tagW > maxTag) {
    fs = Math.max(10, (fs * maxTag) / tagW);
    tagW = tagFor(fs);
  }
  tagW = Math.ceil(Math.max(m ? 120 : 160, tagW));
  const g = {
    W,
    H,
    m,
    vw: m ? 62 : 118,
    tagW,
    tagH: m ? 30 : 38,
    cap: m ? 14 : 24,
    gapS: m ? 5 : 7,
    gapD: m ? 15 : 28,
    top: m ? 34 : 58,
    bot: H - (m ? 10 : 16),
    sh: m ? 4 : 6,
    k: m ? 0.66 : 0.6,
    dTop: m ? 28 : 40,
    dBot: m ? 6 : 8,
    fs,
    pad,
  };
  const xEnd = W - g.tagW - (m ? 4 : 6);
  const dx = xEnd - g.cap - (m ? 6 : 10);
  const x0 = g.vw - 6;
  return {
    ...g,
    xEnd,
    dx,
    x0,
    mx: (x0 + dx) / 2,
    avail: g.H - g.dTop - g.dBot - g.gapD * Math.max(0, lines.length - 1),
  };
}

function lanes(G: Geo, shares: number[]): Lane[] {
  const n = shares.length;
  const tot = shares.reduce((a, b) => a + b, 0);
  const norm = tot > 0 ? shares : shares.map(() => 1);
  const total = tot > 0 ? tot : n;
  const sTot = G.avail * G.k + G.gapS * (n - 1);
  const mid = G.top + (G.bot - G.top) * (G.m ? 0.6 : 0.58);
  let sy = mid - sTot / 2;
  let dy = G.dTop;
  return norm.map((s) => {
    const t = (G.avail * s) / total;
    const ts = t * G.k;
    const o = { s0: sy, s1: sy + ts, d0: dy, d1: dy + t };
    sy += ts + G.gapS;
    dy += t + G.gapD;
    return o;
  });
}

function ribbon(G: Geo, o: Lane): string {
  const { x0, dx, mx, cap } = G;
  const r = Math.max(0, Math.min(12, (o.d1 - o.d0) / 2));
  return `M${x0},${o.s0}C${mx},${o.s0} ${mx},${o.d0} ${dx},${o.d0}H${dx + cap - r}A${r},${r} 0 0 1 ${dx + cap},${o.d0 + r}V${o.d1 - r}A${r},${r} 0 0 1 ${dx + cap - r},${o.d1}H${dx}C${mx},${o.d1} ${mx},${o.s1} ${x0},${o.s1}Z`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Pour({
  lines,
  annotation: annotations,
  label,
}: {
  lines: PourLine[];
  /** What the lane width means, in a long (desktop) and short (phone) form. */
  annotation: { long: string; short: string };
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<SVGTextElement>(null);
  const coinRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [width, setWidth] = useState(560);
  const [measured, setMeasured] = useState(false);
  const [annW, setAnnW] = useState<number | null>(null);

  const targetKey = lines.map((l) => `${l.id}:${l.share.toFixed(2)}`).join("|");
  const target = useMemo(() => lines.map((l) => l.share), [lines]);
  const [shown, setShown] = useState<number[]>(() => lines.map((l) => l.prevShare ?? l.share));
  const shownRef = useRef(shown);
  useIsoLayoutEffect(() => {
    shownRef.current = shown;
  });

  // Width from the layout; rebuilt on resize.
  useIsoLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setWidth(host.clientWidth);
    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Tag widths need the label face loaded before measuring.
  useEffect(() => {
    let alive = true;
    const done = () => alive && setMeasured(true);
    if (document.fonts?.load) {
      document.fonts.load('500 15px "Clash Display"').then(done, done);
    } else done();
    return () => {
      alive = false;
    };
  }, []);

  // Tween the lanes from what is shown to the target split (once on load, again when live data lands).
  useEffect(() => {
    const from = shownRef.current;
    if (from.length !== target.length || prefersReducedMotion()) {
      setShown(target);
      return;
    }
    if (from.every((v, i) => Math.abs(v - target[i]!) < 0.01)) return;
    let raf = 0;
    const t0 = performance.now();
    const delay = 500;
    const step = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - t0 - delay) / 1500));
      const k = easeOut(p);
      setShown(from.map((f, i) => f + (target[i]! - f) * k));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key captures every change of the target
  }, [targetKey]);

  const G = useMemo(() => geometry(width, lines, measured), [width, lines, measured]);
  const annotation = G.m ? annotations.short : annotations.long;
  const gm = useMemo(() => lanes(G, shown.length === lines.length ? shown : target), [G, shown, lines.length, target]);

  useIsoLayoutEffect(() => {
    const t = annRef.current;
    if (!t) return;
    try {
      setAnnW(t.getComputedTextLength());
    } catch {
      setAnnW(null);
    }
  }, [annotation, G.m, measured]);

  // The idle loop: coins ride each lane from the vault to the line.
  const loop = useRef({ G, gm });
  useIsoLayoutEffect(() => {
    loop.current = { G, gm };
  });
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const host = hostRef.current;
    let raf = 0;
    let visible = true;
    const t0 = performance.now();
    const frame = (now: number) => {
      const { G: g, gm: lanesNow } = loop.current;
      const e = now - t0;
      coinRefs.current.forEach((c, idx) => {
        if (!c) return;
        const i = Math.floor(idx / 2);
        const o = lanesNow[i];
        if (!o) return;
        const dur = 6200 + i * 900;
        const u = (e / dur + (idx % 2) * 0.5) % 1;
        const sc = (o.s0 + o.s1) / 2;
        const dc = (o.d0 + o.d1) / 2;
        let x: number;
        let y: number;
        if (u < 0.9) {
          const t = u / 0.9;
          const a = 1 - t;
          const P0 = g.x0 + 10;
          x = a * a * a * P0 + 3 * a * a * t * g.mx + 3 * a * t * t * g.mx + t * t * t * g.dx;
          y = a * a * a * sc + 3 * a * a * t * sc + 3 * a * t * t * dc + t * t * t * dc;
        } else {
          x = g.dx + ((u - 0.9) / 0.1) * (g.cap - 8);
          y = dc;
        }
        const thin = o.d1 - o.d0 < 10;
        const op = thin ? 0 : u < 0.06 ? u / 0.06 : u > 0.94 ? (1 - u) / 0.06 : 1;
        c.setAttribute("cx", x.toFixed(1));
        c.setAttribute("cy", y.toFixed(1));
        c.setAttribute("opacity", op.toFixed(2));
      });
      raf = visible ? requestAnimationFrame(frame) : 0;
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((en) => en.isIntersecting);
      if (visible && !raf) raf = requestAnimationFrame(frame);
    });
    if (host) io.observe(host);
    raf = requestAnimationFrame(frame);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const vh = G.bot - G.top;
  const vp = arect(0, G.top, G.vw, vh, G.m ? 18 : 24, 5);
  const ly = G.top + vh * 0.4;
  let wave = `M0,${G.bot} V${ly}`;
  for (let x = 0, k = 0; x < G.vw; x += 14, k++) wave += ` Q${x + 7},${ly + (k % 2 ? 3 : -3)} ${x + 14},${ly}`;
  wave += ` V${G.bot} Z`;
  const ticks: { y: number; w: number }[] = [];
  for (let i = 1; i < 7; i++) {
    const y = G.top + vh * (0.4 + i * 0.085);
    if (y < G.bot - 10) ticks.push({ y, w: i % 2 ? 8 : 14 });
  }

  // Hand-drawn hook from the annotation to the top lane.
  const first = gm[0];
  const arrow = (() => {
    if (!first) return null;
    const w = annW ?? annotation.length * (G.m ? 6.2 : 7.2);
    const y = (first.s0 + first.d0) / 2;
    const x = G.mx + (G.m ? 10 : 18);
    const sx = Math.min(w + 8, G.xEnd - 30);
    const sy = G.m ? 9 : 13;
    return {
      line: `M${sx},${sy} C${sx + 34},${sy - 2} ${x + 14},${y - 34} ${x},${y - 8}`,
      head: `M${x - 6},${y - 15} L${x},${y - 7} L${x + 7},${y - 13}`,
    };
  })();

  const clipId = "pour-vault-clip";

  return (
    <div ref={hostRef} className={styles.host} role="img" aria-label={label}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${G.W} ${G.H}`}
        width={G.W}
        height={G.H}
        aria-hidden="true"
        style={{ "--pour-fs": `${G.fs}px` } as CSSProperties}
      >
        <g>
          {gm.map((o, i) => (
            <path key={`s${lines[i]!.id}`} d={ribbon(G, o)} className={styles.kf} transform={`translate(0 ${G.sh})`} />
          ))}
        </g>
        <g>
          {gm.map((o, i) => (
            <path
              key={`r${lines[i]!.id}`}
              d={ribbon(G, o)}
              className={styles.k}
              style={{ fill: lines[i]!.color }}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ))}
        </g>
        <g>
          {lines.flatMap((l, i) =>
            [0, 1].map((ph) => (
              <circle
                key={`c${l.id}-${ph}`}
                ref={(el) => {
                  coinRefs.current[i * 2 + ph] = el;
                }}
                r={G.m ? 4 : 5.5}
                className={`${styles.gf} ${styles.k}`}
                strokeWidth={1.5}
                opacity={0}
              />
            )),
          )}
        </g>
        <g>
          <path d={vp} className={styles.kf} transform={`translate(0 ${G.sh})`} />
          <path d={vp} className={`${styles.cf} ${styles.k}`} strokeWidth={2} />
          <clipPath id={clipId}>
            <path d={vp} />
          </clipPath>
          <path d={wave} className={styles.liq} clipPath={`url(#${clipId})`} />
          {ticks.map((t) => (
            <path
              key={t.y}
              d={`M8,${t.y} h${t.w}`}
              className={styles.k}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
          <text x={G.vw / 2} y={G.top + (G.m ? 26 : 42)} textAnchor="middle" className={styles.vt} fontSize={G.m ? 17 : 27}>
            Vault
          </text>
          <text x={G.vw / 2} y={G.top + (G.m ? 42 : 64)} textAnchor="middle" className={styles.vs} fontSize={G.m ? 10 : 12.5}>
            lenders&apos;
          </text>
          <text x={G.vw / 2} y={G.top + (G.m ? 54 : 80)} textAnchor="middle" className={styles.vs} fontSize={G.m ? 10 : 12.5}>
            MUSD
          </text>
        </g>
        <g>
          {gm.map((o, i) => {
            const l = lines[i]!;
            const ty = (o.d0 + o.d1) / 2 - G.tagH / 2;
            const base = G.tagH / 2 + G.fs * 0.36;
            return (
              <g key={`t${l.id}`} transform={`translate(${G.xEnd + (G.m ? 4 : 6)} ${ty})`}>
                <rect x={0} y={3} width={G.tagW} height={G.tagH} rx={G.tagH / 2} className={styles.kf} />
                <rect x={0} y={0} width={G.tagW} height={G.tagH} rx={G.tagH / 2} className={`${styles.gf} ${styles.k}`} strokeWidth={1.5} />
                <text x={G.pad} y={base} className={styles.tg} fontSize={G.fs}>
                  {l.name}
                </text>
                <text x={G.tagW - G.pad} y={base} textAnchor="end" className={styles.tg} fontSize={G.fs}>
                  {Math.round(shown[i] ?? l.share)}%
                </text>
              </g>
            );
          })}
        </g>
        <g>
          <text ref={annRef} x={0} y={G.m ? 13 : 18} className={styles.an} fontSize={G.m ? 11.5 : 13.5}>
            {annotation}
          </text>
          {arrow ? (
            <>
              <path className={styles.arrow} d={arrow.line} />
              <path className={styles.arrow} d={arrow.head} />
            </>
          ) : null}
        </g>
      </svg>
    </div>
  );
}
