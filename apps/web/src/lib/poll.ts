"use client";

import { useEffect, useRef } from "react";

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Runs `callback` every `ms` while the tab is visible: right away on mount (unless `immediate` is false), then on an
 * interval that skips hidden tabs, and again on return to the tab when the last run is older than `ms`.
 * `key` restarts the loop (for example the chain id).
 */
export function useVisiblePoll(
  callback: () => void | Promise<void>,
  ms: number,
  options: { key?: unknown; immediate?: boolean; enabled?: boolean } = {},
): void {
  const { key, immediate = true, enabled = true } = options;
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const run = () => {
      last = Date.now();
      void saved.current();
    };
    if (immediate && isVisible()) run();
    const id = window.setInterval(() => {
      if (isVisible() && Date.now() - last >= ms - 50) run();
    }, ms);
    const onVisible = () => {
      if (isVisible() && Date.now() - last >= ms) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, key, immediate, enabled]);
}
