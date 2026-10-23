"use client";

import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { useSuretyOptional } from "@/lib/env";

/** Appends the example-mode query to an internal href while example mode is on. */
export function useAppHref(href: string): string {
  const demo = useSuretyOptional()?.demo;
  if (!demo || !href.startsWith("/")) return href;
  const [path, hash] = href.split("#");
  const sep = path!.includes("?") ? "&" : "?";
  return `${path}${sep}demo=${demo === "default" ? "1" : demo}${hash ? `#${hash}` : ""}`;
}

/** next/link that keeps example mode (?demo=1) across pages. */
export function AppLink({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const to = useAppHref(href);
  return (
    <Link href={to} {...rest}>
      {children}
    </Link>
  );
}
