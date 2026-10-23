// Shared device helpers. Safe to import anywhere: every function guards against
// running on the server, where `window` and `navigator` don't exist.

export const MAX_MOBILE_FILES = 50;
export const MAX_DESKTOP_FILES = 200;

export const MOBILE_FILE_LIMITS = {
  standard: MAX_MOBILE_FILES,
  heavy: 25,
  heaviest: 10,
};

export const LOW_MEM_MOBILE_FILE_LIMITS = {
  standard: 30,
  heavy: 15,
  heaviest: 6,
};

export const DESKTOP_FILE_LIMITS = {
  standard: MAX_DESKTOP_FILES,
  heavy: 80,
  heaviest: 50,
};

export const LOW_MEM_DESKTOP_FILE_LIMITS = {
  standard: 120,
  heavy: 50,
  heaviest: 30,
};

export const MOBILE_AVIF_MAX_PASSES = 3;
export const DESKTOP_AVIF_MAX_PASSES = 4;
export const MOBILE_AVIF_MAX_MEGAPIXELS = 8;
export const DESKTOP_AVIF_MAX_MEGAPIXELS = 20;

export const MOBILE_MAX_CANVAS_MEGAPIXELS = 16;
export const DESKTOP_MAX_CANVAS_MEGAPIXELS = 50;
export const MOBILE_MAX_CANVAS_DIMENSION = 4096;
export const DESKTOP_MAX_CANVAS_DIMENSION = 8192;

export const MOBILE_AVIF_SPEED = 8;
export const DESKTOP_AVIF_SPEED = 6;

const MB = 1024 * 1024;
const MOBILE_PART_LIMIT = 40 * MB;
const DESKTOP_PART_LIMIT = 200 * MB;

export const MOBILE_MAX_BATCH_MB = 300;
export const LOW_MEM_MOBILE_MAX_BATCH_MB = 180;
export const PC_MAX_BATCH_MB = 1000;
export const LOW_MEM_PC_MAX_BATCH_MB = 600;

export const UPSCALE_LIMITS = {
  mobile: {
    maxFiles: 10,
    maxOutputPx: 4096,
    maxOutputMP: 16,
    maxOutputMp: 16,
    maxBatchMB: 150,
  },
  desktop: {
    maxFiles: 30,
    maxOutputPx: 8192,
    maxOutputMP: 48,
    maxOutputMp: 48,
    maxBatchMB: 500,
  },
};

export const BG_REMOVE_LIMITS = {
  mobile: { maxFiles: 10, maxOutputPx: 2560, maxBatchMB: 150 },
  desktop: { maxFiles: 30, maxOutputPx: 4096, maxBatchMB: 500 },
};

export const VIDEO_LIMITS = {
  mobile: {
    maxFiles: 1,
    maxFileMB: 250,
    lowMemMaxFileMB: 150,
    maxDurationSec: 300, // 5 minutes max on mobile for Video Optimizer
    maxHeightPx: 1440, // up to 2K on mobile
    defaultHeightPx: 720,
  },
  desktop: {
    maxFiles: 3,
    maxFileMB: 600,
    lowMemMaxFileMB: 350,
    maxDurationSec: 900, // 15 minutes max on PC
    maxHeightPx: 2160, // up to 4K (2160p) and 2K (1440p) on PC/Laptop
    defaultHeightPx: 1080,
  },
};

export const WHATSAPP_STATUS_LIMITS = {
  mobile: {
    maxFiles: 1,
    maxFileMB: 350,
    lowMemMaxFileMB: 220,
    maxDurationSec: 900, // 15 minutes max on mobile for WhatsApp Status splitting
    maxClips: 30,
    defaultClipSec: 30,
  },
  desktop: {
    maxFiles: 1,
    maxFileMB: 700,
    lowMemMaxFileMB: 400,
    maxDurationSec: 1200, // 20 minutes max on PC
    maxClips: 40,
    defaultClipSec: 30,
  },
};

let mobileCache = null;
let iosCache = null;
let safariCache = null;

export function getDeviceMemoryGB() {
  if (typeof navigator === "undefined") return 4;
  return typeof navigator.deviceMemory === "number" &&
    navigator.deviceMemory > 0
    ? navigator.deviceMemory
    : 4;
}

export function isLowMemoryDevice() {
  const mem = getDeviceMemoryGB();
  return isMobileDevice() ? mem <= 3 : mem <= 4;
}

export function getMaxBatchBytes() {
  const lowMem = isLowMemoryDevice();
  if (isMobileDevice()) {
    return (lowMem ? LOW_MEM_MOBILE_MAX_BATCH_MB : MOBILE_MAX_BATCH_MB) * MB;
  }
  return (lowMem ? LOW_MEM_PC_MAX_BATCH_MB : PC_MAX_BATCH_MB) * MB;
}

export function getUpscaleLimits() {
  return isMobileDevice() ? UPSCALE_LIMITS.mobile : UPSCALE_LIMITS.desktop;
}

export function getBgRemoveLimits() {
  return isMobileDevice() ? BG_REMOVE_LIMITS.mobile : BG_REMOVE_LIMITS.desktop;
}

export function getVideoLimits() {
  const base = isMobileDevice() ? VIDEO_LIMITS.mobile : VIDEO_LIMITS.desktop;
  const maxMB = isLowMemoryDevice() ? base.lowMemMaxFileMB : base.maxFileMB;
  return { ...base, maxFileMB: maxMB, maxFileBytes: maxMB * MB };
}

export function getWhatsappStatusLimits() {
  const base = isMobileDevice()
    ? WHATSAPP_STATUS_LIMITS.mobile
    : WHATSAPP_STATUS_LIMITS.desktop;
  const maxMB = isLowMemoryDevice() ? base.lowMemMaxFileMB : base.maxFileMB;
  return { ...base, maxFileMB: maxMB, maxFileBytes: maxMB * MB };
}

export function isMobileDevice() {
  if (typeof window === "undefined" || typeof navigator === "undefined")
    return false;
  if (mobileCache !== null) return mobileCache;

  const ua = navigator.userAgent || "";
  const uaMobile =
    /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const iPad =
    /iPad/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const coarseSmallScreen =
    window.matchMedia("(pointer: coarse)").matches &&
    Math.min(window.screen.width, window.screen.height) <= 900;

  mobileCache = Boolean(uaMobile || iPad || coarseSmallScreen);
  return mobileCache;
}

export function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  if (iosCache !== null) return iosCache;

  const ua = navigator.userAgent || "";
  const iOS = /iPhone|iPad|iPod/i.test(ua);
  const iPadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  iosCache = Boolean(iOS || iPadOS);
  return iosCache;
}

export function isNativeHeicBrowser() {
  if (typeof navigator === "undefined") return false;
  if (safariCache !== null) return safariCache;

  const ua = navigator.userAgent || "";
  const isSafari =
    /Safari/i.test(ua) &&
    !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS|Android/i.test(ua);
  safariCache = Boolean(isIOSDevice() || isSafari);
  return safariCache;
}

export function getPartLimit() {
  return isMobileDevice() ? MOBILE_PART_LIMIT : DESKTOP_PART_LIMIT;
}

export function getWorkerPoolSize({ heavy = false } = {}) {
  if (isMobileDevice()) return 1;
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  const memory = getDeviceMemoryGB();

  if (heavy) {
    const heavyCap = memory <= 4 ? 1 : 2;
    return Math.max(1, Math.min(heavyCap, cores - 1));
  }
  const memoryCap = memory <= 4 ? 2 : 4;
  return Math.max(1, Math.min(memoryCap, cores - 1));
}

export function getConcurrency(_engine = "local", { heavy = false } = {}) {
  if (isMobileDevice()) return 1;
  return getWorkerPoolSize({ heavy });
}

export function getMobileAdvice({ format, hasHeic }) {
  const avif = format === "avif";
  const nativeHeic = isNativeHeicBrowser();
  const wasmHeic = Boolean(hasHeic) && !nativeHeic;

  if (!isMobileDevice()) {
    const limits = isLowMemoryDevice()
      ? LOW_MEM_DESKTOP_FILE_LIMITS
      : DESKTOP_FILE_LIMITS;
    if (avif && wasmHeic) {
      return {
        level: "none",
        reason: "pc-heic-avif",
        fileLimit: limits.heaviest,
      };
    }
    if (avif) {
      return { level: "none", reason: "pc-avif", fileLimit: limits.heavy };
    }
    if (wasmHeic) {
      return { level: "none", reason: "pc-heic", fileLimit: limits.heavy };
    }
    return { level: "none", reason: null, fileLimit: limits.standard };
  }

  const ios = isIOSDevice();
  const limits = isLowMemoryDevice()
    ? LOW_MEM_MOBILE_FILE_LIMITS
    : MOBILE_FILE_LIMITS;

  if (avif && hasHeic && !ios) {
    return {
      level: "strong",
      reason: "android-heic-avif",
      fileLimit: limits.heaviest,
    };
  }
  if (avif) {
    return {
      level: "caution",
      reason: ios ? "ios-avif" : "android-avif",
      fileLimit: limits.heavy,
    };
  }
  if (hasHeic && !ios) {
    return {
      level: "caution",
      reason: "android-heic",
      fileLimit: limits.heavy,
    };
  }
  return { level: "none", reason: null, fileLimit: limits.standard };
}

export function getAvifMaxPasses() {
  return isMobileDevice() ? MOBILE_AVIF_MAX_PASSES : DESKTOP_AVIF_MAX_PASSES;
}

export function getAvifMaxMegapixels() {
  return isMobileDevice()
    ? MOBILE_AVIF_MAX_MEGAPIXELS
    : DESKTOP_AVIF_MAX_MEGAPIXELS;
}

export function getMaxCanvasMegapixels() {
  return isMobileDevice()
    ? MOBILE_MAX_CANVAS_MEGAPIXELS
    : DESKTOP_MAX_CANVAS_MEGAPIXELS;
}

export function getMaxCanvasDimension() {
  return isMobileDevice()
    ? MOBILE_MAX_CANVAS_DIMENSION
    : DESKTOP_MAX_CANVAS_DIMENSION;
}

export function getAvifSpeed() {
  return isMobileDevice() ? MOBILE_AVIF_SPEED : DESKTOP_AVIF_SPEED;
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;