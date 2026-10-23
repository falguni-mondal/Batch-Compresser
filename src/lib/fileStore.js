// Bulletproof file acquisition & stash for both Mobile and PC/Laptop.
//
// Why NotReadableError happened on mobile when upscaling or removing backgrounds:
//  1) On Android Chrome, selecting a file from the Photo Picker (`content://media/picker/...`)
//     grants a short-lived stream handle. If `ImageDropzone` reads that raw `File` for a thumbnail
//     or if the user waits a few seconds before tapping "Upscale", Android closes/revokes the
//     underlying `content://` descriptor and throws:
//     `NotReadableError: The requested file could not be read, typically due to permission problems...`
//  2) How we fix it across ALL tools (Optimizer, Upscaler, BG Remover, Passport, Video):
//     The instant the user selects a file, `stash(id, file)` reads the raw bytes via
//     `readBytesWithRetry(file)` BEFORE thumbnail generation (`ready: false -> true`) and wraps
//     those bytes into a detached in-memory `File` (`new File([buffer], ...)`). Because the bytes
//     already live in JS memory, Android can never revoke access or throw `NotReadableError`.

import { isLowMemoryDevice, isMobileDevice } from "./device";

const DB = "pixshrink-stash";
const STORE = "files";
const MB = 1024 * 1024;

const ram = new Map(); // id -> byteLength held in RAM
const fileCache = new Map(); // id -> detached in-memory File reference
let ramBytes = 0;
let dbp;

function getRamCapBytes() {
  if (isMobileDevice()) {
    return (isLowMemoryDevice() ? 180 : 320) * MB;
  }
  return (isLowMemoryDevice() ? 350 : 750) * MB;
}

function getSingleFileRamMaxBytes() {
  return (isMobileDevice() ? 120 : 250) * MB;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readViaFileReader(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
}

function readViaObjectUrlFetch(blob) {
  return new Promise((resolve, reject) => {
    if (typeof URL === "undefined" || typeof fetch === "undefined") {
      reject(new Error("ObjectURL fetch unavailable"));
      return;
    }
    const url = URL.createObjectURL(blob);
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        URL.revokeObjectURL(url);
        resolve(buf);
      })
      .catch((err) => {
        URL.revokeObjectURL(url);
        reject(err);
      });
  });
}

/**
 * Materializes the full byte array of `file` with automatic retries across `arrayBuffer()`,
 * `FileReader`, and `URL.createObjectURL` fetch in case Android's MediaProvider is staging the file.
 *
 * @param {Blob} file
 * @returns {Promise<ArrayBuffer>}
 */
export async function readBytesWithRetry(file) {
  if (file && file._pixshrinkDetached && typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (typeof file.arrayBuffer === "function") {
        const buf = await file.arrayBuffer();
        if (buf && buf.byteLength > 0) return buf;
      }
    } catch (e) {
      lastError = e;
    }
    try {
      const buf = await readViaFileReader(file);
      if (buf && buf.byteLength > 0) return buf;
    } catch (e) {
      lastError = e;
    }
    try {
      const buf = await readViaObjectUrlFetch(file);
      if (buf && buf.byteLength > 0) return buf;
    } catch (e) {
      lastError = e;
    }
    if (attempt < 3) await sleep(100 * (attempt + 1));
  }
  throw lastError || new Error(`Could not read "${file?.name || "file"}"`);
}

const db = () =>
  (dbp ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        r.result.createObjectStore(STORE);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    dbp = undefined;
    throw e;
  }));

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error || req?.error);
  });
}

const rewrap = (part, file) => {
  const f = new File([part], file.name, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
  });
  try {
    Object.defineProperty(f, "_pixshrinkDetached", {
      value: true,
      enumerable: false,
    });
  } catch {}
  return f;
};

/**
 * Reads `file` immediately into a detached in-memory File so it can NEVER expire
 * with `NotReadableError` on Android/iOS later.
 */
export async function stash(id, file) {
  if (file && file._pixshrinkDetached) {
    fileCache.set(id, file);
    return file;
  }

  const buffer = await readBytesWithRetry(file);
  const size = buffer.byteLength;

  if (size <= getSingleFileRamMaxBytes() && ramBytes + size <= getRamCapBytes()) {
    const memFile = rewrap(buffer, file);
    ram.set(id, size);
    fileCache.set(id, memFile);
    ramBytes += size;
    return memFile;
  }

  try {
    const detachedBlob = new Blob([buffer], {
      type: file.type || "application/octet-stream",
    });
    await tx("readwrite", (s) => s.put(detachedBlob, id));
    const diskBlob = await tx("readonly", (s) => s.get(id));
    if (diskBlob && diskBlob.size > 0) {
      const wrapped = rewrap(diskBlob, file);
      fileCache.set(id, wrapped);
      return wrapped;
    }
  } catch {}

  const fallbackFile = rewrap(buffer, file);
  ram.set(id, size);
  fileCache.set(id, fallbackFile);
  ramBytes += size;
  return fallbackFile;
}

export function getStashedFile(id, fallbackFile) {
  return fileCache.get(id) || fallbackFile;
}

export function unstash(id) {
  fileCache.delete(id);
  if (ram.has(id)) {
    ramBytes = Math.max(0, ramBytes - ram.get(id));
    ram.delete(id);
  }
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return tx("readwrite", (s) => s.delete(id)).catch(() => {});
}

export function clearStash() {
  fileCache.clear();
  ram.clear();
  ramBytes = 0;
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return tx("readwrite", (s) => s.clear()).catch(() => {});
}