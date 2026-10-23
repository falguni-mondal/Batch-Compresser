// High-Precision Offline AI Background Remover powered by `onnx-community/ISNet-ONNX`
// (1024x1024 Dichotomous Image Segmentation / RMBG-1.4 DIS architecture)
// + Fast Studio Chroma Key Fallback.
//
// Why `onnx-community/ISNet-ONNX`?
//  - Unlike portrait-only 512px models (like MODNet), ISNet operates at 1024x1024 with
//    intermediate supervision across multi-scale feature maps, cleanly separating fine hair
//    strands, glasses, clothing, products, animals, and portraits from complex backgrounds.
//  - 100% open & ungated. After running `npm run setup-ai`, the model and WASM runtime
//    load straight from `public/ai-models/onnx-community/ISNet-ONNX/` completely offline.

import {
  MIME,
  canEncode,
  canvasToBlob,
  clampDimensions,
  decodeBitmap,
  makeCanvas,
} from "./encodeCore";
import { getBgRemoveLimits } from "./device";

const TRANSFORMERS_CDN =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js";
const LOCAL_RUNTIME_URL = "/ai-models/runtime/transformers.min.js";
const LOCAL_RUNTIME_DIR = "/ai-models/runtime/";
const LOCAL_MODEL_BASE = "/ai-models/";
export const BG_AI_MODEL_ID = "onnx-community/ISNet-ONNX";

let aiPipelinePromise = null;

async function urlExists(url) {
  if (typeof fetch === "undefined") return false;
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Loads the Transformers.js AI segmentation model (`onnx-community/ISNet-ONNX`)
 * either from local `/ai-models/` (100% offline after `npm run setup-ai`) or from
 * HuggingFace CDN (cached in browser CacheStorage).
 */
export async function loadAiMattingEngine(onStatus) {
  if (!aiPipelinePromise) {
    const promise = (async () => {
      onStatus?.("Loading ISNet 1024px AI neural engine…");

      const [hasLocalRuntime, hasLocalModel] = await Promise.all([
        urlExists(LOCAL_RUNTIME_URL),
        urlExists(`${LOCAL_MODEL_BASE}${BG_AI_MODEL_ID}/config.json`),
      ]);

      const runtimeUrl = hasLocalRuntime ? LOCAL_RUNTIME_URL : TRANSFORMERS_CDN;
      const tf = await import(/* webpackIgnore: true */ runtimeUrl);
      const { AutoModel, AutoProcessor, RawImage, env } = tf;

      env.useBrowserCache = true;
      if (hasLocalRuntime && env?.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = LOCAL_RUNTIME_DIR;
      }

      if (hasLocalModel) {
        env.localModelPath = LOCAL_MODEL_BASE;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
      } else {
        env.allowLocalModels = false;
        env.allowRemoteModels = true;
      }

      onStatus?.(
        hasLocalModel
          ? "Initializing offline ISNet-ONNX model from /ai-models/…"
          : "Downloading ISNet-ONNX model (cached for offline use after 1st run)…"
      );

      const loadModel = async () => {
        try {
          return await AutoModel.from_pretrained(BG_AI_MODEL_ID, {
            dtype: "q8",
            quantized: true,
          });
        } catch {
          return await AutoModel.from_pretrained(BG_AI_MODEL_ID, {
            dtype: "fp32",
            quantized: false,
          });
        }
      };

      const [model, processor] = await Promise.all([
        loadModel(),
        AutoProcessor.from_pretrained(BG_AI_MODEL_ID),
      ]);

      return { model, processor, RawImage, isOfflineLocal: hasLocalModel };
    })();

    aiPipelinePromise = promise;
    promise.catch(() => {
      if (aiPipelinePromise === promise) aiPipelinePromise = null;
    });
  }
  return aiPipelinePromise;
}

/**
 * Runs `onnx-community/ISNet-ONNX` on `workCanvas` and writes the high-resolution
 * alpha mask into the RGBA alpha channel with edge color decontamination.
 */
export async function runNeuralMattingOnCanvas(workCanvas, targetW, targetH, onStatus) {
  const { model, processor, RawImage } = await loadAiMattingEngine(onStatus);
  onStatus?.("Running ISNet 1024px foreground segmentation…");

  const srcBlob = await canvasToBlob(workCanvas, "image/png", 1);
  const rawImg = await RawImage.fromBlob(srcBlob);
  const { pixel_values } = await processor(rawImg);
  const { output } = await model({ input: pixel_values });

  // Extract first mask tensor from ISNet output and normalize [min..max] -> [0..255]
  const maskTensor = output[0].mul(255).to("uint8");
  const maskImage = await RawImage.fromTensor(maskTensor).resize(targetW, targetH);
  const maskData = maskImage.data;

  const ctx = workCanvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const rgba = imgData.data;

  // Compute dynamic min/max for crisp foreground/background contrast
  let minV = 255;
  let maxV = 0;
  const totalPx = targetW * targetH;
  for (let i = 0; i < totalPx; i++) {
    const v = maskData[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const span = Math.max(1, maxV - minV);

  for (let i = 0; i < totalPx; i++) {
    // Stretch & apply slight S-curve around mid-alpha to eliminate background haze
    let norm = (maskData[i] - minV) / span;
    if (norm < 0.06) norm = 0;
    else if (norm > 0.94) norm = 1;
    else norm = (norm - 0.06) / 0.88;
    rgba[i * 4 + 3] = Math.round(norm * 255);
  }
  ctx.putImageData(imgData, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Fast Studio / Chroma Key Fallback & Alpha Post-Processing          */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const clean = String(hex || "#ffffff").replace("#", "").trim();
  const num = parseInt(
    clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean,
    16
  );
  if (Number.isNaN(num)) return [255, 255, 255];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
}

function sampleBorderPalette(data, w, h) {
  const samples = [];
  const stepX = Math.max(1, Math.floor(w / 32));
  const stepY = Math.max(1, Math.floor(h / 32));

  const pushPx = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] > 32) {
      samples.push([data[i], data[i + 1], data[i + 2]]);
    }
  };

  for (let x = 0; x < w; x += stepX) {
    pushPx(x, 0);
    pushPx(x, h - 1);
  }
  for (let y = 0; y < h; y += stepY) {
    pushPx(0, y);
    pushPx(w - 1, y);
  }

  if (samples.length === 0) return [[255, 255, 255]];

  const clusters = [];
  for (const [r, g, b] of samples) {
    let matched = null;
    for (const c of clusters) {
      if (colorDist(r, g, b, c.r, c.g, c.b) < 18) {
        matched = c;
        break;
      }
    }
    if (matched) {
      matched.count++;
      matched.r += (r - matched.r) / matched.count;
      matched.g += (g - matched.g) / matched.count;
      matched.b += (b - matched.b) / matched.count;
    } else {
      clusters.push({ r, g, b, count: 1 });
    }
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters
    .slice(0, 4)
    .map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)]);
}

function minPaletteDist(r, g, b, palette) {
  let best = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = colorDist(r, g, b, p[0], p[1], p[2]);
    if (d < best) best = d;
  }
  return best;
}

export function featherAlphaChannel(data, w, h, radius) {
  const r = Math.min(6, Math.max(0, Math.round(radius)));
  if (r <= 0) return;

  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];

  const temp = new Uint8Array(w * h);
  const diam = r * 2 + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = r; x < w - r; x++) {
      const a = alpha[row + x];
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += alpha[row + x + k];
      const avg = Math.round(sum / diam);
      temp[row + x] = a === 255 && avg > 240 ? 255 : avg;
    }
  }

  for (let y = r; y < h - r; y++) {
    const row = y * w;
    for (let x = r; x < w - r; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += temp[(y + k) * w + x];
      const avg = Math.round(sum / diam);
      const orig = alpha[row + x];
      data[(row + x) * 4 + 3] = orig === 255 && avg > 230 ? 255 : avg;
    }
  }
}

export function runStudioSegmentation(
  workCanvas,
  targetW,
  targetH,
  mode,
  keyColor,
  tolerance,
  feather
) {
  const ctx = workCanvas.getContext("2d");
  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const { data } = imgData;
  const total = targetW * targetH;

  const tol =
    4 + (Math.max(1, Math.min(100, Number(tolerance) || 32)) / 100) * 110;
  const softBand = Math.max(8, tol * 0.35);

  if (mode === "color") {
    const [kr, kg, kb] = hexToRgb(keyColor);
    for (let i = 0; i < total; i++) {
      const idx = i * 4;
      const d = colorDist(data[idx], data[idx + 1], data[idx + 2], kr, kg, kb);
      if (d <= tol) {
        data[idx + 3] = 0;
      } else if (d < tol + softBand) {
        const factor = (d - tol) / softBand;
        data[idx + 3] = Math.round(data[idx + 3] * factor);
      }
    }
  } else {
    const palette = sampleBorderPalette(data, targetW, targetH);
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;

    const trySeed = (pIdx) => {
      if (visited[pIdx]) return;
      const idx = pIdx * 4;
      const d = minPaletteDist(data[idx], data[idx + 1], data[idx + 2], palette);
      if (d <= tol + softBand) {
        visited[pIdx] = 1;
        queue[tail++] = pIdx;
      }
    };

    for (let x = 0; x < targetW; x++) {
      trySeed(x);
      trySeed((targetH - 1) * targetW + x);
    }
    for (let y = 1; y < targetH - 1; y++) {
      trySeed(y * targetW);
      trySeed(y * targetW + (targetW - 1));
    }

    while (head < tail) {
      const pIdx = queue[head++];
      const idx = pIdx * 4;
      const d = minPaletteDist(data[idx], data[idx + 1], data[idx + 2], palette);

      if (d <= tol) {
        data[idx + 3] = 0;
      } else {
        const factor = (d - tol) / softBand;
        data[idx + 3] = Math.round(
          data[idx + 3] * Math.min(1, Math.max(0, factor))
        );
        continue;
      }

      const x = pIdx % targetW;
      const y = (pIdx - x) / targetW;
      const neighbors = [];
      if (x > 0) neighbors.push(pIdx - 1);
      if (x < targetW - 1) neighbors.push(pIdx + 1);
      if (y > 0) neighbors.push(pIdx - targetW);
      if (y < targetH - 1) neighbors.push(pIdx + targetW);

      for (let k = 0; k < neighbors.length; k++) {
        const n = neighbors[k];
        if (!visited[n]) {
          const ni = n * 4;
          if (
            minPaletteDist(data[ni], data[ni + 1], data[ni + 2], palette) <=
            tol + softBand
          ) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }
    }
  }

  if (feather > 0) {
    featherAlphaChannel(data, targetW, targetH, feather);
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Removes the background from `file` and returns a transparent HTMLCanvasElement / OffscreenCanvas
 * (used by both the BG Remover tool and the Passport Image studio).
 */
export async function extractSubjectCanvas(
  file,
  {
    mode = "ai",
    keyColor = "#ffffff",
    tolerance = 32,
    feather = 1,
    onStatus,
  } = {}
) {
  const limits = getBgRemoveLimits();
  const bitmap = await decodeBitmap(file);

  try {
    const { width: targetW, height: targetH } = clampDimensions(
      bitmap.width,
      bitmap.height,
      (limits.maxOutputPx * limits.maxOutputPx) / 1e6,
      limits.maxOutputPx
    );

    const workCanvas = makeCanvas(targetW, targetH);
    const ctx = workCanvas.getContext("2d");
    if (!ctx) throw new Error("Could not initialize canvas on this device");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    let usedAi = false;
    if (mode === "ai") {
      try {
        await runNeuralMattingOnCanvas(workCanvas, targetW, targetH, onStatus);
        usedAi = true;
        if (feather > 0) {
          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          featherAlphaChannel(imgData.data, targetW, targetH, feather);
          ctx.putImageData(imgData, 0, 0);
        }
      } catch (aiErr) {
        console.warn(
          "ISNet AI segmentation fell back to Studio Border mode:",
          aiErr?.message
        );
        runStudioSegmentation(
          workCanvas,
          targetW,
          targetH,
          "auto",
          keyColor,
          tolerance,
          feather
        );
      }
    } else {
      runStudioSegmentation(
        workCanvas,
        targetW,
        targetH,
        mode,
        keyColor,
        tolerance,
        feather
      );
    }

    return { canvas: workCanvas, width: targetW, height: targetH, usedAi };
  } finally {
    bitmap.close?.();
  }
}

/**
 * @param {File} file
 * @param {{ mode?: "ai"|"auto"|"color", keyColor?: string, tolerance?: number,
 *           feather?: number, bgFill?: "transparent"|"white"|"black"|"custom",
 *           customBgColor?: string, format?: "png"|"webp",
 *           onStatus?: (msg: string) => void }} opts
 */
export async function removeBackgroundLocally(
  file,
  {
    mode = "ai",
    keyColor = "#ffffff",
    tolerance = 32,
    feather = 1,
    bgFill = "transparent",
    customBgColor = "#FF5500",
    format = "png",
    onStatus,
  } = {}
) {
  const outFormat =
    format === "webp" && (await canEncode("webp")) ? "webp" : "png";
  const mime = MIME[outFormat];

  let workCanvas = null;
  let outCanvas = null;

  try {
    const res = await extractSubjectCanvas(file, {
      mode,
      keyColor,
      tolerance,
      feather,
      onStatus,
    });
    workCanvas = res.canvas;
    const { width: targetW, height: targetH, usedAi } = res;

    let targetCanvas = workCanvas;
    if (bgFill !== "transparent") {
      outCanvas = makeCanvas(targetW, targetH);
      const outCtx = outCanvas.getContext("2d");
      outCtx.fillStyle =
        bgFill === "white"
          ? "#ffffff"
          : bgFill === "black"
          ? "#111111"
          : customBgColor || "#ffffff";
      outCtx.fillRect(0, 0, targetW, targetH);
      outCtx.drawImage(workCanvas, 0, 0);
      targetCanvas = outCanvas;
    }

    const blob = await canvasToBlob(targetCanvas, mime, 0.92);
    if (!blob || blob.size === 0)
      throw new Error("Failed to encode background-removed image");

    return {
      blob,
      format: outFormat,
      width: targetW,
      height: targetH,
      usedAi,
    };
  } finally {
    if (workCanvas) workCanvas.width = workCanvas.height = 0;
    if (outCanvas) outCanvas.width = outCanvas.height = 0;
  }
}
