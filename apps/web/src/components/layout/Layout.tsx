import type { CSSProperties, ElementType, ReactNode } from "react";

import styles from "./Layout.module.css";

type Space = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const space = (n: Space | undefined) => (n === undefined ? undefined : `var(--space-${n})`);

interface Base {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  id?: string;
}

function vars(v: Record<string, string | undefined>, style?: CSSProperties): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = val;
  return { ...out, ...style } as CSSProperties;
}

function cx(...parts: (string | undefined | false)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Stack({
  as: As = "div",
  gap,
  className,
  children,
  id,
  label,
}: Base & { gap?: Space; /** aria-label, for sections. */ label?: string }) {
  return (
    <As id={id} aria-label={label} className={cx(styles.stack, className)} style={vars({ "--gap": space(gap) })}>
      {children}
    </As>
  );
}

export function Cluster({
  as: As = "div",
  gap,
  align,
  justify,
  className,
  children,
  id,
}: Base & { gap?: Space; align?: CSSProperties["alignItems"]; justify?: CSSProperties["justifyContent"] }) {
  return (
    <As
      id={id}
      className={cx(styles.cluster, className)}
      style={vars({ "--gap": space(gap), "--align": align as string | undefined, "--justify": justify as string | undefined })}
    >
      {children}
    </As>
  );
}

export function Grid({ as: As = "div", gap, min, className, children, id }: Base & { gap?: Space; min?: string }) {
  return (
    <As id={id} className={cx(styles.grid, className)} style={vars({ "--gap": space(gap), "--min": min })}>
      {children}
    </As>
  );
}

export function Split({
  as: As = "div",
  gap,
  main,
  side,
  className,
  children,
}: Base & { gap?: Space; main?: string; side?: string }) {
  return (
    <As className={cx(styles.split, className)} style={vars({ "--gap": space(gap), "--main": main, "--side": side })}>
      {children}
    </As>
  );
}

export function Container({ as: As = "div", className, children, id }: Base) {
  return (
    <As id={id} className={cx(styles.container, className)}>
      {children}
    </As>
  );
}
