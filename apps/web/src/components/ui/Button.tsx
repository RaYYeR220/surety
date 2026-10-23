import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { AppLink } from "@/components/shell/AppLink";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  children?: ReactNode;
}

function classes({ variant = "primary", size = "md", block }: Common, extra?: string) {
  return [styles.button, styles[variant], size !== "md" && styles[size], block && styles.block, extra]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant,
  size,
  block,
  loading,
  children,
  className,
  type = "button",
  disabled,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={classes({ variant, size, block }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** A link styled as a button. Internal hrefs keep example mode (the demo query parameter). */
export function ButtonLink({
  variant,
  size,
  block,
  children,
  href,
  external,
  className,
  ...rest
}: Common & { href: string; external?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = classes({ variant, size, block }, className);
  if (external) {
    return (
      <a href={href} className={cls} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <AppLink href={href} className={cls} {...rest}>
      {children}
    </AppLink>
  );
}
