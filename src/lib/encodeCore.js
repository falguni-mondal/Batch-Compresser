// Core image encoding and thumbnail generation module (runs inside Web Workers or main thread).

import { decodeHeicToBitmap } from "./heicDecode";
import { encodeAvif } from "./avifEncode";
import { isHeicFile } from "./fileTypes";
import {
  ascii,
  getImageSize,
  materializeInput,
  matchesFormatSignature,
  verifyOutput,
} from "./exifAndHeader";

export { matchesFormatSignature };

export const MIME = {
  webp: "image/webp",
  avif: "image/avif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const MIN_MAX_KB = 10;
const MIN_QUALITY = 0.05;

const DEFAULT_AVIF_SPEED = 6;
const AVIF_BEST_CQ = 10;
const AVIF_MAX_CQ = 63;
const AVIF_MAX_PASSES = 4;

const DEFAULT_MAX_CANVAS_MP = 50;
const DEFAULT_MAX_CANVAS_SIDE = 8192;

const avifCqFromSlider = (q100) =>
  Math.round(AVIF_MAX_CQ - ((q100 - 1) / 99) * (AVIF_MAX_CQ - AVIF_BEST_CQ));

export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const supportCache = {};
export async function canEncode(format) {
  if (!(format in MIME)) return false;
  if (format === "jpg" || format === "jpeg" || format === "png") return true;
  if (format === "avif") return typeof WebAssembly !== "undefined";
  if (format in supportCache) return supportCache[format];

  let ok = false;
  let canvas = null;
  try {
    canvas = makeCanvas(1, 1);
    canvas.getContext("2d");
    const blob = await canvasToBlob(canvas, MIME[format], 0.8);
    ok = !!blob && blob.type === MIME[format];
  } catch {
    ok = false;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  supportCache[format] = ok;
  return ok;
}

export function clampDimensions(width, height, maxMP, maxSide) {
  let w = width;
  let h = height;

  if (maxSide > 0 && (w > maxSide || h > maxSide)) {
    const sideScale = maxSide / Math.max(w, h);
    w = Math.max(1, Math.floor(w * sideScale));
    h = Math.max(1, Math.floor(h * sideScale));
  }

  const maxPixels =
    maxMP > 0 && Number.isFinite(maxMP) ? maxMP * 1e6 : Infinity;
  if (w * h > maxPixels) {
    const mpScale = Math.sqrt(maxPixels / (w * h));
    w = Math.max(1, Math.floor(w * mpScale));
    h = Math.max(1, Math.floor(h * mpScale));
  }

  return { width: w, height: h };
}

async function decodeMaterializedBitmap(mat, options) {
  let lastError;

  const attempts = mat.heic
    ? [options]
    : options
    ? [options, undefined]
    : [undefined];
  for (const opts of attempts) {
    try {
      return opts
        ? await createImageBitmap(mat.blob, opts)
        : await createImageBitmap(mat.blob);
    } catch (e) {
      lastError = e;
    }
  }

  const looksLikeHeic =
    mat.heic ||
    (mat.bytes.length >= 12 &&
      ascii(mat.bytes, 4, 8) === "ftyp" &&
      /heic|heix|hevc|heim|heis|mif1|msf1/i.test(ascii(mat.bytes, 8, 12)));

  if (looksLikeHeic) {
    try {
      return await decodeHeicToBitmap(mat.bytes, options);
    } catch (heicError) {
      throw new Error(`Couldn't decode "${mat.name}" (${heicError.message})`);
    }
  }

  const reason = lastError
    ? `${lastError.name || "Error"}: ${lastError.message || "unknown"}`
    : "unknown";
  throw new Error(
    `This browser can't read "${mat.name}" (${
      mat.type || "unknown type"
    }) - ${reason}`
  );
}

async function decodeMaterializedForTarget(
  mat,
  requestedWidth,
  maxMP,
  maxSide
) {
  const target = Number(requestedWidth);
  if (mat.heic) {
    const resizeW =
      target > 0 ? Math.min(Math.round(target), maxSide) : undefined;
    return decodeMaterializedBitmap(
      mat,
      resizeW ? { resizeWidth: resizeW, resizeQuality: "medium" } : undefined
    );
  }
  if (target > 0) {
    const size = await getImageSize(mat.bytes);
    if (size && !size.rotated && target < size.width) {
      const rawH = Math.max(1, Math.round(size.height * (target / size.width)));
      const clamped = clampDimensions(
        Math.round(target),
        rawH,
        maxMP,
        maxSide
      );
      return decodeMaterializedBitmap(mat, {
        resizeWidth: clamped.width,
        resizeQuality: "medium",
      });
    }
  }
  return decodeMaterializedBitmap(mat);
}

function decodeViaHtmlImage(file) {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof URL === "undefined") {
      reject(new Error("Image element unavailable"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const c = makeCanvas(w, h);
        c.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        if (typeof createImageBitmap === "function") {
          resolve(await createImageBitmap(c));
        } else {
          resolve(c);
        }
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not load image "${file?.name || "file"}"`));
    };
    img.src = url;
  });
}

export async function decodeBitmap(file, options) {
  // Fast path on mobile: if non-HEIC, try direct createImageBitmap(file) or HTMLImageElement fallback
  // if materializeInput encounters an Android content:// stream restriction
  try {
    const mat = await materializeInput(file);
    return await decodeMaterializedBitmap(mat, options);
  } catch (err) {
    if (file && !isHeicFile(file)) {
      try {
        return options
          ? await createImageBitmap(file, options)
          : await createImageBitmap(file);
      } catch {}
      try {
        return await decodeViaHtmlImage(file);
      } catch {}
    }
    throw err;
  }
}

export async function compressImage(
  file,
  {
    width,
    quality,
    format,
    maxKB = 0,
    avifMaxPasses,
    avifMaxMegapixels,
    avifSpeed,
    maxCanvasMegapixels,
    maxCanvasDimension,
  }
) {
  if (!(await canEncode(format))) {
    throw new Error(
      `${format.toUpperCase()} encoding isn't supported by this browser`
    );
  }

  const maxSide =
    maxCanvasDimension > 0 ? maxCanvasDimension : DEFAULT_MAX_CANVAS_SIDE;
  let maxMP =
    maxCanvasMegapixels > 0 ? maxCanvasMegapixels : DEFAULT_MAX_CANVAS_MP;
  if (format === "avif" && avifMaxMegapixels > 0 && avifMaxMegapixels < maxMP) {
    maxMP = avifMaxMegapixels;
  }

  const mat = await materializeInput(file);
  const bitmap = await decodeMaterializedForTarget(mat, width, maxMP, maxSide);
  let canvas = null;

  try {
    const target = Number(width);
    const scale =
      target > 0 && bitmap.width > target ? target / bitmap.width : 1;
    const desiredW = Math.max(1, Math.round(bitmap.width * scale));
    const desiredH = Math.max(1, Math.round(bitmap.height * scale));
    const { width: w, height: h } = clampDimensions(
      desiredW,
      desiredH,
      maxMP,
      maxSide
    );

    canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error(
        `Canvas ${w}x${h} exceeded this device's memory limit`
      );
    }

    if (format === "jpg" || format === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const maxBytes =
      Number(maxKB) > 0 && format !== "png"
        ? Math.max(MIN_MAX_KB, Number(maxKB)) * 1024
        : 0;
    const q100 = Math.min(100, Math.max(1, Number(quality) || 80));

    if (format === "avif") {
      const imageData = ctx.getImageData(0, 0, w, h);
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;

      const startCq = avifCqFromSlider(q100);
      const speed = avifSpeed > 0 ? avifSpeed : DEFAULT_AVIF_SPEED;
      let blob = await encodeAvif(imageData, startCq, speed);

      if (maxBytes > 0 && blob.size > maxBytes && startCq < AVIF_MAX_CQ) {
        const maxPasses =
          avifMaxPasses > 0 ? avifMaxPasses : AVIF_MAX_PASSES;
        let lo = startCq + 1;
        let hi = AVIF_MAX_CQ;
        let best = null;

        for (let i = 0; i < maxPasses && lo <= hi; i++) {
          const mid = Math.ceil((lo + hi) / 2);
          const candidate = await encodeAvif(imageData, mid, speed);
          if (candidate.size <= maxBytes) {
            best = candidate;
            hi = mid - 1;
          } else {
            blob = candidate;
            lo = mid + 1;
          }
        }
        if (best) blob = best;
      }

      await verifyOutput(blob, format, w, h);
      return {
        blob,
        format,
        hitLimit: maxBytes === 0 || blob.size <= maxBytes,
      };
    }

    const mime = MIME[format];
    const startQ = format === "png" ? 1 : q100 / 100;
    const encode = (q) => canvasToBlob(canvas, mime, q);

    let blob = await encode(startQ);

    if (maxBytes > 0 && blob && blob.size > maxBytes) {
      let lo = MIN_QUALITY;
      let hi = startQ;
      let best = null;

      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        const candidate = await encode(mid);
        if (!candidate) break;
        if (candidate.size <= maxBytes) {
          best = candidate;
          lo = mid;
        } else {
          blob = candidate;
          hi = mid;
        }
      }

      if (best) {
        blob = best;
      } else if (MIN_QUALITY < startQ) {
        const floor = await encode(MIN_QUALITY);
        if (floor && (!blob || floor.size < blob.size)) blob = floor;
      }
    }

    await verifyOutput(blob, format, w, h);
    return {
      blob,
      format,
      hitLimit: maxBytes === 0 || blob.size <= maxBytes,
    };
  } finally {
    bitmap.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

const THUMB_DEFAULT = 256;

export async function renderThumbnail(file, maxSize = THUMB_DEFAULT) {
  const mat = await materializeInput(file);
  const size = !mat.heic ? await getImageSize(mat.bytes) : null;
  let resizeOpts;

  if (size && !size.rotated) {
    const scale = Math.min(1, maxSize / Math.max(size.width, size.height));
    resizeOpts =
      scale < 1
        ? {
            resizeWidth: Math.max(1, Math.round(size.width * scale)),
            resizeHeight: Math.max(1, Math.round(size.height * scale)),
            resizeQuality: "low",
          }
        : undefined;
  } else if (mat.heic) {
    resizeOpts = { resizeWidth: maxSize, resizeQuality: "low" };
  }

  const bitmap = await decodeMaterializedBitmap(mat, resizeOpts);
  let canvas = null;
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create thumbnail canvas");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const mime = (await canEncode("webp")) ? "image/webp" : "image/jpeg";
    const blob = await canvasToBlob(canvas, mime, 0.7);
    if (!blob || blob.size === 0)
      throw new Error("Thumbnail encoding produced an empty file");
    return blob;
  } finally {
    bitmap.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
export { renderThumbnail as createThumbnail };
