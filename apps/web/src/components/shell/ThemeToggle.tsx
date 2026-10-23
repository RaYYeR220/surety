"use client";

import { useSyncExternalStore } from "react";

import styles from "./Shell.module.css";
import { THEME_KEY } from "./themeScript";

/** The theme lives on <html data-theme>; watch that attribute. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.dataset.theme === "dark";

/** "Lights" switch: light (cream + plum) or dark (near-black + lime). */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  const toggle = () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the switch still works for this visit */
    }
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={dark}
      aria-label="Lights: switch between light and dark"
      onClick={toggle}
    >
      <span className={styles.toggleLabel}>Lights</span>
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
