"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import gsap from "gsap";
import { isMobileDevice, prefersReducedMotion } from "@/lib/device";

// Lets any component talk to the scroller later, without prop drilling:
//   import { getLenis } from "@/components/SmoothScroll";
//   getLenis()?.scrollTo("#results", { offset: -24 });
let instance = null;
export const getLenis = () => instance;

// Modals in this app lock the page by setting overflow: hidden on <body>.
// Lenis scrolls programmatically, which ignores overflow: hidden, so we pause it ourselves.
const isScrollLocked = () =>
  document.body.style.overflow === "hidden" ||
  document.documentElement.style.overflow === "hidden";

export default function SmoothScroll({ children }) {
  useEffect(() => {
    // Phones use native touch scrolling anyway (syncTouch is off), so skip creating Lenis
    // and running a continuous 60/120fps requestAnimationFrame loop on mobile devices.
    if (isMobileDevice() || prefersReducedMotion()) return;

    const lenis = new Lenis({
      // GSAP's ticker drives Lenis, so the whole page runs on ONE animation loop.
      autoRaf: false,
      lerp: 0.1, // 0.08 = floatier, 0.12 = snappier
      smoothWheel: true,
      // ImageDropzone already uses `data-lenis-prevent`, so nested scroll polling is unnecessary.
      allowNestedScroll: false,
    });
    instance = lenis;

    const tick = (time) => lenis.raf(time * 1000); // GSAP time is in seconds, Lenis wants ms
    gsap.ticker.add(tick);

    // Pause Lenis while a modal holds the scroll lock, resume when it lets go.
    let locked = false;
    const syncLock = () => {
      const next = isScrollLocked();
      if (next === locked) return;
      locked = next;
      if (next) lenis.stop();
      else lenis.start();
    };
    syncLock();

    const observer = new MutationObserver(syncLock);
    const watch = { attributes: true, attributeFilter: ["style"] };
    observer.observe(document.body, watch);
    observer.observe(document.documentElement, watch);

    return () => {
      observer.disconnect();
      gsap.ticker.remove(tick);
      lenis.destroy();
      instance = null;
    };
  }, []);

  return <>{children}</>;
}