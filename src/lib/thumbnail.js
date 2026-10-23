// Generates small square preview thumbnails so the queue never keeps full-size photos
// decoded in memory. A 10 MB photo becomes a ~5 KB preview. The decoding itself
// (including HEIC) happens in the Web Worker; this file only paces the requests.
import { clearPendingThumbnails, thumbnailLocally } from "./localCompress";
import { isMobileDevice } from "./device";

const THUMB = 160; // px, enough for crisp previews on 2x screens

let active = 0;
const queue = [];

function getMaxConcurrent() {
  // Phones run 1 worker, so sending more than 1 thumbnail at a time only traps extra
  // jobs in the worker queue where an AbortSignal can no longer skip them.
  return isMobileDevice() ? 1 : 2;
}

function pump() {
  const max = getMaxConcurrent();
  while (active < max && queue.length > 0) {
    const entry = queue.shift();
    active++;
    entry.run().finally(() => {
      active--;
      pump();
    });
  }
}

async function render(file) {
  const blob = await thumbnailLocally(file, THUMB);
  return URL.createObjectURL(blob);
}

/**
 * Cancels all waiting thumbnail jobs immediately (e.g. when clearing the queue).
 */
export function cancelAllThumbnails() {
  while (queue.length > 0) {
    const entry = queue.shift();
    entry.abort();
  }
  clearPendingThumbnails();
}

/**
 * @param {File} file
 * @param {{ signal?: AbortSignal }} [options] aborting skips the work if it hasn't started
 * @returns {Promise<string>} an object URL; the caller must revoke it
 */
export function makeThumbnail(file, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const entry = {
      abort: () => {
        reject(new DOMException("Aborted", "AbortError"));
      },
      run: async () => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        try {
          resolve(await render(file));
        } catch (error) {
          reject(error);
        }
      },
    };

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          const idx = queue.indexOf(entry);
          if (idx !== -1) {
            queue.splice(idx, 1);
            entry.abort();
          }
        },
        { once: true }
      );
    }

    queue.push(entry);
    pump();
  });
}