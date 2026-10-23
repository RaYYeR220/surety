// Typefaces for the current skin. tokens.css maps these four CSS variables onto
// --font-display / --font-label / --font-body / --font-mono; components only use the latter.
// To swap a face, change it here (any next/font/google or next/font/local font) and keep the variable name.
import { Bricolage_Grotesque, Figtree, Fraunces, JetBrains_Mono } from "next/font/google";

// Stand-in for Gambetta 600 (display).
const display = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-display-face",
  display: "swap",
});

// Stand-in for Clash Display 500 (labels and buttons).
const label = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-label-face",
  display: "swap",
});

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

/** Class names that define the four font-face variables; put on <html>. */
export const fontVariables = [display.variable, label.variable, body.variable, mono.variable].join(" ");
