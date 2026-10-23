"use client";

import { useEffect } from "react";

import s from "./Landing.module.css";

/**
 * Scroll reveal for the landing's `.io` blocks: each rises once when it enters the viewport. The head script
 * marks <html data-reveal> before paint; a CSS failsafe shows every block at 3.5 s even if this never runs.
 */
export function Reveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(`.${s.io}`));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.setAttribute("data-in", ""));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          en.target.setAttribute("data-in", "");
          io.unobserve(en.target);
        }),
      { rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
