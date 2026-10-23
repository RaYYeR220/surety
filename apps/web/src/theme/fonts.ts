// Typefaces for the current skin. tokens.css maps the faces onto --font-display / --font-label /
// --font-body / --font-mono; components only use those four.
//
// Display (Gambetta) and labels (Clash Display) come from Fontshare's CSS API, linked in the root layout
// with FONTSHARE_CSS. Their licence (ITF FFL) forbids redistributing the font files through a repository,
// so the files are never downloaded into the project. Body (Figtree) and numbers (JetBrains Mono) are OFL
// faces self-hosted through next/font.
import { Figtree, JetBrains_Mono } from "next/font/google";

/** Fontshare stylesheet: Gambetta 600 and 600 italic (display), Clash Display 500 (labels, buttons). */
export const FONTSHARE_CSS =
  "https://api.fontshare.com/v2/css?f[]=gambetta@600,600i&f[]=clash-display@500&display=swap";

const body = Figtree({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-body-face",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-mono-face",
  display: "swap",
});

/** Class names that define the next/font face variables; put on <html>. */
export const fontVariables = [body.variable, mono.variable].join(" ");
