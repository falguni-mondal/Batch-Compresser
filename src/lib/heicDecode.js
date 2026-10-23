// Decodes HEIC/HEIF with libheif (WebAssembly) for browsers that can't do it natively
// (Chrome, Edge, Firefox). Safari and iOS decode HEIC themselves and never reach this file.
//
// The decoder (~1.5 MB+) is NOT part of the app bundle. It is self-hosted at
// /libheif/libheif-bundle.js (copied from node_modules by scripts/copy-libheif.mjs) and is
// only downloaded the first time someone adds a HEIC file. Loading it as a plain script
// keeps it independent of webpack/Turbopack quirks.
//
// Error policy: a corrupt or unsupported file only fails that file. The WASM instance is
// thrown away (and reloaded next time) only when the failure looks like the instance itself
// is damaged, such as running out of memory or aborting.

const DECODER_URL = "/libheif/libheif-bundle.js";

// Raw RGBA needs width * height * 4 bytes, plus copies made by ImageData/createImageBitmap.
// Refuse images that would very likely crash the tab instead of trying.
const MAX_PIXELS_LOW_MEMORY = 50_000_000; // ~200 MB of RGBA (supports 48 MP phone cameras)
const MAX_PIXELS_DEFAULT = 100_000_000; // ~400 MB of RGBA

let libheifPromise = null;

function resolveDecoderUrl() {
  try {
    if (typeof self !== "undefined" && self.location?.origin) {
      return new URL(DECODER_URL, self.location.origin).href;
    }
  } catch {
    // fall back to relative URL
  }
  return DECODER_URL;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => {
      el.remove();
      reject(new Error("could not load the HEIC decoder script"));
    };
    document.head.appendChild(el);
  });
}

function loadLibheif() {
  if (!libheifPromise) {
    const promise = (async () => {
      const url = resolveDecoderUrl();
      if (typeof self !== "undefined" && typeof self.importScripts === "function") {
        self.importScripts(url); // inside a classic worker
      } else if (typeof document !== "undefined") {
        await injectScript(url); // main-thread fallback
      } else {
        // Module worker fallback where neither importScripts nor document exists
        const res = await fetch(url);
        if (!res.ok) throw new Error("could not load the HEIC decoder script");
        const code = await res.text();
        (0, eval)(code);
      }

      let lib = globalThis.libheif;
      if (typeof lib === "function") lib = await lib(); // in case the build exposes a factory
      if (!lib?.HeifDecoder) {
        throw new Error('HEIC decoder not found. Run "node scripts/copy-libheif.mjs" and restart.');
      }
      return lib;
    })();
    libheifPromise = promise;
    // Allow a retry later if loading failed (but never clobber a newer promise).
    promise.catch(() => {
      if (libheifPromise === promise) libheifPromise = null;
    });
  }
  return libheifPromise;
}

// libheif-js sometimes throws strings or plain objects instead of Error instances.
function toError(value) {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (value && typeof value.message === "string") return new Error(value.message);
  try {
    return new Error(`libheif error: ${JSON.stringify(value)}`);
  } catch {
    return new Error("libheif failed to decode the image");
  }
}

// True when the WASM instance itself can no longer be trusted.
function isFatalWasmError(error) {
  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
  if (error instanceof RangeError) return true; // e.g. failed allocation
  return /out of memory|cannot enlarge memory|memory access|unreachable|abort/i.test(
    error?.message || ""
  );
}

function maxPixels() {
  const mem = typeof navigator !== "undefined" ? navigator.deviceMemory : undefined;
  return typeof mem === "number" && mem <= 4 ? MAX_PIXELS_LOW_MEMORY : MAX_PIXELS_DEFAULT;
}

// A file can hold several top-level images (burst photos, Live Photos, depth/aux images).
// libheif-js doesn't expose which one is "primary", so use the largest, which is the
// full-resolution photo for camera files.
function pickMainImage(images) {
  let best = images[0];
  let bestPixels = best.get_width() * best.get_height();
  for (let i = 1; i < images.length; i++) {
    const pixels = images[i].get_width() * images[i].get_height();
    if (pixels > bestPixels) {
      best = images[i];
      bestPixels = pixels;
    }
  }
  return best;
}

// HEIC decoding is CPU- and memory-heavy (a 12 MP photo needs ~48 MB of raw pixels),
// so decode one file at a time per worker.
let decodeQueue = Promise.resolve();

/**
 * @param {File|Blob|Uint8Array|ArrayBuffer} source
 * @param {{ resizeWidth?: number, resizeQuality?: string }} [options]
 */
export function decodeHeicToBitmap(source, options) {
  const job = decodeQueue.then(() => decodeNow(source, options));
  decodeQueue = job.catch(() => {});
  return job;
}

async function toUint8Array(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source && typeof source.arrayBuffer === "function") {
    return new Uint8Array(await source.arrayBuffer());
  }
  throw new Error("Invalid HEIC source data");
}

async function decodeNow(source, options) {
  const libheif = await loadLibheif();
  let images = [];
  let mainImage = null;
  try {
    const inputBytes = await toUint8Array(source);
    const decoder = new libheif.HeifDecoder();
    images = decoder.decode(inputBytes) || [];
    if (!images.length) throw new Error("no image found in the file");

    mainImage = pickMainImage(images);
    // Free auxiliary/burst images right away before allocating the full RGBA display buffer.
    for (const img of images) {
      if (img !== mainImage) img.free?.();
    }
    images = [];

    const width = mainImage.get_width();
    const height = mainImage.get_height();

    if (!width || !height) throw new Error("the image has no size");
    if (width * height > maxPixels()) {
      throw new Error(
        `the image is too large to decode on this device (${Math.round((width * height) / 1e6)} MP)`
      );
    }

    const pixels = await new Promise((resolve, reject) => {
      mainImage.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (out) => {
          if (out) resolve(out.data);
          else reject(new Error("libheif could not render the image"));
        }
      );
    });

    // Free the WASM decoded frame immediately BEFORE allocating the ImageBitmap!
    // This cuts peak memory during createImageBitmap nearly in half.
    mainImage.free?.();
    mainImage = null;

    const imageData = new ImageData(pixels, width, height);
    if (options?.resizeWidth && options.resizeWidth < width) {
      try {
        return await createImageBitmap(imageData, options);
      } catch {
        // Fallback if options aren't supported on ImageData in this browser
      }
    }
    return await createImageBitmap(imageData);
  } catch (raw) {
    const error = toError(raw);
    // Only throw the decoder away if the WASM instance itself may be damaged.
    // A corrupt file shouldn't cost the next file a 1.5 MB re-download.
    if (isFatalWasmError(error)) libheifPromise = null;
    throw error;
  } finally {
    mainImage?.free?.();
    for (const image of images) image.free?.();
  }
}