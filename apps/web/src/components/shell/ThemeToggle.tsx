"use client";

import { useEffect, useState } from "react";

import styles from "./Shell.module.css";
import { THEME_KEY } from "./themeScript";

/** "Lights" switch: light (cream + plum) or dark (near-black + lime). */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);

  const toggle = () => {
    const next = !(document.documentElement.dataset.theme === "dark");
    document.documentElement.dataset.theme = next ? "dark" : "light";
    setDark(next);
    try {
      window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={dark ?? false}
      aria-label="Lights: switch between light and dark"
      onClick={toggle}
    >
      <span className={styles.toggleLabel}>Lights</span>
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
