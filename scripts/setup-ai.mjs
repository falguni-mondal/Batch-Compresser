// Downloads the best open, ungated Offline AI models for PixShrink into `public/ai-models/`:
//   1. AI Background Removal: `onnx-community/ISNet-ONNX` (1024x1024 High-Precision DIS / RMBG-1.4 architecture)
//      (Also automatically removes the older `public/ai-models/Xenova/modnet` folder if present)
//   2. AI Image Upscaling (2x): `Xenova/swin2SR-lightweight-x2-64` (Swin2SR Vision Transformer 2x Super-Resolution)
//   3. AI Image Upscaling (4x): `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr` (Real-World BSRGAN Swin2SR 4x Super-Resolution)
//   4. Local Runtime: `@huggingface/transformers` v3.3.3 + ONNX WebAssembly SIMD runtime
//
// Usage:
//   npm run setup-ai
//   (or: node scripts/setup-ai.mjs)

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const AI_MODELS_ROOT = join(process.cwd(), "public", "ai-models");
const RUNTIME_ROOT = join(AI_MODELS_ROOT, "runtime");

// Legacy model to clean up automatically
const LEGACY_MODNET_DIR = join(AI_MODELS_ROOT, "Xenova", "modnet");

const MODELS = [
  {
    id: "onnx-community/ISNet-ONNX",
    title: "ISNet-ONNX (High-Precision 1024px AI Background Remover)",
    files: [
      { path: "config.json", required: true },
      { path: "preprocessor_config.json", required: true },
      { path: "onnx/model_quantized.onnx", required: true },
    ],
  },
  {
    id: "Xenova/swin2SR-lightweight-x2-64",
    title: "Swin2SR Lightweight 2x (AI Image Super-Resolution 2x)",
    files: [
      { path: "config.json", required: true },
      { path: "preprocessor_config.json", required: true },
      { path: "onnx/model_quantized.onnx", required: true },
    ],
  },
  {
    id: "Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr",
    title: "Swin2SR Real-World BSRGAN 4x (AI Detail-Restoring Super-Resolution 4x)",
    files: [
      { path: "config.json", required: true },
      { path: "preprocessor_config.json", required: true },
      { path: "onnx/model_quantized.onnx", required: true },
    ],
  },
];

const RUNTIME_FILES = [
  {
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js",
    dest: "transformers.min.js",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/ort-wasm-simd-threaded.jsep.mjs",
    dest: "ort-wasm-simd-threaded.jsep.mjs",
  },
  {
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/ort-wasm-simd-threaded.jsep.wasm",
    dest: "ort-wasm-simd-threaded.jsep.wasm",
  },
];

async function fetchWithSave(url, destPath, label) {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath) && statSync(destPath).size > 128) {
    const mb = (statSync(destPath).size / (1024 * 1024)).toFixed(2);
    console.log(`[setup-ai] Already exists: ${label} (${mb} MB)`);
    return;
  }
  console.log(`[setup-ai] Downloading ${label} ...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) for ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buffer);
  console.log(
    `[setup-ai] Saved ${label} (${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MB)`
  );
}

/**
 * Ensures Transformers.js v3 dtype lookups (`model_q8.onnx` and `model.onnx`) resolve
 * to `model_quantized.onnx` locally without 404 errors.
 */
function ensureOnnxAliases(targetDir) {
  const qPath = join(targetDir, "onnx", "model_quantized.onnx");
  if (!existsSync(qPath)) return;
  for (const alias of ["model_q8.onnx", "model.onnx"]) {
    const aliasPath = join(targetDir, "onnx", alias);
    if (!existsSync(aliasPath)) {
      try {
        copyFileSync(qPath, aliasPath);
      } catch {}
    }
  }
}

async function main() {
  console.log("====================================================================");
  console.log("[setup-ai] PixShrink Offline AI Suite Installer");
  console.log("  - BG Remover : onnx-community/ISNet-ONNX (1024px DIS/RMBG-1.4)");
  console.log("  - Upscale 2x : Xenova/swin2SR-lightweight-x2-64");
  console.log("  - Upscale 4x : Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr");
  console.log("====================================================================");

  if (existsSync(LEGACY_MODNET_DIR)) {
    try {
      rmSync(LEGACY_MODNET_DIR, { recursive: true, force: true });
      console.log("[setup-ai] Removed legacy Xenova/modnet model directory.");
    } catch (err) {
      console.warn("[setup-ai] Could not remove legacy modnet folder:", err.message);
    }
  }

  console.log("\n--- Step 1: Downloading Local Transformers.js & ONNX WASM Runtime ---");
  for (const item of RUNTIME_FILES) {
    try {
      await fetchWithSave(
        item.url,
        join(RUNTIME_ROOT, item.dest),
        `runtime/${item.dest}`
      );
    } catch (err) {
      console.warn(`[setup-ai] Runtime file ${item.dest} skipped: ${err.message}`);
    }
  }

  for (const model of MODELS) {
    console.log(`\n--- Downloading ${model.title} ---`);
    const baseUrl = `https://huggingface.co/${model.id}/resolve/main`;
    const targetDir = join(AI_MODELS_ROOT, ...model.id.split("/"));

    for (const file of model.files) {
      const url = `${baseUrl}/${file.path}`;
      const dest = join(targetDir, file.path);
      try {
        await fetchWithSave(url, dest, `${model.id}/${file.path}`);
      } catch (err) {
        if (file.required) {
          throw err;
        }
        console.warn(`[setup-ai] Optional file ${file.path} skipped: ${err.message}`);
      }
    }
    ensureOnnxAliases(targetDir);
  }

  console.log("\n====================================================================");
  console.log("[setup-ai] All Offline AI models & WASM runtimes are ready!");
  console.log("[setup-ai] Location: public/ai-models/");
  console.log("[setup-ai] Start PixShrink with: npm run dev");
  console.log("====================================================================");
}

main().catch((err) => {
  console.error("\n[setup-ai] Error:", err.message);
  process.exit(1);
});
