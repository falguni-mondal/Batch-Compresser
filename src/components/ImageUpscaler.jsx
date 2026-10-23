"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import ImageDropzone from "@/components/ImageDropzone";
import { LoadingOverlay } from "@/components/PixelLoader";
import {
  Segmented,
  StepLabel,
  formatBytes,
  labelCls,
  stripExt,
} from "@/components/StepHeader";
import { UPSCALE_LIMITS, getUpscaleLimits, isMobileDevice } from "@/lib/device";
import { getStashedFile, stash, unstash } from "@/lib/fileStore";
import { upscaleLocally } from "@/lib/localUpscale";

const UPSCALE_FACTORS = [
  { value: 2, label: "2× Super-Res" },
  { value: 4, label: "4× Ultra-Res" },
];

const UPSCALE_MODES = [
  { value: "ai", label: "AI Detail Revival" },
  { value: "photo", label: "Natural Photo" },
  { value: "anime", label: "Anime / Art" },
  { value: "pixel", label: "Pixel Art" },
];

const UPSCALE_FORMATS = [
  { value: "webp", label: "WebP" },
  { value: "png", label: "PNG (Lossless)" },
  { value: "jpeg", label: "JPG" },
];

let idCounter = 0;
const makeId = () => `up-${Date.now()}-${idCounter++}`;
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ImageUpscaler = memo(function ImageUpscaler() {
  const [files, setFiles] = useState([]);
  const [adding, setAdding] = useState(null);
  const [scale, setScale] = useState(2);
  const [mode, setMode] = useState("ai");
  const [sharpness, setSharpness] = useState(70);
  const [denoise, setDenoise] = useState(35);
  const [format, setFormat] = useState("webp");
  const [showAiGuide, setShowAiGuide] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [results, setResults] = useState([]);
  const [zipDownload, setZipDownload] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const urlsRef = useRef([]);
  const filesRef = useRef([]);
  const [limits, setLimits] = useState(UPSCALE_LIMITS.desktop);
  useEffect(() => {
    setLimits(getUpscaleLimits());
  }, []);

  const commitFiles = useCallback((updater) => {
    const next = updater(filesRef.current);
    filesRef.current = next;
    setFiles(next);
  }, []);

  const revokeUrls = useCallback(() => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  }, []);

  useEffect(
    () => () => {
      revokeUrls();
      filesRef.current.forEach((f) => unstash(f.id));
    },
    [revokeUrls]
  );

  // Immediately stash picked files into RAM on selection so Android content:// handles
  // never expire with NotReadableError when the user taps Upscale later.
  const handleFilesAdded = useCallback(
    async (incoming) => {
      const limit = isMobileDevice() ? 8 : 25;
      const current = filesRef.current;
      const seen = new Set(current.filter((f) => !f.broken).map((f) => f.key));
      const accepted = [];

      for (const file of incoming) {
        if (current.length + accepted.length >= limit) break;
        const k = fileKey(file);
        if (seen.has(k)) continue;
        seen.add(k);
        accepted.push({
          id: makeId(),
          key: k,
          file,
          ready: false, // Wait until stashed in RAM before thumbnail reads it
          broken: false,
        });
      }

      if (!accepted.length) return;

      commitFiles((prev) => [...prev, ...accepted]);
      revokeUrls();
      setResults([]);
      setZipDownload(null);
      setErrorMsg("");

      setAdding({ done: 0, total: accepted.length });
      let done = 0;

      for (const item of accepted) {
        try {
          const stashedFile = await stash(item.id, item.file);
          commitFiles((prev) =>
            prev.map((f) =>
              f.id === item.id ? { ...f, file: stashedFile, ready: true } : f
            )
          );
        } catch {
          commitFiles((prev) =>
            prev.map((f) =>
              f.id === item.id ? { ...f, broken: true, ready: false } : f
            )
          );
        }
        done++;
        setAdding({ done, total: accepted.length });
      }
      setAdding(null);
    },
    [commitFiles, revokeUrls]
  );

  const handleRemoveFile = useCallback(
    (id) => {
      unstash(id);
      commitFiles((prev) => prev.filter((f) => f.id !== id));
    },
    [commitFiles]
  );

  const handleClearAll = useCallback(() => {
    filesRef.current.forEach((f) => unstash(f.id));
    commitFiles(() => []);
    revokeUrls();
    setResults([]);
    setZipDownload(null);
    setErrorMsg("");
  }, [commitFiles, revokeUrls]);

  const handleRunUpscale = async () => {
    const validFiles = files.filter((f) => !f.broken);
    if (!validFiles.length || isProcessing || adding) return;
    setIsProcessing(true);
    setProgress(0);
    setDoneCount(0);
    setStatusText("Initializing Super-Resolution & Detail Revival…");
    setErrorMsg("");
    revokeUrls();
    setResults([]);
    setZipDownload(null);

    const outItems = [];
    try {
      for (let i = 0; i < validFiles.length; i++) {
        const item = validFiles[i];
        await sleep(0);
        const safeFile = getStashedFile(item.id, item.file);
        const res = await upscaleLocally(safeFile, {
          scale,
          mode,
          sharpness,
          denoise,
          format,
          quality: 0.94,
          onStatus: (msg) => setStatusText(msg),
        });
        const ext =
          res.format === "jpeg" || res.format === "jpg" ? "jpg" : res.format;
        const outName = `${stripExt(item.file.name)}_${scale}x.${ext}`;
        const url = URL.createObjectURL(res.blob);
        urlsRef.current.push(url);
        outItems.push({
          id: item.id,
          name: outName,
          blob: res.blob,
          url,
          size: res.blob.size,
          origSize: item.file.size,
          origWidth: res.origWidth,
          origHeight: res.origHeight,
          width: res.width,
          height: res.height,
          usedAi: res.usedAi,
        });
        setDoneCount(i + 1);
        setProgress(Math.round(((i + 1) / validFiles.length) * 100));
      }

      if (outItems.length > 1) {
        const zip = new JSZip();
        for (const it of outItems) {
          zip.file(it.name, it.blob, { compression: "STORE" });
        }
        const zBlob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
        });
        const zUrl = URL.createObjectURL(zBlob);
        urlsRef.current.push(zUrl);
        setZipDownload({
          name: `pixshrink_upscaled_${scale}x.zip`,
          url: zUrl,
          size: zBlob.size,
        });
      }

      setResults(outItems);
      if (outItems.length === 1) {
        const a = document.createElement("a");
        a.href = outItems[0].url;
        a.download = outItems[0].name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      setErrorMsg(err?.message || "Failed to upscale images");
    } finally {
      setIsProcessing(false);
    }
  };

  const maxMP = limits.maxOutputMP || limits.maxOutputMp || 16;

  return (
    <div className="space-y-12 sm:space-y-20">
      {isProcessing && (
        <LoadingOverlay
          title={`Upscaling ${scale}× & Reviving Details`}
          detail={`${doneCount} of ${files.length} completed · ${statusText}`}
          progress={progress}
        />
      )}

      <section>
        <StepLabel n={1}>Add images to upscale</StepLabel>
        <ImageDropzone
          files={files}
          adding={adding}
          onFilesAdded={handleFilesAdded}
          onRemoveFile={handleRemoveFile}
          onClearAll={handleClearAll}
        />
      </section>

      <section>
        <StepLabel n={2}>Super-Resolution & detail settings</StepLabel>
        {/* Static shadow (NOT .neo-shadow) so clicking inside settings never shifts/animates the box */}
        <div className="w-full space-y-6 rounded-none border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-8 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl">
          <div>
            <div className={labelCls}>
              <span>Upscale Factor</span>
              <span className="font-mono text-[11px] font-bold text-neutral-500">
                Up to {limits.maxOutputPx}px ({maxMP} MP)
              </span>
            </div>
            <Segmented
              options={UPSCALE_FACTORS}
              value={scale}
              onChange={setScale}
            />
          </div>

          <div className="border-t-2 border-neutral-100 pt-5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-black uppercase tracking-widest text-neutral-900">
                Detail Revival Mode
              </span>
              <button
                type="button"
                onClick={() => setShowAiGuide((v) => !v)}
                className="cursor-pointer border border-neutral-900 bg-[#FFE600] px-2 py-0.5 font-mono text-[10px] font-black uppercase text-neutral-900"
              >
                {showAiGuide ? "Hide AI Info" : "How Detail Revival Works"}
              </button>
            </div>
            <Segmented
              options={UPSCALE_MODES}
              value={mode}
              onChange={setMode}
            />
            <p className="mt-2 text-[11px] font-medium text-neutral-500">
              {mode === "ai"
                ? "Combines Swin2SR neural synthesis with Morphological Edge Shock Filtering, Iterative Back-Projection, and 3-Band Pyramidal Micro-Contrast to sharpen blurry edges and reconstruct fine textures."
                : mode === "pixel"
                ? "Crisp nearest-neighbor pixel scaling for retro sprites and pixel art."
                : "Multi-stage super-sampling with Shock-Filtered edge steepening and scale-proportional luminance detail revival."}
            </p>

            {showAiGuide && (
              <div className="mt-3 border-[2px] border-neutral-900 bg-[#F8F7F4] p-3.5 text-xs text-neutral-800">
                <p className="font-black uppercase tracking-wider text-neutral-900">
                  5-Stage Detail Revival & Offline Swin2SR AI
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 font-medium">
                  <li>
                    <strong>Bilateral Block Pre-Denoise:</strong> Cleans 8×8
                    JPEG blocks on the source before scaling.
                  </li>
                  <li>
                    <strong>Edge-Steepening Shock Filter:</strong> Collapses
                    soft 4px–8px bicubic blur ramps into crisp 1px edges.
                  </li>
                  <li>
                    <strong>3-Band Pyramidal Detail Synthesis:</strong>{" "}
                    Reconstructs Fine Acutance, Medium Texture (pores, hair,
                    fabric), and Local Clarity at 2×/4× scale.
                  </li>
                  <li>
                    <strong>Offline AI Models:</strong> Run{" "}
                    <code className="border border-neutral-400 bg-white px-1 font-mono font-bold">
                      npm run setup-ai
                    </code>{" "}
                    to save <code>Swin2SR</code> 2× & 4× models in{" "}
                    <code>public/ai-models/</code>.
                  </li>
                </ol>
              </div>
            )}
          </div>

          {mode !== "pixel" && (
            <>
              <div className="border-t-2 border-neutral-100 pt-5">
                <div className={labelCls}>
                  <span>Detail Revival & Edge Acutance</span>
                  <span className="rounded-none border-[2px] border-neutral-900 bg-[var(--accent)] px-2 py-0.5 font-mono text-xs font-black text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]">
                    {sharpness}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sharpness}
                  onChange={(e) => setSharpness(Number(e.target.value))}
                  className="ps-slider w-full cursor-pointer"
                />
                <div className="mt-1.5 flex justify-between font-mono text-[10px] font-bold uppercase text-neutral-400">
                  <span>Soft</span>
                  <span>Balanced (70%)</span>
                  <span>Maximum Detail</span>
                </div>
              </div>

              <div className="border-t-2 border-neutral-100 pt-5">
                <div className={labelCls}>
                  <span>Source Block & Noise Cleanup</span>
                  <span className="rounded-none border-[2px] border-neutral-900 bg-white px-2 py-0.5 font-mono text-xs font-black text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]">
                    {denoise}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={80}
                  value={denoise}
                  onChange={(e) => setDenoise(Number(e.target.value))}
                  className="ps-slider w-full cursor-pointer"
                />
              </div>
            </>
          )}

          <div className="border-t-2 border-neutral-100 pt-5">
            <div className={labelCls}>
              <span>Output Format</span>
              <span className="font-mono text-xs font-bold uppercase text-neutral-500">
                High-fidelity export
              </span>
            </div>
            <Segmented
              options={UPSCALE_FORMATS}
              value={format}
              onChange={setFormat}
            />
          </div>
        </div>
      </section>

      <section>
        <StepLabel n={3}>Upscale & download</StepLabel>
        <div className="flex flex-col items-stretch gap-6">
          <div className="w-full sm:w-auto sm:self-start">
            <button
              type="button"
              onClick={handleRunUpscale}
              disabled={!files.length || Boolean(adding) || isProcessing}
              className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors sm:min-w-[22rem] md:text-base ${
                !files.length || Boolean(adding) || isProcessing
                  ? "pointer-events-none cursor-not-allowed border-neutral-300 bg-neutral-200 text-neutral-400"
                  : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
              }`}
            >
              <span>
                {isProcessing
                  ? "Upscaling..."
                  : adding
                  ? "Preparing Images..."
                  : `Upscale ${scale}× & Revive Details`}
              </span>
              {files.length > 0 && (
                <span className="rounded-full bg-neutral-900 px-2.5 py-1 font-mono text-[11px] leading-none text-white">
                  {files.length}
                </span>
              )}
            </button>
          </div>

          {errorMsg && (
            <div className="w-full border-[3px] border-neutral-900 bg-[#FFE600] p-4 font-bold text-neutral-900 shadow-[4px_4px_0_rgba(17,17,17,1)] md:max-w-2xl">
              {errorMsg}
            </div>
          )}

          {results.length > 0 && (
            <div className="w-full border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-6 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-neutral-900 pb-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-neutral-500">
                    Upscale Complete
                  </p>
                  <h3 className="text-xl font-black text-neutral-900">
                    {results.length} image{results.length === 1 ? "" : "s"}{" "}
                    enhanced
                  </h3>
                </div>
                {zipDownload && (
                  <a
                    href={zipDownload.url}
                    download={zipDownload.name}
                    className="border-[2px] border-neutral-900 bg-[var(--accent)] px-4 py-2 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                  >
                    Download All (.ZIP · {formatBytes(zipDownload.size)})
                  </a>
                )}
              </div>

              <ul className="mt-4 divide-y divide-neutral-200">
                {results.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-bold text-neutral-900">
                          {r.name}
                        </p>
                        <span className="border border-neutral-900 bg-[#FFE600] px-1.5 py-0.5 font-mono text-[9px] font-black uppercase text-neutral-900">
                          {r.scale || scale}× HD
                        </span>
                      </div>
                      <p className="font-mono text-xs font-semibold text-neutral-500">
                        {r.origWidth}×{r.origHeight} →{" "}
                        <span className="font-bold text-neutral-900">
                          {r.width}×{r.height}
                        </span>{" "}
                        ({formatBytes(r.size)})
                      </p>
                    </div>
                    <a
                      href={r.url}
                      download={r.name}
                      className="border-[2px] border-neutral-900 bg-white px-3.5 py-1.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)] hover:bg-[var(--accent)]"
                    >
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
});

export default ImageUpscaler;
