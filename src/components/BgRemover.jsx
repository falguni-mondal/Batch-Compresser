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
import { isMobileDevice } from "@/lib/device";
import { getStashedFile, stash, unstash } from "@/lib/fileStore";
import { removeBackgroundLocally } from "@/lib/localBgRemove";

const BG_MODE_OPTIONS = [
  { value: "ai", label: "ISNet 1024px AI" },
  { value: "auto", label: "Studio Border" },
  { value: "color", label: "Color Key" },
];

const BG_FILL_OPTIONS = [
  { value: "transparent", label: "Transparent" },
  { value: "white", label: "White" },
  { value: "black", label: "Black" },
  { value: "custom", label: "Custom" },
];

const BG_FORMAT_OPTIONS = [
  { value: "png", label: "PNG (Alpha)" },
  { value: "webp", label: "WebP (Small)" },
];

let idCounter = 0;
const makeId = () => `bg-${Date.now()}-${idCounter++}`;
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BgRemover = memo(function BgRemover() {
  const [files, setFiles] = useState([]);
  const [adding, setAdding] = useState(null);
  const [mode, setMode] = useState("ai");
  const [keyColor, setKeyColor] = useState("#ffffff");
  const [tolerance, setTolerance] = useState(30);
  const [feather, setFeather] = useState(1);
  const [bgFill, setBgFill] = useState("transparent");
  const [customBgColor, setCustomBgColor] = useState("#FF5500");
  const [format, setFormat] = useState("png");
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [results, setResults] = useState([]);
  const [zipDownload, setZipDownload] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const urlsRef = useRef([]);
  const filesRef = useRef([]);

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

  // Immediately stash picked files into RAM on selection to prevent mobile NotReadableError
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
          ready: false,
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

  const handleRunBgRemove = async () => {
    const validFiles = files.filter((f) => !f.broken);
    if (!validFiles.length || Boolean(adding) || isProcessing) return;
    setIsProcessing(true);
    setProgress(0);
    setDoneCount(0);
    setStatusText(
      mode === "ai"
        ? "Loading ISNet-ONNX 1024px AI segmentation engine…"
        : "Removing backgrounds…"
    );
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
        const res = await removeBackgroundLocally(safeFile, {
          mode,
          keyColor,
          tolerance,
          feather,
          bgFill,
          customBgColor,
          format,
          onStatus: (msg) => setStatusText(msg),
        });
        const outName = `${stripExt(item.file.name)}_nobg.${res.format}`;
        const url = URL.createObjectURL(res.blob);
        urlsRef.current.push(url);
        outItems.push({
          id: item.id,
          name: outName,
          blob: res.blob,
          url,
          size: res.blob.size,
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
          name: "pixshrink_nobg.zip",
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
      setErrorMsg(err?.message || "Failed to remove background");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-12 sm:space-y-20">
      {isProcessing && (
        <LoadingOverlay
          title={
            mode === "ai"
              ? "Running ISNet 1024px AI Matting"
              : "Removing backgrounds"
          }
          detail={`${doneCount} of ${files.length} processed · ${statusText}`}
          progress={progress}
        />
      )}

      <section>
        <StepLabel n={1}>Add images for background removal</StepLabel>
        <ImageDropzone
          files={files}
          adding={adding}
          onFilesAdded={handleFilesAdded}
          onRemoveFile={handleRemoveFile}
          onClearAll={handleClearAll}
        />
      </section>

      <section>
        <StepLabel n={2}>AI & cutout settings</StepLabel>
        {/* Static shadow (not .neo-shadow) so clicking inside settings never shifts/animates the box */}
        <div className="w-full space-y-6 rounded-none border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-8 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl">
          <div>
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-black uppercase tracking-widest text-neutral-900">
                Cutout Engine
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-bold text-neutral-500">
                  {mode === "ai"
                    ? "ISNet-ONNX 1024px (Offline AI)"
                    : mode === "auto"
                    ? "Border flood-fill"
                    : "Global chroma key"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowSetupGuide((v) => !v)}
                  className="cursor-pointer border border-neutral-900 bg-[#FFE600] px-2 py-0.5 font-mono text-[10px] font-black uppercase text-neutral-900"
                >
                  {showSetupGuide ? "Hide AI Guide" : "Offline AI Setup"}
                </button>
              </div>
            </div>
            <Segmented
              options={BG_MODE_OPTIONS}
              value={mode}
              onChange={setMode}
            />
            <p className="mt-2 text-[11px] font-medium text-neutral-500">
              {mode === "ai"
                ? "ISNet-ONNX (1024×1024 Dichotomous Image Segmentation — RMBG-1.4 architecture) separates people, fine hair, glasses, products, and complex backgrounds 100% locally in your browser."
                : "Studio modes use fast border color flood-fill or chroma key for solid studio backdrops."}
            </p>

            {showSetupGuide && (
              <div className="mt-3 border-[2px] border-neutral-900 bg-[#F8F7F4] p-3.5 text-xs text-neutral-800">
                <p className="font-black uppercase tracking-wider text-neutral-900">
                  How Offline AI Suite Works (`npm run setup-ai`)
                </p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4 font-medium">
                  <li>
                    <strong>Zero-Setup Browser Mode (Default):</strong> On first
                    use, your browser downloads the quantized{" "}
                    <code>onnx-community/ISNet-ONNX</code> model (~44 MB) and
                    caches it permanently in <code>CacheStorage</code>.
                  </li>
                  <li>
                    <strong>100% Offline Self-Hosted Mode:</strong> Run{" "}
                    <code className="border border-neutral-400 bg-white px-1 font-mono font-bold">
                      npm run setup-ai
                    </code>{" "}
                    in your terminal to save{" "}
                    <code>onnx-community/ISNet-ONNX</code> into{" "}
                    <code>public/ai-models/</code> for offline execution.
                  </li>
                </ol>
              </div>
            )}
          </div>

          {mode === "color" && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-t-2 border-neutral-100 pt-5">
              <div>
                <span className="block text-xs font-bold uppercase tracking-wider text-neutral-900">
                  Target Background Color
                </span>
                <span className="text-[11px] font-medium text-neutral-500">
                  Pick the solid backdrop color to remove
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={keyColor}
                  onChange={(e) => setKeyColor(e.target.value)}
                  className="h-10 w-14 cursor-pointer border-[2px] border-neutral-900 bg-white p-0.5"
                />
                <input
                  type="text"
                  value={keyColor}
                  onChange={(e) => setKeyColor(e.target.value)}
                  className="h-10 w-24 border-[2px] border-neutral-900 px-2 font-mono text-xs font-bold uppercase"
                />
              </div>
            </div>
          )}

          {mode !== "ai" && (
            <div className="border-t-2 border-neutral-100 pt-5">
              <div className={labelCls}>
                <span>Color Tolerance</span>
                <span className="rounded-none border-[2px] border-neutral-900 bg-[var(--accent)] px-2 py-0.5 font-mono text-xs font-black text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]">
                  {tolerance}%
                </span>
              </div>
              <input
                type="range"
                min={5}
                max={85}
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                className="ps-slider w-full cursor-pointer"
              />
            </div>
          )}

          <div className="border-t-2 border-neutral-100 pt-5">
            <div className={labelCls}>
              <span>Edge Feathering</span>
              <span className="rounded-none border-[2px] border-neutral-900 bg-white px-2 py-0.5 font-mono text-xs font-black text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]">
                {feather} px
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={5}
              value={feather}
              onChange={(e) => setFeather(Number(e.target.value))}
              className="ps-slider w-full cursor-pointer"
            />
          </div>

          <div className="border-t-2 border-neutral-100 pt-5">
            <div className={labelCls}>
              <span>Replacement Background</span>
              <span className="font-mono text-xs font-bold text-neutral-500">
                {bgFill === "transparent"
                  ? "Checkerboard alpha"
                  : "Solid color fill"}
              </span>
            </div>
            <Segmented
              options={BG_FILL_OPTIONS}
              value={bgFill}
              onChange={setBgFill}
            />
            {bgFill === "custom" && (
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="color"
                  value={customBgColor}
                  onChange={(e) => setCustomBgColor(e.target.value)}
                  className="h-10 w-14 cursor-pointer border-[2px] border-neutral-900 bg-white p-0.5"
                />
                <span className="font-mono text-xs font-bold uppercase text-neutral-700">
                  {customBgColor}
                </span>
              </div>
            )}
          </div>

          <div className="border-t-2 border-neutral-100 pt-5">
            <div className={labelCls}>
              <span>Output Format</span>
              <span className="font-mono text-xs font-bold uppercase text-neutral-500">
                Supports transparency
              </span>
            </div>
            <Segmented
              options={BG_FORMAT_OPTIONS}
              value={format}
              onChange={setFormat}
            />
          </div>
        </div>
      </section>

      <section>
        <StepLabel n={3}>Remove background & download</StepLabel>
        <div className="flex flex-col items-stretch gap-6">
          <div className="w-full sm:w-auto sm:self-start">
            <button
              type="button"
              onClick={handleRunBgRemove}
              disabled={!files.length || Boolean(adding) || isProcessing}
              className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors sm:min-w-[22rem] md:text-base ${
                !files.length || Boolean(adding) || isProcessing
                  ? "pointer-events-none cursor-not-allowed border-neutral-300 bg-neutral-200 text-neutral-400"
                  : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
              }`}
            >
              <span>
                {isProcessing
                  ? "Removing Backgrounds..."
                  : adding
                  ? "Preparing Images..."
                  : mode === "ai"
                  ? "Remove Background (ISNet AI)"
                  : "Remove Backgrounds"}
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
                    Cutouts Ready
                  </p>
                  <h3 className="text-xl font-black text-neutral-900">
                    {results.length} image{results.length === 1 ? "" : "s"}{" "}
                    processed
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

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {results.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-col justify-between border-[2px] border-neutral-900 bg-[#F8F7F4] p-3 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                  >
                    <div
                      className="relative flex h-44 items-center justify-center overflow-hidden border border-neutral-300"
                      style={{
                        backgroundImage:
                          "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
                        backgroundSize: "16px 16px",
                        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.url}
                        alt={r.name}
                        className="max-h-full max-w-full object-contain"
                      />
                      <span className="absolute right-1.5 top-1.5 border border-neutral-900 bg-white px-1.5 py-0.5 font-mono text-[9px] font-black uppercase text-neutral-900">
                        {r.usedAi ? "ISNet AI" : "Studio Key"}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-neutral-900">
                          {r.name}
                        </p>
                        <p className="font-mono text-[10px] font-semibold text-neutral-500">
                          {r.width}×{r.height} · {formatBytes(r.size)}
                        </p>
                      </div>
                      <a
                        href={r.url}
                        download={r.name}
                        className="shrink-0 border-[2px] border-neutral-900 bg-white px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)] hover:bg-[var(--accent)]"
                      >
                        Save
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
});

export default BgRemover;
