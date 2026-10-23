// Public API for local processing, backed by a pool of Web Workers.
//
// Design:
//  - Each worker runs one job at a time. Parallelism comes from having several workers.
//  - Two queues: "compress" jobs always run before "thumb" jobs, so previews never slow
//    down a running batch.
//  - Workers are created on demand (up to getWorkerPoolSize()) and terminated after
//    IDLE_MS without work, or immediately before zipping via releaseIdleWorkers().
//  - Workers that run heavy WASM jobs (HEIC decode or AVIF encode) are recycled periodically
//    because WebAssembly linear memory never shrinks once grown.
import { canEncode, compressImage, renderThumbnail } from "./encodeCore";
import { isHeicFile } from "./fileTypes";
import { getWorkerPoolSize, isMobileDevice } from "./device";

export const canEncodeLocally = canEncode;

const TIMEOUT_MS = { compress: 90_000, thumb: 45_000 };
const HEIC_TIMEOUT_FACTOR = 2; // a worker's first HEIC job also downloads the WASM decoder
const TIMEOUT_CEILING_MS = 30 * 60_000; // nothing is allowed to run longer than this
// Extra time per output megapixel per AVIF encode pass.
const AVIF_SECONDS_PER_MP_PASS = { desktop: 8, mobile: 20 };
const DEFAULT_AVIF_PASSES = 4; // same default as encodeCore.js
const MAX_ATTEMPTS = 2;
const MOBILE_MAX_ATTEMPTS = 3; // a fresh worker often fixes a memory-related crash
const MAX_EARLY_CRASHES = 2; // crashes before any worker ever answered
const MOBILE_WASM_JOBS_BEFORE_RECYCLE = 4; // recycle worker after 4 heavy WASM jobs on mobile
const DESKTOP_WASM_JOBS_BEFORE_RECYCLE = 10; // recycle worker after 10 heavy WASM jobs on desktop
const IDLE_MS = 20_000;

const slots = new Set(); // { worker, task, idleTimer, wasmJobs }
const queues = { compress: [], thumb: [] };
let workerBroken = false; // true only if workers never worked at all
let everResponded = false;
let earlyCrashes = 0;
let nextId = 1;

const maxAttempts = () => (isMobileDevice() ? MOBILE_MAX_ATTEMPTS : MAX_ATTEMPTS);
const maxWasmJobs = () =>
  isMobileDevice() ? MOBILE_WASM_JOBS_BEFORE_RECYCLE : DESKTOP_WASM_JOBS_BEFORE_RECYCLE;

function isHeavyWasmTask(task) {
  if (!task?.payload) return false;
  if (task.payload.file && isHeicFile(task.payload.file)) return true;
  if (task.type === "compress" && task.payload.opts?.format === "avif") return true;
  return false;
}

// Time a job may take before it is stopped.
function timeoutFor(task) {
  const base = TIMEOUT_MS[task.type] ?? TIMEOUT_MS.compress;
  let ms = isHeicFile(task.payload.file) ? base * HEIC_TIMEOUT_FACTOR : base;

  const opts = task.payload.opts;
  if (task.type === "compress" && opts?.format === "avif") {
    const width = Number(opts.width) > 0 ? Number(opts.width) : 3840;
    const outMP = (width * width * (4 / 3)) / 1e6;
    const passes =
      1 + (Number(opts.maxKB) > 0 ? (Number(opts.avifMaxPasses) || DEFAULT_AVIF_PASSES) + 1 : 0);
    const perMP = AVIF_SECONDS_PER_MP_PASS[isMobileDevice() ? "mobile" : "desktop"];
    ms += outMP * passes * perMP * 1000;
  }
  return Math.min(ms, TIMEOUT_CEILING_MS);
}

const makeError = (message, code) => Object.assign(new Error(message), { code });

function canUseWorkers() {
  return !workerBroken && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
}

/* ----------------------------- slot lifecycle ----------------------------- */

function removeSlot(slot) {
  clearTimeout(slot.idleTimer);
  if (slot.task) clearTimeout(slot.task.timer);
  slots.delete(slot);
  try {
    slot.worker.terminate();
  } catch {
    // ignore terminate errors
  }
}

// Marks the slot's job as done and starts its idle countdown.
function release(slot) {
  if (slot.task) clearTimeout(slot.task.timer);
  slot.task = null;
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (!slot.task && slots.has(slot)) removeSlot(slot);
  }, IDLE_MS);
}

/**
 * Terminates all currently idle workers immediately so their WASM and canvas memory
 * is returned to the OS right before JSZip builds the zip archive.
 */
export function releaseIdleWorkers() {
  for (const slot of Array.from(slots)) {
    if (!slot.task) removeSlot(slot);
  }
}

/**
 * Cancels all queued and in-flight compression jobs immediately (used when the user clicks
 * "Stop early"), terminating active compress workers so the user never waits for a slow
 * WASM encode to finish after cancelling.
 */
export function cancelActiveCompressJobs() {
  const queued = queues.compress.splice(0);
  for (const task of queued) {
    task.reject(makeError("Compression cancelled", "CANCELLED"));
  }
  for (const slot of Array.from(slots)) {
    if (slot.task && slot.task.type === "compress") {
      const task = slot.task;
      removeSlot(slot);
      slot.task = null;
      task.reject(makeError("Compression cancelled", "CANCELLED"));
    }
  }
  dispatch();
}

/**
 * Drops any queued (not yet running) thumbnail jobs from the worker queue.
 */
export function clearPendingThumbnails() {
  const queued = queues.thumb.splice(0);
  for (const task of queued) {
    task.reject(makeError("Thumbnail cancelled", "CANCELLED"));
  }
}

// Nothing ever worked: give up on workers and let every job use the main thread.
function failEverything() {
  workerBroken = true;
  const running = [];
  for (const slot of Array.from(slots)) {
    if (slot.task) running.push(slot.task);
    removeSlot(slot);
  }
  const waiting = [...queues.compress.splice(0), ...queues.thumb.splice(0)];
  for (const task of [...running, ...waiting]) {
    task.reject(makeError("Worker failed to start", "WORKER_FAILED"));
  }
}

function handleCrash(slot) {
  const task = slot.task;
  removeSlot(slot);
  slot.task = null;

  if (!everResponded) {
    // No worker has answered yet. Put the job back either way.
    if (task) queues[task.type].unshift(task);
    earlyCrashes++;
    // Two silent deaths in a row mean the script can't load: give up on workers.
    // A single one may just be a heavy first file, so try a fresh worker once.
    if (earlyCrashes >= MAX_EARLY_CRASHES) failEverything();
    else dispatch();
    return;
  }

  if (task) {
    task.attempts++;
    if (task.attempts >= maxAttempts()) {
      task.reject(
        makeError(
          "The image processor crashed, usually because the image is too large for this device",
          "WORKER_CRASHED"
        )
      );
    } else {
      queues[task.type].unshift(task); // retry first, on a fresh worker
    }
  }
  dispatch();
}

function onTimeout(slot, task) {
  if (slot.task !== task) return; // already finished
  removeSlot(slot); // a hung worker can't be trusted; only this job is affected
  slot.task = null;
  task.reject(
    makeError(
      task.type === "thumb"
        ? "Preview took too long to generate"
        : "The image processor stopped responding and was stopped",
      "TIMEOUT"
    )
  );
  dispatch();
}

function createSlot() {
  let worker;
  try {
    // Keep this a classic worker (no { type: "module" }): heicDecode.js uses importScripts.
    worker = new Worker(new URL("./compress.worker.js", import.meta.url));
  } catch {
    failEverything();
    return null;
  }

  const slot = { worker, task: null, idleTimer: null, wasmJobs: 0 };

  worker.onmessage = ({ data }) => {
    if (!slots.has(slot)) return; // stale message from a terminated worker
    everResponded = true;
    const task = slot.task;
    if (!task || task.id !== data.id) return;
    release(slot);
    if (isHeavyWasmTask(task)) slot.wasmJobs++;
    if (data.ok) task.resolve(data.result);
    else task.reject(new Error(data.error));
    // Replace the worker after several heavy WASM jobs (HEIC or AVIF) so its WASM linear
    // memory starts fresh and never accumulates across a large batch.
    if (slot.wasmJobs >= maxWasmJobs()) removeSlot(slot);
    dispatch();
  };

  // Script failed to load, or an uncaught error crashed the worker.
  worker.onerror = (event) => {
    event?.preventDefault?.();
    if (slots.has(slot)) handleCrash(slot);
  };

  // A message could not be deserialized, so the job can't complete.
  worker.onmessageerror = () => {
    if (slots.has(slot)) handleCrash(slot);
  };

  slots.add(slot);
  return slot;
}

/* -------------------------------- scheduling ------------------------------ */

function run(slot, task) {
  clearTimeout(slot.idleTimer);
  slot.task = task;

  task.timer = setTimeout(() => onTimeout(slot, task), timeoutFor(task));

  try {
    slot.worker.postMessage({ id: task.id, type: task.type, ...task.payload });
  } catch (error) {
    // e.g. DataCloneError: the job itself is bad, not the worker.
    release(slot);
    task.reject(error);
  }
}

function dispatch() {
  if (workerBroken) return;
  const nextTask = queues.compress[0] || queues.thumb[0];
  if (!nextTask) return;

  const heavy = isHeavyWasmTask(nextTask);
  const max = getWorkerPoolSize({ heavy });

  for (;;) {
    const type = queues.compress.length ? "compress" : queues.thumb.length ? "thumb" : null;
    if (!type) return;

    let slot = null;
    for (const s of slots) {
      if (!s.task) {
        slot = s;
        break;
      }
    }
    if (!slot && slots.size < max) slot = createSlot();
    if (!slot || workerBroken) return; // pool is full (job stays queued) or workers unusable

    run(slot, queues[type].shift());
  }
}

// Returns a promise, or null when workers can't be used at all.
function runInWorker(type, payload) {
  if (!canUseWorkers()) return null;
  return new Promise((resolve, reject) => {
    queues[type].push({ id: nextId++, type, payload, resolve, reject, attempts: 0, timer: null });
    dispatch();
  });
}

async function runLocal(type, payload, mainThreadFallback) {
  const job = runInWorker(type, payload);
  if (job) {
    try {
      return await job;
    } catch (error) {
      if (error?.code !== "WORKER_FAILED") throw error;
    }
  }
  return mainThreadFallback();
}

/** @returns {Promise<{ blob: Blob, format: string }>} */
export function compressLocally(file, opts) {
  return runLocal("compress", { file, opts }, () => compressImage(file, opts));
}

/** @returns {Promise<Blob>} a small square JPEG preview */
export function thumbnailLocally(file, size = 160) {
  return runLocal("thumb", { file, size }, () => renderThumbnail(file, size));
}