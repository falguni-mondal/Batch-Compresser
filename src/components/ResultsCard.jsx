"use client";

import { memo, useEffect, useRef } from "react";
import gsap from "gsap";
import { getLenis } from "@/components/SmoothScroll";
import { isMobileDevice, prefersReducedMotion } from "@/lib/device";
import { formatBytes } from "@/components/StepHeader";

const unreadableMessage = (names) => {
  const many = names.length !== 1;
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${names.length} image${many ? "s" : ""} could not be read because the browser lost access to ${many ? "them" : "it"}: ${shown}${more}. Remove the red ${many ? "tiles" : "tile"} and add ${many ? "them" : "it"} again.`;
};

function ResultsCard({
  resultsReady,
  resultsCancelled,
  resultsFailed,
  originalSize,
  compressedSize,
  downloads,
  runInfo,
}) {
  const resultsRef = useRef(null);
  const errorRef = useRef(null);
  const newSizeRef = useRef(null);
  const savedRef = useRef(null);
  const barRef = useRef(null);

  const percentSaved =
    originalSize > 0
      ? Math.round(((originalSize - compressedSize) / originalSize) * 100)
      : 0;

  const formatSummary = Object.entries(runInfo.formats || {})
    .map(([f, n]) => `${n} ${f.toUpperCase()}`)
    .join(", ");

  const breakdown = [
    formatSummary && `Output: ${formatSummary}`,
    runInfo.local > 0 && `${runInfo.local} in your browser`,
    runInfo.kept > 0 && `${runInfo.kept} kept as original`,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    const root = resultsRef.current;
    if (!resultsReady || !root) return;

    const newEl = newSizeRef.current;
    const savedEl = savedRef.current;
    const bar = barRef.current;
    const ratio =
      originalSize > 0
        ? Math.min(1, Math.max(0, compressedSize / originalSize))
        : 0;
    const savedAbs = Math.abs(percentSaved);

    const writeFinal = () => {
      if (newEl) newEl.textContent = formatBytes(compressedSize);
      if (savedEl) savedEl.textContent = String(savedAbs);
    };

    let ctx;
    if (prefersReducedMotion()) {
      gsap.set(root, { opacity: 1 });
      if (bar) gsap.set(bar, { scaleX: ratio });
      writeFinal();
    } else {
      ctx = gsap.context(() => {
        const counter = { p: 0 };
        const timing = { duration: 1.4, delay: 0.25, ease: "power3.inOut" };

        gsap.fromTo(
          root,
          { y: 18, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.7,
            ease: "power3.out",
            clearProps: "transform",
          }
        );
        if (bar) gsap.fromTo(bar, { scaleX: 1 }, { scaleX: ratio, ...timing });
        gsap.to(counter, {
          p: 1,
          ...timing,
          onUpdate: () => {
            if (newEl) {
              newEl.textContent = formatBytes(
                Math.round(
                  originalSize + (compressedSize - originalSize) * counter.p
                )
              );
            }
            if (savedEl)
              savedEl.textContent = String(Math.round(savedAbs * counter.p));
          },
          onComplete: writeFinal,
        });
      }, root);
    }

    const rect = root.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      const lenis = getLenis();
      if (lenis) {
        lenis.scrollTo(root, {
          offset: -Math.max(24, (window.innerHeight - root.offsetHeight) / 2),
          duration: 1.2,
        });
      } else {
        root.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    return () => {
      ctx?.revert();
      writeFinal();
    };
  }, [resultsReady, originalSize, compressedSize, percentSaved]);

  useEffect(() => {
    const el = errorRef.current;
    if ((!resultsCancelled && !resultsFailed) || !el) return;
    if (prefersReducedMotion()) {
      gsap.set(el, { opacity: 1 });
      return;
    }
    const tween = gsap.fromTo(
      el,
      { y: 12, opacity: 0 },
      {
        y: 0,
        opacity: 1,
        duration: 0.5,
        ease: "power3.out",
        clearProps: "transform",
      }
    );
    return () => tween.kill();
  }, [resultsCancelled, resultsFailed]);

  return (
    <>
      {resultsReady && (
        <div
          ref={resultsRef}
          role="status"
          aria-live="polite"
          className="w-full rounded-none border-[3px] border-neutral-900 bg-white p-5 text-left opacity-0 shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl md:p-6 lg:p-8"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-none border-2 border-neutral-900 bg-[var(--accent)] text-neutral-900">
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <div>
              <h3 className="text-sm font-black uppercase tracking-wide text-neutral-900 md:text-base">
                Compression Complete
              </h3>
              <p className="mt-1 text-xs font-medium text-neutral-500 md:text-sm">
                {downloads.length > 1
                  ? `Your images are ready in ${downloads.length} zip files.`
                  : "Your zip is ready."}
              </p>
            </div>
          </div>

          <div className="mt-8 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">
                Original
              </p>
              <p className="font-mono text-sm font-medium text-neutral-400 line-through">
                {formatBytes(originalSize)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold uppercase tracking-widest text-neutral-900">
                New Size
              </p>
              <p
                ref={newSizeRef}
                className="font-mono text-3xl font-black tracking-tight text-neutral-900 md:text-4xl"
              >
                {formatBytes(compressedSize)}
              </p>
            </div>
          </div>

          <div className="mt-4 h-3 w-full overflow-hidden rounded-none border-[2px] border-neutral-900 bg-neutral-100">
            <div
              ref={barRef}
              className={`h-full w-full origin-left ${
                percentSaved >= 0 ? "bg-[var(--accent)]" : "bg-neutral-800"
              }`}
            />
          </div>

          <p className="mt-4 text-sm font-medium text-neutral-500">
            <span className="font-black text-neutral-900">
              {percentSaved >= 0 ? "Saved" : "Larger by"}{" "}
              <span ref={savedRef}>{Math.abs(percentSaved)}</span>%
            </span>
            {percentSaved >= 0 && " of total size"}
          </p>

          {breakdown && (
            <p className="mt-5 border-t-2 border-neutral-100 pt-4 font-mono text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              {breakdown}
            </p>
          )}

          {downloads.length > 0 && (
            <div className="mt-5 border-t-2 border-neutral-100 pt-5">
              <p className="text-xs font-medium text-neutral-500">
                {downloads.length > 1
                  ? "Tap each button below to download all zip parts."
                  : `The download should start on its own. If it didn't, use the ${
                      downloads.length > 1 ? "buttons" : "button"
                    } below.`}
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {downloads.map((d) => (
                  <a
                    key={d.name}
                    href={d.url}
                    download={d.name}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-none border-[3px] border-neutral-900 bg-[var(--accent)] px-4 py-3 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)] transition-transform hover:-translate-y-0.5 hover:translate-x-0.5 hover:shadow-[5px_5px_0_rgba(17,17,17,1)] active:translate-x-0 active:translate-y-0 active:shadow-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/30"
                  >
                    <span className="truncate">{d.name}</span>
                    <span className="shrink-0 font-mono text-[11px]">
                      {formatBytes(d.size)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {runInfo.missed?.length > 0 && (
            <p className="mt-3 text-xs font-medium text-amber-600">
              {runInfo.missed.length} image
              {runInfo.missed.length === 1 ? " is" : "s are"} still above the{" "}
              {runInfo.limitKB} KB limit:{" "}
              {runInfo.missed
                .slice(0, 3)
                .map((m) => `${m.name} (${formatBytes(m.size, 0)})`)
                .join(", ")}
              {runInfo.missed.length > 3
                ? ` and ${runInfo.missed.length - 3} more`
                : ""}
              . Try a smaller width or a different format.
            </p>
          )}
          {runInfo.stopped > 0 && (
            <p className="mt-3 text-xs font-medium text-amber-600">
              Stopped early. {runInfo.stopped} image
              {runInfo.stopped === 1 ? "" : "s"} left in the queue.
            </p>
          )}
          {runInfo.unreadable?.length > 0 && (
            <p className="mt-3 text-xs font-medium text-amber-600">
              {unreadableMessage(runInfo.unreadable)}
            </p>
          )}
          {runInfo.failed?.length > 0 && (
            <p className="mt-3 text-xs font-medium text-red-600">
              {runInfo.failed.length} failed and stayed in the queue so you can
              retry:{" "}
              {runInfo.failed
                .slice(0, 3)
                .map((f) => f.name)
                .join(", ")}
              {runInfo.failed.length > 3
                ? ` and ${runInfo.failed.length - 3} more`
                : ""}
              . First error: {runInfo.failed[0].reason}
            </p>
          )}
        </div>
      )}

      {resultsCancelled && (
        <div
          ref={errorRef}
          role="status"
          aria-live="polite"
          className="w-full rounded-none border-[3px] border-neutral-900 bg-white p-5 text-left opacity-0 shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl md:p-6"
        >
          <h3 className="text-sm font-black uppercase tracking-wide text-neutral-900 md:text-base">
            Cancelled
          </h3>
          <p className="mt-2 text-xs font-medium text-neutral-500 md:text-sm">
            No images were finished, and all of them are still in the queue.
            {runInfo.failed?.length > 0 &&
              ` ${runInfo.failed.length} failed before you cancelled. First error: ${runInfo.failed[0].reason}`}
          </p>
        </div>
      )}

      {resultsFailed && (
        <div
          ref={errorRef}
          role="alert"
          className="w-full rounded-none border-[3px] border-neutral-900 bg-red-50 p-5 text-left opacity-0 shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl md:p-6"
        >
          <h3 className="text-sm font-black uppercase tracking-wide text-red-600 md:text-base">
            Nothing could be compressed
          </h3>
          <p className="mt-2 text-xs font-medium text-red-600 md:text-sm">
            {runInfo.failed?.length > 0
              ? runInfo.failed[0].reason
              : "Nothing was processed."}
          </p>
        </div>
      )}
    </>
  );
}

export default memo(ResultsCard);
