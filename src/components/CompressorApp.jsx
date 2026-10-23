"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import Navbar from "@/components/Navbar";
import CompressionControls from "@/components/CompressionControls";
import DonateCard from "@/components/DonateCard";
import ImageDropzone from "@/components/ImageDropzone";
import ResultsCard from "@/components/ResultsCard";
import WelcomeModal from "@/components/WelcomeModal";
import FormatWarning, {
  ConfirmCompressDialog,
  estimateText,
} from "@/components/FormatWarning";
import { LoadingOverlay, PixelStyles } from "@/components/PixelLoader";
import { StepLabel, formatBytes, stripExt } from "@/components/StepHeader";
import {
  cancelActiveCompressJobs,
  clearPendingThumbnails,
  compressLocally,
  releaseIdleWorkers,
} from "@/lib/localCompress";
import { cancelAllThumbnails } from "@/lib/thumbnail";
import { isHeicFile } from "@/lib/fileTypes";
import { stash, unstash, clearStash } from "@/lib/fileStore";
import {
  getAvifMaxMegapixels,
  getAvifMaxPasses,
  getAvifSpeed,
  getConcurrency,
  getMaxBatchBytes,
  getMaxCanvasDimension,
  getMaxCanvasMegapixels,
  getMobileAdvice,
  getPartLimit,
  isMobileDevice,
  isNativeHeicBrowser,
  prefersReducedMotion,
} from "@/lib/device";

const NOTICE_MS = 6000;
const MAX_KB_FLOOR = 10;
const STASH_CONCURRENCY = 4;
const STASH_FLUSH_MS = 80;
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 3000;

const HERO_CONTENT = {
  optimizer: {
    badge: "Runs in your browser",
    line1: "Shrink images in bulk.",
    line2: "Keep them on your device.",
    desc: "Compress, resize and convert images right in your browser. Nothing is uploaded, and the only limit is your own device.",
  },
  upscale: {
    badge: "Swin2SR Offline AI Super-Res",
    line1: "Upscale & revive details.",
    line2: "Swin2SR AI in 2× or 4×.",
    desc: "Reconstruct real textures, remove JPEG blocks, and sharpen blurry photos locally using Swin2SR Vision Transformer neural models.",
  },
  bgremove: {
    badge: "ISNet 1024px Offline AI",
    line1: "Remove backgrounds.",
    line2: "Studio AI cutouts locally.",
    desc: "Separate portraits, fine hair strands, products, and objects with the 1024px ISNet-ONNX neural model right in your browser.",
  },
  passport: {
    badge: "300 DPI Passport & Stamp Studio",
    line1: "Passport & Stamp photos.",
    line2: "AI backdrop & print sheets.",
    desc: "Create 3.5×4.5 cm Passport (up to 8 per page) or 2.0×2.5 cm Stamp (up to 9 per page) sheets on 6×4\", A4, or Single Soft Copy with Muted Blue & Off-White AI backgrounds.",
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
    desc: "Optimize long videos to crisp Status HD and automatically split them into sequential 30-second or 60-second clips ready to post.",
  },
};

const LIMIT_LABEL = {
  "android-heic-avif": "HEIC to AVIF",
  "android-avif": "AVIF",
  "ios-avif": "AVIF",
  "android-heic": "HEIC photos",
  "pc-heic-avif": "HEIC to AVIF",
  "pc-avif": "AVIF",
  "pc-heic": "HEIC photos",
};

const unreadableMessage = (names) => {
  const many = names.length !== 1;
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${names.length} image${many ? "s" : ""} could not be read because the browser lost access to ${many ? "them" : "it"}: ${shown}${more}. Remove the red ${many ? "tiles" : "tile"} and add ${many ? "them" : "it"} again.`;
};

const makeNameRegistry = () => {
  const used = new Set();
  return (name) => {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    let n = 1;
    while (used.has(candidate.toLowerCase()))
      candidate = `${base} (${n++})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
};

async function isReadable(file) {
  let timer;
  try {
    await Promise.race([
      file.slice(0, 1).arrayBuffer(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatEta = (ms) =>
  ms < 45_000
    ? "less than a minute left"
    : `about ${Math.max(1, Math.round(ms / 60_000))} min left`;

const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

let idCounter = 0;
const makeId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;

const EMPTY_RUN = {
  ok: 0,
  local: 0,
  kept: 0,
  failed: [],
  unreadable: [],
  stopped: 0,
  cancelled: false,
  missed: [],
  limitKB: 0,
  formats: {},
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

export default function CompressorApp() {
  const [navSection, setNavSection] = useState("image");
  const [activeSubnav, setActiveSubnav] = useState("optimizer");

  const handleSelectSubnav = useCallback((sectionKey, subId) => {
    setNavSection(sectionKey);
    setActiveSubnav(subId);
  }, []);

  const [files, setFiles] = useState([]);
  const [width, setWidth] = useState(1080);
  const [quality, setQuality] = useState(80);
  const [format, setFormat] = useState("webp");
  const [maxKB, setMaxKB] = useState("");
  const [keepIfLarger, setKeepIfLarger] = useState(true);

  const [isProcessing, setIsProcessing] = useState(false);
  const [stage, setStage] = useState("compress");
  const [progress, setProgress] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [etaMs, setEtaMs] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [originalSize, setOriginalSize] = useState(0);
  const [compressedSize, setCompressedSize] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [downloads, setDownloads] = useState([]);
  const [runInfo, setRunInfo] = useState(EMPTY_RUN);
  const [notice, setNotice] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [adding, setAdding] = useState(null);
  const addTotalRef = useRef(0);
  const addDoneRef = useRef(0);

  const cancelRef = useRef(false);
  const startingRef = useRef(false);
  const formatRef = useRef(format);
  formatRef.current = format;
  const urlsRef = useRef([]);
  const filesRef = useRef([]);
  const noticeTimerRef = useRef(null);

  const pageRef = useRef(null);
  const buttonWrapRef = useRef(null);
  const buttonRef = useRef(null);

  const revokeDownloadUrls = useCallback(() => {
    if (urlsRef.current.length > 0) {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
      setDownloads([]);
    }
  }, []);

  const commitFiles = useCallback((updater) => {
    const next = updater(filesRef.current);
    filesRef.current = next;
    setFiles(next);
  }, []);

  const showNotice = useCallback((message) => {
    clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);

  useEffect(() => {
    clearStash();
  }, []);

  const handleFilesAdded = useCallback(
    async (incoming) => {
      const mobile = isMobileDevice();
      const deviceNoun = mobile ? "phone" : "device";
      const stats = {
        dupes: 0,
        overCap: 0,
        capLimit: Infinity,
        capReason: null,
        overSize: 0,
      };

      const current = filesRef.current;
      const seen = new Set(current.filter((f) => !f.broken).map((f) => f.key));
      let count = current.length;
      const byteLimit = getMaxBatchBytes();
      let bytes = current.reduce(
        (sum, f) => (f.broken ? sum : sum + f.file.size),
        0
      );
      let heicInQueue = current.some((f) => isHeicFile(f.file));
      const accepted = [];

      for (const file of incoming) {
        const key = fileKey(file);
        if (seen.has(key)) {
          stats.dupes++;
          continue;
        }
        const heic = isHeicFile(file);
        const advice = getMobileAdvice({
          format: formatRef.current,
          hasHeic: heicInQueue || heic,
        });
        if (count >= advice.fileLimit) {
          stats.overCap++;
          if (advice.fileLimit < stats.capLimit) {
            stats.capLimit = advice.fileLimit;
            stats.capReason = advice.reason;
          }
          continue;
        }
        if (bytes + file.size > byteLimit) {
          stats.overSize++;
          continue;
        }
        if (heic) heicInQueue = true;

        seen.add(key);
        count++;
        bytes += file.size;
        accepted.push({
          id: makeId(),
          key,
          file,
          ready: false,
          broken: false,
          stashed: false,
        });
      }

      if (accepted.length) {
        const newKeys = new Set(accepted.map((a) => a.key));
        commitFiles((prev) => [
          ...prev.filter((f) => !(f.broken && newKeys.has(f.key))),
          ...accepted,
        ]);
      }
      revokeDownloadUrls();
      setShowResults(false);

      const parts = [];
      if (stats.overCap) {
        const what = LIMIT_LABEL[stats.capReason];
        parts.push(
          what
            ? `${stats.overCap} not added: with ${what}, this ${deviceNoun} handles up to ${stats.capLimit} images per batch`
            : `${stats.overCap} not added: batches are capped at ${stats.capLimit} images on this ${deviceNoun}`
        );
      }
      if (stats.overSize) {
        parts.push(
          `${stats.overSize} not added: a batch can hold up to ${formatBytes(
            byteLimit,
            0
          )} of images on this ${deviceNoun}`
        );
      }
      if (stats.dupes) {
        parts.push(
          `${stats.dupes} duplicate${stats.dupes === 1 ? "" : "s"} skipped`
        );
      }
      if (parts.length) showNotice(`${parts.join(". ")}.`);

      if (!accepted.length) return;

      addTotalRef.current += accepted.length;
      setAdding({ done: addDoneRef.current, total: addTotalRef.current });

      const pendingPatches = new Map();
      let flushTimer = null;

      const flushPatches = () => {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (pendingPatches.size > 0) {
          const snapshot = new Map(pendingPatches);
          pendingPatches.clear();
          commitFiles((prev) =>
            prev.map((f) => {
              const p = snapshot.get(f.id);
              return p ? { ...f, ...p } : f;
            })
          );
        }
        if (addDoneRef.current >= addTotalRef.current) {
          addDoneRef.current = 0;
          addTotalRef.current = 0;
          setAdding(null);
        } else {
          setAdding({ done: addDoneRef.current, total: addTotalRef.current });
        }
      };

      const scheduleFlush = () => {
        if (!flushTimer) {
          flushTimer = setTimeout(flushPatches, STASH_FLUSH_MS);
        }
      };

      let next = 0;
      const worker = async () => {
        while (next < accepted.length) {
          const item = accepted[next++];
          let patch;
          try {
            patch = {
              file: await stash(item.id, item.file),
              ready: true,
              stashed: true,
            };
          } catch {
            patch = { ready: true, broken: true };
          }

          if (filesRef.current.some((f) => f.id === item.id)) {
            pendingPatches.set(item.id, patch);
          } else {
            unstash(item.id);
          }

          addDoneRef.current++;
          if (addDoneRef.current >= addTotalRef.current) {
            flushPatches();
          } else {
            scheduleFlush();
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(STASH_CONCURRENCY, accepted.length) },
          worker
        )
      );
      flushPatches();
    },
    [commitFiles, revokeDownloadUrls, showNotice]
  );

  const handleRemoveFile = useCallback(
    (idToRemove) => {
      unstash(idToRemove);
      commitFiles((prev) => prev.filter((f) => f.id !== idToRemove));
    },
    [commitFiles]
  );

  const handleClearAll = useCallback(() => {
    cancelAllThumbnails();
    clearStash();
    revokeDownloadUrls();
    setShowResults(false);
    commitFiles(() => []);
  }, [commitFiles, revokeDownloadUrls]);

  useEffect(() => {
    if (!isProcessing) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isProcessing]);

  useEffect(() => {
    if (
      !isProcessing ||
      typeof navigator === "undefined" ||
      !("wakeLock" in navigator)
    )
      return;
    let lock = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) l.release().catch(() => {});
        else lock = l;
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!lock || lock.released))
        acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [isProcessing]);

  useEffect(() => {
    return () => urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const triggerDownload = (d) => {
    const a = document.createElement("a");
    a.href = d.url;
    a.download = d.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const processImages = async () => {
    if (files.length === 0 || startingRef.current) return;

    clearPendingThumbnails();

    startingRef.current = true;
    const readable = [];
    const dead = [];
    try {
      const results = new Array(files.length);
      let idx = 0;
      const probeWorker = async () => {
        while (idx < files.length) {
          const i = idx++;
          const item = files[i];
          if (item.broken) {
            results[i] = false;
          } else if (item.stashed) {
            results[i] = true;
          } else {
            results[i] = await isReadable(item.file);
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(PROBE_CONCURRENCY, files.length) },
          probeWorker
        )
      );
      for (let i = 0; i < files.length; i++) {
        (results[i] ? readable : dead).push(files[i]);
      }
    } finally {
      startingRef.current = false;
    }

    const unreadable = dead.map((d) => d.file.name);
    if (dead.length) {
      const deadIds = new Set(dead.map((d) => d.id));
      commitFiles((prev) =>
        prev.map((f) => (deadIds.has(f.id) ? { ...f, broken: true } : f))
      );
    }
    if (readable.length === 0) {
      setRunInfo({
        ...EMPTY_RUN,
        failed: [
          { name: "Unreadable files", reason: unreadableMessage(unreadable) },
        ],
      });
      setShowResults(true);
      return;
    }
    const queue = readable;

    cancelRef.current = false;
    setStopping(false);
    setStage("compress");
    setDoneCount(0);
    setEtaMs(0);
    setTotalCount(queue.length);
    setProgress(0);
    setShowResults(false);
    setIsProcessing(true);

    revokeDownloadUrls();

    try {
      const { default: JSZip } = await import("jszip");

      const uniqueName = makeNameRegistry();
      const targetKB =
        Number(maxKB) > 0 && format !== "png"
          ? Math.max(MAX_KB_FLOOR, Number(maxKB))
          : 0;
      const limitBytes = targetKB * 1024;

      const stats = { local: 0, kept: 0 };
      const formatCounts = {};
      const missed = [];
      const succeeded = new Set();
      const keptIds = new Set();
      const failed = [];
      let completedCount = 0;
      const stamps = [Date.now()];
      let okOriginalBytes = 0;
      let totalCompressedBytes = 0;

      const partLimit = getPartLimit();
      let currentPart = [];
      let currentPartBytes = 0;
      const partBuckets = [currentPart];

      const addToZip = (name, content, options, size) => {
        if (currentPart.length > 0 && currentPartBytes + size > partLimit) {
          currentPart = [];
          currentPartBytes = 0;
          partBuckets.push(currentPart);
        }
        currentPart.push({ name: uniqueName(name), content, options });
        currentPartBytes += size;
      };

      const avifMaxPasses = getAvifMaxPasses();
      const avifMaxMegapixels = getAvifMaxMegapixels();
      const avifSpeed = getAvifSpeed();
      const maxCanvasMegapixels = getMaxCanvasMegapixels();
      const maxCanvasDimension = getMaxCanvasDimension();

      const viaLocal = async (file) => {
        const { blob, format: usedFormat } = await compressLocally(file, {
          width,
          quality,
          format,
          maxKB: targetKB,
          avifMaxPasses,
          avifMaxMegapixels,
          avifSpeed,
          maxCanvasMegapixels,
          maxCanvasDimension,
        });
        return {
          name: `${stripExt(file.name)}_compressed.${usedFormat}`,
          content: blob,
          options: {},
          size: blob.size,
          format: usedFormat,
        };
      };

      const handleOne = async (obj) => {
        try {
          const out = await viaLocal(obj.file);

          if (cancelRef.current) return;

          let finalSize;
          if (keepIfLarger && out.size >= obj.file.size) {
            addToZip(obj.file.name, obj.file, {}, obj.file.size);
            finalSize = obj.file.size;
            stats.kept++;
            keptIds.add(obj.id);
          } else {
            addToZip(out.name, out.content, out.options, out.size);
            finalSize = out.size;
            stats.local++;
            formatCounts[out.format] = (formatCounts[out.format] || 0) + 1;
            unstash(obj.id);
          }
          totalCompressedBytes += finalSize;
          okOriginalBytes += obj.file.size;
          succeeded.add(obj.id);

          if (limitBytes && finalSize > limitBytes) {
            missed.push({ name: obj.file.name, size: finalSize });
          }
        } catch (error) {
          if (cancelRef.current || error?.code === "CANCELLED") return;
          failed.push({ name: obj.file.name, reason: error.message });
        } finally {
          if (!cancelRef.current) {
            completedCount++;
            setDoneCount(completedCount);
            setProgress((completedCount / queue.length) * 100);

            stamps.push(Date.now());
            const recent = stamps.slice(-6);
            const avgMs =
              (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
            setEtaMs(avgMs * (queue.length - completedCount));
          }
        }
      };

      let cursor = 0;
      const runner = async () => {
        while (!cancelRef.current && cursor < queue.length) {
          const obj = queue[cursor++];
          await handleOne(obj);
        }
      };
      const queueHasHeic = queue.some((f) => isHeicFile(f.file));
      const heavyWorkload =
        format === "avif" || (queueHasHeic && !isNativeHeicBrowser());
      await Promise.all(
        Array.from(
          {
            length: getConcurrency("local", { heavy: heavyWorkload }),
          },
          runner
        )
      );

      releaseIdleWorkers();

      const wasCancelled = cancelRef.current;
      const okCount = succeeded.size;
      const notAttempted = wasCancelled
        ? queue.length - succeeded.size - failed.length
        : 0;

      setOriginalSize(okOriginalBytes);
      setCompressedSize(totalCompressedBytes);
      setRunInfo({
        ok: okCount,
        ...stats,
        failed,
        unreadable,
        stopped: notAttempted,
        cancelled: wasCancelled,
        missed,
        limitKB: targetKB,
        formats: formatCounts,
      });

      if (okCount > 0) {
        setStage("zip");
        setProgress(100);

        const nonEmptyParts = partBuckets.filter((p) => p.length > 0);
        const blobs = [];
        for (const part of nonEmptyParts) {
          const zip = new JSZip();
          for (const item of part) {
            zip.file(item.name, item.content, item.options);
          }
          part.length = 0;
          const blob = await zip.generateAsync({
            type: "blob",
            compression: "STORE",
          });
          blobs.push(blob);
        }

        const ready = blobs.map((blob, i) => ({
          name:
            blobs.length === 1
              ? "pixshrink_compressed.zip"
              : `pixshrink_compressed_part${i + 1}.zip`,
          url: URL.createObjectURL(blob),
          size: blob.size,
        }));
        urlsRef.current = ready.map((d) => d.url);
        setDownloads(ready);

        for (let i = 0; i < ready.length; i++) {
          if (i > 0 && isMobileDevice()) break;
          if (i > 0) await sleep(400);
          triggerDownload(ready[i]);
        }
      }

      setShowResults(true);
      keptIds.forEach((id) => unstash(id));
      commitFiles((prev) => prev.filter((f) => !succeeded.has(f.id)));
    } catch (error) {
      setRunInfo({
        ...EMPTY_RUN,
        failed: [{ name: "Batch", reason: error.message }],
      });
      setShowResults(true);
    } finally {
      setIsProcessing(false);
      setStopping(false);
    }
  };

  const hasHeic = useMemo(() => files.some((f) => isHeicFile(f.file)), [files]);

  const advice = useMemo(
    () => getMobileAdvice({ format, hasHeic }),
    [format, hasHeic]
  );
  const overBy = files.length - advice.fileLimit;
  const overLimit = overBy > 0;
  const [isMobileClient, setIsMobileClient] = useState(false);
  useEffect(() => {
    setIsMobileClient(isMobileDevice());
  }, []);
  const deviceLabel = isMobileClient ? "phone" : "device";
  const overLimitText = overLimit
    ? `This ${deviceLabel} can process ${advice.fileLimit} images per batch with ${
        LIMIT_LABEL[advice.reason] || "these settings"
      }. Remove ${overBy} image${overBy === 1 ? "" : "s"} or switch the format.`
    : "";

  const handleTrimToLimit = useCallback(() => {
    if (!Number.isFinite(advice.fileLimit)) return;
    commitFiles((prev) => {
      if (prev.length <= advice.fileLimit) return prev;
      const kept = prev.slice(0, advice.fileLimit);
      const removed = prev.slice(advice.fileLimit);
      removed.forEach((f) => unstash(f.id));
      return kept;
    });
  }, [advice.fileLimit, commitFiles]);

  const isDisabled =
    files.length === 0 ||
    files.every((f) => f.broken) ||
    isProcessing ||
    Boolean(adding) ||
    overLimit;

  const requestProcess = () => {
    if (advice.level === "strong") setConfirmOpen(true);
    else processImages();
  };
  const continueAnyway = () => {
    setConfirmOpen(false);
    processImages();
  };
  const switchToWebp = useCallback(() => {
    setConfirmOpen(false);
    setFormat("webp");
  }, []);

  const resultsReady = showResults && !isProcessing && runInfo.ok > 0;
  const resultsEmpty = showResults && !isProcessing && runInfo.ok === 0;
  const resultsFailed = resultsEmpty && !runInfo.cancelled;
  const resultsCancelled = resultsEmpty && runInfo.cancelled;

  const activeHero = HERO_CONTENT[activeSubnav] || HERO_CONTENT.optimizer;

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

      <ConfirmCompressDialog
        open={confirmOpen}
        fileCount={files.length}
        estimate={estimateText({
          count: files.length,
          width,
          hasMaxKB: Number(maxKB) > 0 && format !== "png",
        })}
        onContinue={continueAnyway}
        onSwitch={switchToWebp}
        onClose={() => setConfirmOpen(false)}
      />

      {isProcessing && (
        <LoadingOverlay
          title={
            stage === "zip" ? "Packing your zip" : "Compressing your images"
          }
          detail={
            stage === "zip"
              ? "Almost there. Your download starts on its own."
              : `${doneCount} of ${totalCount} done${
                  doneCount > 0 && etaMs > 0 ? ` · ${formatEta(etaMs)}` : ""
                }`
          }
          progress={progress}
          onCancel={
            stage === "compress"
              ? () => {
                  cancelRef.current = true;
                  setStopping(true);
                  cancelActiveCompressJobs();
                }
              : undefined
          }
          cancelling={stopping}
        />
      )}

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
              className="ps-reveal mt-6 max-w-[40ch] text-base font-medium leading-relaxed text-neutral-500 sm:mt-8 sm:text-lg"
            >
              {activeHero.desc}
            </p>
          </div>

          <div data-reveal className="ps-reveal mt-8 hidden w-full lg:block">
            <DonateCard />
          </div>
        </aside>

        <div className="min-w-0 w-full flex-1 lg:pt-4">
          <div className="space-y-12 sm:space-y-20">
              <section data-reveal className="ps-reveal">
                <StepLabel n={1}>Add your images</StepLabel>

                {hasHeic &&
                  advice.level === "none" &&
                  !isNativeHeicBrowser() && (
                    <div className="mb-6 rounded-none border-[3px] border-neutral-900 bg-[#FFE600] p-5 text-left shadow-[4px_4px_0_rgba(17,17,17,1)]">
                      <div className="flex items-start gap-4">
                        <svg
                          className="mt-0.5 h-6 w-6 shrink-0 text-neutral-900"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth="2.5"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div>
                          <h3 className="text-sm font-black uppercase tracking-wide text-neutral-900">
                            HEIC Images Detected
                          </h3>
                          <p className="mt-1 text-sm font-medium text-neutral-800">
                            Operations on Apple HEIC images can be slower.
                            Processing them locally means:
                          </p>
                          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm font-medium text-neutral-800">
                            <li>Preview generation will take slightly longer.</li>
                            <li>
                              Compression runs slower compared to standard
                              JPG/PNG files.
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                {notice && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-6 rounded-none border-[3px] border-neutral-900 bg-[#FFE600] p-4 text-left shadow-[4px_4px_0_rgba(17,17,17,1)]"
                  >
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-900">
                      {notice}
                    </p>
                  </div>
                )}

                <ImageDropzone
                  files={files}
                  adding={adding}
                  onFilesAdded={handleFilesAdded}
                  onRemoveFile={handleRemoveFile}
                  onClearAll={handleClearAll}
                />
              </section>

              <section data-reveal className="ps-reveal">
                <StepLabel n={2}>Choose your settings</StepLabel>
                <CompressionControls
                  width={width}
                  setWidth={setWidth}
                  quality={quality}
                  setQuality={setQuality}
                  format={format}
                  setFormat={setFormat}
                  maxKB={maxKB}
                  setMaxKB={setMaxKB}
                  keepIfLarger={keepIfLarger}
                  setKeepIfLarger={setKeepIfLarger}
                />
              </section>

              <section data-reveal className="ps-reveal">
                <StepLabel n={3}>Compress and download</StepLabel>
                <div className="flex flex-col items-stretch gap-6">
                  <FormatWarning
                    advice={advice}
                    onSwitch={switchToWebp}
                    className="w-full md:max-w-2xl"
                  />

                  <div
                    ref={buttonWrapRef}
                    className="w-full sm:w-auto sm:self-start"
                  >
                    <button
                      ref={buttonRef}
                      onClick={requestProcess}
                      disabled={isDisabled}
                      className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/30 sm:min-w-[22rem] md:text-base ${
                        isDisabled
                          ? "pointer-events-none cursor-not-allowed border-neutral-300 bg-neutral-200 text-neutral-400"
                          : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
                      }`}
                    >
                      <span>
                        {isProcessing
                          ? "Processing Batch..."
                          : "Compress & Download Zip"}
                      </span>
                      {!isProcessing && files.length > 0 && (
                        <span className="rounded-full bg-neutral-900 px-2.5 py-1 font-mono text-[11px] leading-none text-white">
                          {files.length}
                        </span>
                      )}
                      <svg
                        className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </button>
                  </div>

                  {overLimit && (
                    <div
                      role="alert"
                      className="w-full rounded-none border-[3px] border-neutral-900 bg-[#FFE600] p-4 text-left shadow-[4px_4px_0_rgba(17,17,17,1)] md:max-w-2xl"
                    >
                      <p className="text-xs font-bold uppercase tracking-wide text-neutral-900">
                        {overLimitText}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-3">
                        <button
                          type="button"
                          onClick={handleTrimToLimit}
                          className="cursor-pointer rounded-none border-[2px] border-neutral-900 bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
                        >
                          Keep first {advice.fileLimit} images
                        </button>
                        {format === "avif" && (
                          <button
                            type="button"
                            onClick={switchToWebp}
                            className="cursor-pointer rounded-none border-[2px] border-neutral-900 bg-[var(--accent)] px-3 py-1.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
                          >
                            Switch to WebP
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <ResultsCard
                    resultsReady={resultsReady}
                    resultsCancelled={resultsCancelled}
                    resultsFailed={resultsFailed}
                    originalSize={originalSize}
                    compressedSize={compressedSize}
                    downloads={downloads}
                    runInfo={runInfo}
                  />
                </div>
              </section>
          </div>

          <div className="mt-14 w-full md:max-w-md lg:hidden">
            <DonateCard />
          </div>
        </div>
      </div>
    </main>
  );
}