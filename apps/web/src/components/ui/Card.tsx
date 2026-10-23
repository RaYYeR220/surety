import type { CSSProperties, ElementType, ReactNode } from "react";

import styles from "./Card.module.css";

export type CardTone = "default" | "strong" | "accent" | "danger" | "warning" | "sunk";

export function Card({
  as: As = "section",
  title,
  eyebrow,
  description,
  actions,
  tone = "default",
  flat,
  className,
  id,
  children,
  headingLevel = 2,
  label,
  style,
}: {
  as?: ElementType;
  title?: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: CardTone;
  /** No padding (for tables that run edge to edge). */
  flat?: boolean;
  className?: string;
  id?: string;
  children?: ReactNode;
  headingLevel?: 2 | 3;
  label?: string;
  style?: CSSProperties;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const cls = [styles.card, tone !== "default" && styles[tone], flat && styles.flat, className]
    .filter(Boolean)
    .join(" ");
  const hasHeader = title || eyebrow || actions || description;
  return (
    <As className={cls} id={id} aria-label={label} style={style}>
      {hasHeader ? (
        <div className={styles.header}>
          <div className={styles.titles}>
            {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
            {title ? <H className={styles.title}>{title}</H> : null}
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </As>
  );
}
