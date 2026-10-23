import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Floor } from "@/components/shell/Floor";
import { themeInitScript } from "@/components/shell/themeScript";
import { FONTSHARE_CSS, fontVariables } from "@/theme/fonts";

import "@/theme/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Surety · Bitcoin decides where MUSD credit goes",
    template: "%s · Surety",
  },
  description:
    "Lend MUSD on Mezo. veBTC holders vote where it is lent, and their rewards take the first loss if they are wrong. Borrow against your veBTC without unlocking it.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#111210" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />
        {/* Gambetta + Clash Display from Fontshare; their licence keeps the files out of the repository. */}
        <link rel="stylesheet" href={FONTSHARE_CSS} />
      </head>
      <body>
        <Floor />
        {children}
      </body>
    </html>
  );
}
