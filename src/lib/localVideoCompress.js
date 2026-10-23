// 100% Local In-Browser Video Compressor (up to 4K/2K/1080p/720p) & WhatsApp Status Splitter.

import { readBytesWithRetry } from "./fileStore";
import { getVideoLimits, getWhatsappStatusLimits } from "./device";

const FORMAT_CANDIDATES = {
  mp4: [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
  ],
  webm: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
  ],
};

export function getSupportedVideoFormats() {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return { mp4: false, webm: false };
  }
  const check = (list) =>
    list.some((mime) => {
      try {
        return MediaRecorder.isTypeSupported(mime);
      } catch {
        return false;
      }
    });
  return {
    mp4: check(FORMAT_CANDIDATES.mp4),
    webm: check(FORMAT_CANDIDATES.webm),
  };
}

function pickSupportedMime(format) {
  if (typeof MediaRecorder === "undefined") return "";
  const primary = FORMAT_CANDIDATES[format] || FORMAT_CANDIDATES.webm;
  for (const mime of primary) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {}
  }
  return "";
}

export async function probeVideoMetadata(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      const timer = setTimeout(() => {
        reject(new Error("Timed out reading video metadata"));
      }, 10000);

      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve({
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        });
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Browser cannot decode "${file.name}"`));
      };
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressVideoLocally(
  file,
  {
    maxHeight = 1080,
    videoBitrate = 2_500_000,
    fps = 30,
    format = "mp4",
    muteAudio = false,
    onProgress,
    signal,
  } = {}
) {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support local video recording/encoding");
  }

  let outFormat = format;
  let mimeType = pickSupportedMime(outFormat);
  if (!mimeType) {
    outFormat = outFormat === "mp4" ? "webm" : "mp4";
    mimeType = pickSupportedMime(outFormat);
  }
  if (!mimeType) {
    throw new Error("No supported local video encoder found in this browser");
  }

  const limits = getVideoLimits();
  if (file.size > limits.maxFileBytes) {
    throw new Error(
      `"${file.name}" exceeds the ${limits.maxFileMB} MB limit for local video compression on this device.`
    );
  }

  const buffer = await readBytesWithRetry(file);
  const safeBlob = new Blob([buffer], { type: file.type || "video/mp4" });
  const sourceUrl = URL.createObjectURL(safeBlob);

  let canvas = null;
  let audioCtx = null;

  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = sourceUrl;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.muted = muteAudio;
      video.volume = muteAudio ? 0 : 0.0001;

      let rafId = null;
      let recorder = null;
      let settled = false;

      const cleanup = () => {
        if (rafId) cancelAnimationFrame(rafId);
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {}
        try {
          if (recorder && recorder.state !== "inactive") recorder.stop();
        } catch {}
        try {
          audioCtx?.close?.();
        } catch {}
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      if (signal) {
        if (signal.aborted) {
          fail(Object.assign(new Error("Video compression cancelled"), { code: "CANCELLED" }));
          return;
        }
        signal.addEventListener(
          "abort",
          () =>
            fail(Object.assign(new Error("Video compression cancelled"), { code: "CANCELLED" })),
          { once: true }
        );
      }

      video.onerror = () => {
        fail(new Error(`Could not play or decode "${file.name}" in this browser`));
      };

      video.onloadedmetadata = async () => {
        try {
          const duration =
            Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          if (duration > limits.maxDurationSec) {
            fail(
              new Error(
                `"${file.name}" is ${Math.round(duration)}s long (limit is ${limits.maxDurationSec}s on this device).`
              )
            );
            return;
          }

          const srcW = video.videoWidth || 1920;
          const srcH = video.videoHeight || 1080;
          const targetShortSide = Math.min(Number(maxHeight) || 1080, limits.maxHeightPx);

          // Scale by shorter side (so 16:9 3840x2160 has short side 2160 = 4K, 2560x1440 = 2K, 1920x1080 = 1080p)
          const minDim = Math.min(srcW, srcH);
          const scale = minDim > targetShortSide ? targetShortSide / minDim : 1;
          const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
          const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);

          canvas = document.createElement("canvas");
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext("2d", { alpha: false });
          ctx.imageSmoothingQuality = "medium";

          const targetFps = Math.min(60, Math.max(15, Number(fps) || 30));
          const canvasStream = canvas.captureStream(targetFps);
          const combinedTracks = [...canvasStream.getVideoTracks()];

          if (!muteAudio) {
            try {
              if (typeof video.captureStream === "function") {
                const vStream = video.captureStream();
                const aTracks = vStream.getAudioTracks();
                if (aTracks.length > 0) combinedTracks.push(aTracks[0]);
              } else if (
                typeof AudioContext !== "undefined" ||
                typeof webkitAudioContext !== "undefined"
              ) {
                const AC = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AC();
                const sourceNode = audioCtx.createMediaElementSource(video);
                const destNode = audioCtx.createMediaStreamDestination();
                sourceNode.connect(destNode);
                const aTracks = destNode.stream.getAudioTracks();
                if (aTracks.length > 0) combinedTracks.push(aTracks[0]);
              }
            } catch {}
          }

          const outStream = new MediaStream(combinedTracks);
          const chunks = [];

          recorder = new MediaRecorder(outStream, {
            mimeType,
            videoBitsPerSecond: Math.max(250_000, Number(videoBitrate) || 2_500_000),
            audioBitsPerSecond: muteAudio ? undefined : 128_000,
          });

          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };

          recorder.onerror = (e) => {
            fail(e?.error || new Error("Video encoder failed during recording"));
          };

          recorder.onstop = () => {
            if (settled) return;
            settled = true;
            cleanup();
            const outBlob = new Blob(chunks, {
              type: mimeType.split(";")[0] || `video/${outFormat}`,
            });
            if (!outBlob || outBlob.size === 0) {
              reject(new Error("Video encoder produced an empty file"));
              return;
            }
            resolve({
              blob: outBlob,
              format: outFormat,
              width: outW,
              height: outH,
              duration,
            });
          };

          const drawFrame = () => {
            if (settled) return;
            if (!video.paused && !video.ended) {
              ctx.drawImage(video, 0, 0, outW, outH);
              if (duration > 0 && onProgress) {
                onProgress(Math.min(99, Math.round((video.currentTime / duration) * 100)));
              }
              rafId = requestAnimationFrame(drawFrame);
            }
          };

          video.onended = () => {
            onProgress?.(100);
            if (recorder && recorder.state !== "inactive") {
              recorder.stop();
            }
          };

          recorder.start(250);
          await video.play();
          drawFrame();
        } catch (err) {
          fail(err);
        }
      };
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function splitVideoForWhatsappLocally(
  file,
  {
    clipDurationSec = 30,
    maxHeight = 720,
    videoBitrate = 1_500_000,
    fps = 30,
    format = "mp4",
    muteAudio = false,
    onProgress,
    signal,
  } = {}
) {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support local video recording/splitting");
  }

  let outFormat = format;
  let mimeType = pickSupportedMime(outFormat);
  if (!mimeType) {
    outFormat = outFormat === "mp4" ? "webm" : "mp4";
    mimeType = pickSupportedMime(outFormat);
  }
  if (!mimeType) {
    throw new Error("No supported local video encoder found in this browser");
  }

  const limits = getWhatsappStatusLimits();
  if (file.size > limits.maxFileBytes) {
    throw new Error(
      `"${file.name}" exceeds the ${limits.maxFileMB} MB limit for WhatsApp Status splitting on this device.`
    );
  }

  const buffer = await readBytesWithRetry(file);
  const safeBlob = new Blob([buffer], { type: file.type || "video/mp4" });
  const sourceUrl = URL.createObjectURL(safeBlob);

  let canvas = null;
  let audioCtx = null;

  try {
    return await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.src = sourceUrl;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.muted = muteAudio;
      video.volume = muteAudio ? 0 : 0.0001;

      let rafId = null;
      let activeRecorder = null;
      let settled = false;
      const partPromises = [];

      const cleanup = () => {
        if (rafId) cancelAnimationFrame(rafId);
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {}
        try {
          if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
        } catch {}
        try {
          audioCtx?.close?.();
        } catch {}
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      if (signal) {
        if (signal.aborted) {
          fail(Object.assign(new Error("Cancelled"), { code: "CANCELLED" }));
          return;
        }
        signal.addEventListener(
          "abort",
          () => fail(Object.assign(new Error("Cancelled"), { code: "CANCELLED" })),
          { once: true }
        );
      }

      video.onerror = () => {
        fail(new Error(`Could not decode "${file.name}" in this browser`));
      };

      video.onloadedmetadata = async () => {
        try {
          const duration =
            Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          if (duration > limits.maxDurationSec) {
            fail(
              new Error(
                `"${file.name}" is ${Math.round(duration)}s long (limit is ${limits.maxDurationSec}s on this device).`
              )
            );
            return;
          }

          const clipLen = Math.max(5, Math.min(120, Number(clipDurationSec) || 30));
          const totalParts = Math.max(1, Math.ceil((duration - 0.15) / clipLen));

          const srcW = video.videoWidth || 720;
          const srcH = video.videoHeight || 1280;
          const targetShortSide = Math.min(Number(maxHeight) || 720, 1080);
          const minDim = Math.min(srcW, srcH);
          const scale = minDim > targetShortSide ? targetShortSide / minDim : 1;
          const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
          const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);

          canvas = document.createElement("canvas");
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext("2d", { alpha: false });
          ctx.imageSmoothingQuality = "medium";

          const targetFps = Math.min(60, Math.max(15, Number(fps) || 30));
          const canvasStream = canvas.captureStream(targetFps);
          const combinedTracks = [...canvasStream.getVideoTracks()];

          if (!muteAudio) {
            try {
              if (typeof video.captureStream === "function") {
                const vStream = video.captureStream();
                const aTracks = vStream.getAudioTracks();
                if (aTracks.length > 0) combinedTracks.push(aTracks[0]);
              } else if (
                typeof AudioContext !== "undefined" ||
                typeof webkitAudioContext !== "undefined"
              ) {
                const AC = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AC();
                const sourceNode = audioCtx.createMediaElementSource(video);
                const destNode = audioCtx.createMediaStreamDestination();
                sourceNode.connect(destNode);
                const aTracks = destNode.stream.getAudioTracks();
                if (aTracks.length > 0) combinedTracks.push(aTracks[0]);
              }
            } catch {}
          }

          const outStream = new MediaStream(combinedTracks);
          let currentPartIndex = 0;
          let nextSplitTime = clipLen;

          const startNewPartRecorder = (partIdx, startSec) => {
            const chunks = [];
            const rec = new MediaRecorder(outStream, {
              mimeType,
              videoBitsPerSecond: Math.max(300_000, Number(videoBitrate) || 1_500_000),
              audioBitsPerSecond: muteAudio ? undefined : 128_000,
            });
            rec.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) chunks.push(e.data);
            };
            const partDone = new Promise((resPart, rejPart) => {
              rec.onerror = (e) =>
                rejPart(e?.error || new Error(`Failed recording status part ${partIdx + 1}`));
              rec.onstop = () => {
                const endSec = Math.min(duration, video.currentTime || (partIdx + 1) * clipLen);
                const blob = new Blob(chunks, {
                  type: mimeType.split(";")[0] || `video/${outFormat}`,
                });
                resPart({
                  partNumber: partIdx + 1,
                  totalParts,
                  startSec: Math.round(startSec),
                  endSec: Math.max(Math.round(startSec) + 1, Math.round(endSec)),
                  blob,
                  format: outFormat,
                  width: outW,
                  height: outH,
                });
              };
            });
            partPromises.push(partDone);
            rec.start(200);
            activeRecorder = rec;
          };

          const drawFrame = () => {
            if (settled) return;
            if (!video.paused && !video.ended) {
              ctx.drawImage(video, 0, 0, outW, outH);
              const nowSec = video.currentTime;

              if (duration > 0 && onProgress) {
                onProgress({
                  percent: Math.min(99, Math.round((nowSec / duration) * 100)),
                  partNumber: currentPartIndex + 1,
                  totalParts,
                });
              }

              if (nowSec >= nextSplitTime && duration - nowSec > 0.35) {
                const prevRec = activeRecorder;
                currentPartIndex++;
                const partStart = nextSplitTime;
                nextSplitTime += clipLen;
                startNewPartRecorder(currentPartIndex, partStart);
                try {
                  if (prevRec && prevRec.state !== "inactive") prevRec.stop();
                } catch {}
              }

              rafId = requestAnimationFrame(drawFrame);
            }
          };

          video.onended = async () => {
            try {
              if (activeRecorder && activeRecorder.state !== "inactive") {
                activeRecorder.stop();
              }
              const parts = await Promise.all(partPromises);
              if (settled) return;
              settled = true;
              cleanup();
              onProgress?.({ percent: 100, partNumber: parts.length, totalParts: parts.length });
              resolve({
                parts: parts.filter((p) => p.blob && p.blob.size > 0),
                format: outFormat,
                width: outW,
                height: outH,
                duration,
              });
            } catch (err) {
              fail(err);
            }
          };

          startNewPartRecorder(0, 0);
          await video.play();
          drawFrame();
        } catch (err) {
          fail(err);
        }
      };
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
