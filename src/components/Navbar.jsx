"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { getLenis } from "@/components/SmoothScroll";

export const NAV_MENU = {
  image: {
    label: "Image",
    subnavs: [
      {
        id: "optimizer",
        href: "/",
        label: "Image Optimizer",
        short: "Bulk compress, resize & convert",
      },
      {
        id: "upscale",
        href: "/upscale",
        label: "Image Upscale",
        short: "2× & 4× detail-reviving super-resolution",
      },
      {
        id: "bgremove",
        href: "/bg-remover",
        label: "BG Remover",
        short: "Offline AI cutout & studio key",
      },
      {
        id: "passport",
        href: "/passport",
        label: "Passport Image",
        short: "3.5×4.5cm & 2×2.5cm print sheets + AI BG",
      },
    ],
  },
  video: {
    label: "Video",
    subnavs: [
      {
        id: "video-optimizer",
        href: "/video-optimizer",
        label: "Video Optimizer",
        short: "Web, 4K, 2K & social presets",
      },
      {
        id: "whatsapp-status",
        href: "/whatsapp-status",
        label: "WhatsApp Status",
        short: "Split & shrink into 30s Status clips",
      },
    ],
  },
};

export function resolveNavFromPathname(pathname) {
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  for (const [sectionKey, group] of Object.entries(NAV_MENU)) {
    for (const sub of group.subnavs) {
      if (sub.href === clean) {
        return { navSection: sectionKey, activeSubnav: sub.id };
      }
    }
  }
  return { navSection: "image", activeSubnav: "optimizer" };
}

const Navbar = memo(function Navbar() {
  const pathname = usePathname();
  const { navSection, activeSubnav } = resolveNavFromPathname(pathname);

  const [markActive, setMarkActive] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navRef = useRef(null);
  const mobileDrawerRef = useRef(null);
  const mobileItemsRef = useRef(null);

  // Close menus on route change
  useEffect(() => {
    setOpenMenu(null);
    setMobileOpen(false);
  }, [pathname]);

  // Close desktop dropdown when clicking outside or pressing Escape
  useEffect(() => {
    const onDocClick = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        setOpenMenu(null);
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Classic GSAP slide-down & staggered reveal for Mobile Hamburger Menu
  useEffect(() => {
    const drawer = mobileDrawerRef.current;
    const itemsWrap = mobileItemsRef.current;
    if (!drawer) return;

    gsap.killTweensOf(drawer);
    const items = itemsWrap
      ? itemsWrap.querySelectorAll("[data-mobile-link]")
      : [];
    if (items.length) gsap.killTweensOf(items);

    if (mobileOpen) {
      gsap.set(drawer, { display: "block" });
      gsap.fromTo(
        drawer,
        { height: 0, opacity: 0 },
        {
          height: "auto",
          opacity: 1,
          duration: 0.35,
          ease: "expo.out",
        }
      );
      if (items.length) {
        gsap.fromTo(
          items,
          { y: -10, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.3,
            stagger: 0.04,
            ease: "power3.out",
            delay: 0.05,
          }
        );
      }
    } else {
      gsap.to(drawer, {
        height: 0,
        opacity: 0,
        duration: 0.22,
        ease: "power3.inOut",
        onComplete: () => gsap.set(drawer, { display: "none" }),
      });
    }
  }, [mobileOpen]);

  const handleLogoClick = (e) => {
    if (pathname === "/") {
      e.preventDefault();
      const lenis = getLenis();
      if (lenis) lenis.scrollTo(0, { duration: 1.2 });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <header
      ref={navRef}
      className="relative z-40 border-b-[3px] border-neutral-900 bg-white"
    >
      <div className="mx-auto flex w-full max-w-[1760px] items-center justify-between gap-4 px-4 py-4 sm:px-6 sm:py-5 lg:px-10 2xl:px-14">
        {/* Exact Original PixShrink Pixel-P SVG Logo & Wordmark */}
        <Link
          href="/"
          onClick={handleLogoClick}
          onPointerEnter={() => setMarkActive(true)}
          onPointerLeave={() => setMarkActive(false)}
          onFocus={() => setMarkActive(true)}
          onBlur={() => setMarkActive(false)}
          aria-label="PixShrink, back to top"
          className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/30 focus-visible:ring-offset-4 focus-visible:ring-offset-white"
        >
          <svg
            className="h-[1.85rem] w-[1.85rem] shrink-0 overflow-visible"
            viewBox="0 0 100 100"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <rect x="25" y="25" width="70" height="70" fill="#111111" />
            <g
              className={`transition-transform duration-200 ease-out ${
                markActive ? "-translate-y-2.5 translate-x-1.5" : ""
              }`}
            >
              <rect
                x="5"
                y="5"
                width="70"
                height="70"
                fill="#ffffff"
                stroke="#111111"
                strokeWidth="6"
                strokeLinejoin="miter"
              />
              <rect x="15" y="15" width="22" height="22" fill="#111111" />
              <rect
                x="15"
                y="43"
                width="22"
                height="22"
                fill="var(--accent)"
                stroke="#111111"
                strokeWidth="4"
                strokeLinejoin="miter"
              />
              <rect
                x="43"
                y="15"
                width="22"
                height="22"
                fill="var(--accent)"
                stroke="#111111"
                strokeWidth="4"
                strokeLinejoin="miter"
              />
            </g>
          </svg>
          <span className="font-[family-name:var(--font-pixel)] text-[1.55rem] font-semibold leading-none tracking-tight text-neutral-900 sm:text-[1.7rem]">
            PixShrink
          </span>
        </Link>

        {/* Desktop Primary Navigation ("Image" & "Video" Dropdowns — Exact v2 Style) */}
        <nav
          aria-label="Main navigation"
          className="hidden items-center gap-3 sm:flex"
        >
          {Object.entries(NAV_MENU).map(([sectionKey, group]) => {
            const isSectionActive = navSection === sectionKey;
            const isMenuOpen = openMenu === sectionKey;
            return (
              <div
                key={sectionKey}
                className="relative"
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") setOpenMenu(sectionKey);
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === "mouse") setOpenMenu(null);
                }}
              >
                <button
                  type="button"
                  aria-expanded={isMenuOpen}
                  onClick={() =>
                    setOpenMenu((prev) =>
                      prev === sectionKey ? null : sectionKey
                    )
                  }
                  className={`flex cursor-pointer items-center gap-2 rounded-none border-[3px] border-neutral-900 px-4 py-2 text-xs font-black uppercase tracking-widest transition-all focus:outline-none ${
                    isSectionActive
                      ? "bg-[var(--accent)] text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                      : "bg-white text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)] hover:bg-neutral-100"
                  }`}
                >
                  <span>{group.label}</span>
                  <svg
                    className={`h-3.5 w-3.5 transition-transform duration-150 ${
                      isMenuOpen ? "rotate-180" : ""
                    }`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <path strokeLinecap="square" d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {isMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-50 w-64 pt-2"
                  >
                    <div className="border-[3px] border-neutral-900 bg-white shadow-[6px_6px_0_rgba(17,17,17,1)]">
                      {group.subnavs.map((sub, idx) => {
                        const subActive = activeSubnav === sub.id;
                        return (
                          <Link
                            key={sub.id}
                            href={sub.href}
                            role="menuitem"
                            onClick={() => setOpenMenu(null)}
                            className={`flex w-full cursor-pointer flex-col items-start px-4 py-3 text-left transition-colors ${
                              idx !== 0
                                ? "border-t-[2px] border-neutral-900"
                                : ""
                            } ${
                              subActive
                                ? "bg-neutral-900 text-[var(--accent)]"
                                : "bg-white text-neutral-900 hover:bg-[#FFE600]"
                            }`}
                          >
                            <span className="flex w-full items-center justify-between text-xs font-black uppercase tracking-wider">
                              <span>{sub.label}</span>
                              {subActive && (
                                <span className="h-2 w-2 bg-[var(--accent)]" />
                              )}
                            </span>
                            <span
                              className={`mt-0.5 font-mono text-[10px] font-bold ${
                                subActive ? "text-white/80" : "text-neutral-500"
                              }`}
                            >
                              {sub.short}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Mobile Only: Hamburger Icon Button (No Option Pill) */}
        <button
          type="button"
          aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className={`flex h-10 w-10 cursor-pointer flex-col items-center justify-center rounded-none border-[3px] border-neutral-900 transition-colors focus:outline-none sm:hidden ${
            mobileOpen
              ? "bg-[var(--accent)] text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
              : "bg-white text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
          }`}
        >
          <span
            className={`block h-[2.5px] w-5 bg-neutral-900 transition-transform duration-300 ease-out ${
              mobileOpen ? "translate-y-[6.5px] rotate-45" : ""
            }`}
          />
          <span
            className={`my-[4px] block h-[2.5px] w-5 bg-neutral-900 transition-all duration-200 ease-out ${
              mobileOpen ? "scale-x-0 opacity-0" : "scale-x-100 opacity-100"
            }`}
          />
          <span
            className={`block h-[2.5px] w-5 bg-neutral-900 transition-transform duration-300 ease-out ${
              mobileOpen ? "-translate-y-[6.5px] -rotate-45" : ""
            }`}
          />
        </button>
      </div>

      {/* Mobile NavMenu Drawer (Appears on Hamburger Click with Classic Animation) */}
      <div
        ref={mobileDrawerRef}
        style={{ display: "none" }}
        className="overflow-hidden border-t-[3px] border-neutral-900 bg-white sm:hidden"
      >
        <div ref={mobileItemsRef} className="divide-y-[2px] divide-neutral-900">
          {Object.entries(NAV_MENU).map(([sectionKey, group]) => (
            <div key={sectionKey} className="p-4">
              <div className="mb-2.5 font-mono text-[10px] font-black uppercase tracking-widest text-neutral-400">
                {group.label}
              </div>
              <div className="flex flex-col border-[3px] border-neutral-900 bg-white shadow-[4px_4px_0_rgba(17,17,17,1)]">
                {group.subnavs.map((sub, idx) => {
                  const subActive = activeSubnav === sub.id;
                  return (
                    <Link
                      key={sub.id}
                      href={sub.href}
                      data-mobile-link
                      onClick={() => setMobileOpen(false)}
                      className={`flex w-full flex-col items-start px-4 py-3 text-left transition-colors ${
                        idx !== 0 ? "border-t-[2px] border-neutral-900" : ""
                      } ${
                        subActive
                          ? "bg-neutral-900 text-[var(--accent)]"
                          : "bg-white text-neutral-900 active:bg-[#FFE600]"
                      }`}
                    >
                      <span className="flex w-full items-center justify-between text-xs font-black uppercase tracking-wider">
                        <span>{sub.label}</span>
                        {subActive && (
                          <span className="h-2 w-2 bg-[var(--accent)]" />
                        )}
                      </span>
                      <span
                        className={`mt-0.5 font-mono text-[10px] font-bold ${
                          subActive ? "text-white/80" : "text-neutral-500"
                        }`}
                      >
                        {sub.short}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
});

export default Navbar;
