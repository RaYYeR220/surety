// The app's navigation: the four pages people use most, a "More" menu for the rest, and the testnet try-out.
export interface NavItem {
  href: string;
  label: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: "/app", label: "Board" },
  { href: "/app/vote", label: "Vote" },
  { href: "/app/lend", label: "Lend" },
  { href: "/app/borrow", label: "Borrow" },
];

export const MORE_NAV: NavItem[] = [
  { href: "/app/market", label: "Share market" },
  { href: "/app/auctions", label: "Auctions" },
  { href: "/app/sponsor", label: "Sponsor" },
  { href: "/app/peg", label: "Peg" },
  { href: "/app/ledger", label: "Users" },
  { href: "/app/proof", label: "Proof" },
  { href: "/app/business", label: "Business" },
  { href: "/app/review", label: "Review in 5 minutes" },
];

export const TRY_NAV: NavItem = { href: "/app/try", label: "Try it" };

/** Keeps the items whose page exists in this build (all of them when `routes` is null). */
export function present(items: NavItem[], routes: string[] | null): NavItem[] {
  return routes ? items.filter((i) => routes.includes(i.href)) : items;
}

export function normalisePath(path: string | null): string {
  if (!path) return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
