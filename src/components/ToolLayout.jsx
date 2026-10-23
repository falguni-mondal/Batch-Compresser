"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import Navbar from "@/components/Navbar";
import DonateCard from "@/components/DonateCard";
import WelcomeModal from "@/components/WelcomeModal";
import { PixelStyles } from "@/components/PixelLoader";

export const HERO_CONTENT = {
  optimizer: {
    badge: "Runs in your browser",
    line1: "Shrink images in bulk.",
    line2: "Keep them on your device.",
    desc: "Compress, resize and convert images right in your browser. Nothing is uploaded, and the only limit is your own device.",
  },
  upscale: {
    badge: "Detail-Reviving Super-Resolution",
    line1: "Upscale & revive details.",
    line2: "Crystal clear in 2× or 4×.",
    desc: "Reconstruct crisp edges, fine textures, and micro-contrast locally with shock-filtered super-resolution and Swin2SR AI.",
  },
  bgremove: {
    badge: "ISNet 1024px Offline AI",
    line1: "Remove backgrounds.",
    line2: "AI cutouts in your browser.",
    desc: "Separate portraits, fine hair strands, products, and objects with the 1024px ISNet-ONNX neural model right in your browser.",
  },
  passport: {
    badge: "300 DPI Passport & Stamp Studio",
    line1: "Passport & Stamp photos.",
    line2: "AI backdrop & print sheets.",
    desc: "Create 3.5×4.5 cm Passport (up to 8 per page) or 2.0×2.5 cm Stamp (up to 9 per page) sheets on 6×4\", A4, or Single Soft Copy.",
  },
  "video-optimizer": {
    badge: "Local Video Transcoder",
    line1: "Shrink & convert video.",
    line2: "Up to 4K, 2K & Web ready.",
    desc: "Compress video size, scale for Web, 4K, 2K, YouTube, Instagram, or Facebook, and convert between MP4 and WebM on your device.",
  },
  "whatsapp-status": {
    badge: "WhatsApp Status Splitter",
    line1: "Split & shrink for Status.",
    line2: "Auto-cut into 30s clips.",
    desc: "Optimize long videos up to 15 minutes into sequential 30-second or 60-second HD Status clips ready to share.",
  },
};

const PAGE_CSS = `
.ps-reveal,.ps-word{opacity:0;animation:ps-failsafe 0s linear 3.5s forwards}
.ps-word{display:inline-block;will-change:transform}
.ps-mask{display:inline-block;overflow:hidden;vertical-align:top;padding:.1em 0 .16em;margin:-.1em 0 -.16em}
@keyframes ps-failsafe{to{opacity:1}}
.ps-blink{animation:ps-blink 1.4s steps(1,end) infinite}
@keyframes ps-blink{0%,55%{opacity:1}56%,100%{opacity:.2}}
@media (prefers-reduced-motion:reduce){
  .ps-reveal,.ps-word{opacity:1;animation:none}
  .ps-blink{animation:none}
}
`;

export default function ToolLayout({ toolId = "optimizer", children }) {
  const pageRef = useRef(null);
  const activeHero = HERO_CONTENT[toolId] || HERO_CONTENT.optimizer;

  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const mm = gsap.matchMedia();

    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
      tl.fromTo(
        root.querySelectorAll("[data-reveal]"),
        { y: 22, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 1,
          stagger: 0.11,
          clearProps: "transform",
        },
        0.1
      );
    });

    mm.add("(prefers-reduced-motion: reduce)", () => {
      gsap.set(root.querySelectorAll("[data-reveal]"), {
        opacity: 1,
      });
    });

    return () => mm.revert();
  }, []);

  return (
    <main
      ref={pageRef}
      className="relative max-w-full flex-1 overflow-x-hidden font-[family-name:var(--font-geist-sans)] text-neutral-900"
    >
      <PixelStyles />
      <style>{PAGE_CSS}</style>
      <WelcomeModal />

      <Navbar />

      <div className="mx-auto flex w-full max-w-[1760px] flex-col gap-10 px-4 py-8 sm:px-6 sm:py-12 lg:flex-row lg:items-start lg:gap-16 lg:px-10 lg:py-20 2xl:gap-24 2xl:px-14">
        <aside className="flex w-full shrink-0 flex-col gap-8 lg:sticky lg:top-10 lg:w-[400px] xl:w-[460px]">
          <div>
            <div
              data-reveal
              className="ps-reveal mb-6 inline-flex items-center gap-2 rounded-none border-[2px] border-neutral-900 bg-white px-3 py-1 text-xs font-bold uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
            >
              <span
                aria-hidden="true"
                className="ps-blink h-2 w-2 rounded-full bg-[var(--accent)]"
              />
              {activeHero.badge}
            </div>

            <h1 className="break-words text-[clamp(2.25rem,5.5vw,4.5rem)] font-black leading-[0.95] tracking-[-0.03em] text-neutral-900">
              <span className="block">{activeHero.line1}</span>
              <span className="block text-neutral-400">{activeHero.line2}</span>
            </h1>

            <p
              data-reveal
              className="ps-reveal mt-5 max-w-[40ch] text-base font-medium leading-relaxed text-neutral-500 sm:mt-8 sm:text-lg"
            >
              {activeHero.desc}
            </p>
          </div>

          <div data-reveal className="ps-reveal mt-8 hidden w-full lg:block">
            <DonateCard />
          </div>
        </aside>

        <div className="min-w-0 w-full flex-1 lg:pt-4">
          {children}

          <div className="mt-14 w-full md:max-w-md lg:hidden">
            <DonateCard />
          </div>
        </div>
      </div>
    </main>
  );
}
