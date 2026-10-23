"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingOverlay } from "@/components/PixelLoader";
import {
  Segmented,
  StepLabel,
  formatBytes,
  labelCls,
  stripExt,
} from "@/components/StepHeader";
import { decodeBitmap, makeCanvas } from "@/lib/encodeCore";
import { stash, unstash } from "@/lib/fileStore";
import { extractSubjectCanvas } from "@/lib/localBgRemove";
import {
  PAPER_SPECS,
  PASSPORT_BG_PRESETS,
  PHOTO_SPECS,
  exportPassportSheetBlob,
  getMaxCopiesForConfig,
  renderPassportSheetCanvas,
} from "@/lib/localPassport";

const PHOTO_TYPE_OPTIONS = [
  { value: "passport", label: "Passport (3.5 × 4.5 cm)" },
  { value: "stamp", label: "Stamp (2.0 × 2.5 cm)" },
];

const PAPER_SIZE_OPTIONS = [
  { value: "6x4", label: "6×4 inch" },
  { value: "a4", label: "A4 Sheet" },
  { value: "5x7", label: "7×5 inch" },
  { value: "a5", label: "A5 Sheet" },
  { value: "single", label: "Single (Soft Copy)" },
];

const EXPORT_FORMAT_OPTIONS = [
  { value: "jpeg", label: "JPG (300 DPI)" },
  { value: "png", label: "PNG (Lossless)" },
  { value: "webp", label: "WebP" },
];

const PASSPORT_STASH_ID = "passport-active-file";

const PassportPhotoMaker = memo(function PassportPhotoMaker() {
  // Strictly 1 image at a time
  const [file, setFile] = useState(null);
  const [photoType, setPhotoType] = useState("passport");
  const [paperSize, setPaperSize] = useState("6x4");
  const [copies, setCopies] = useState(8); // Default to Max (8 for passport)
  const [bgPreset, setBgPreset] = useState("muted-blue");
  const [customBgHex, setCustomBgHex] = useState("#6B8EAD");
  const [zoom, setZoom] = useState(1.08);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(-6);
  const [drawCutBorder, setDrawCutBorder] = useState(true);
  const [format, setFormat] = useState("jpeg");

  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiStatusText, setAiStatusText] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [usedAiCutout, setUsedAiCutout] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [downloadItem, setDownloadItem] = useState(null);

  const origCanvasRef = useRef(null);
  const cutoutCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const downloadUrlRef = useRef(null);
  const [canvasVersion, setCanvasVersion] = useState(0);

  const maxCopies = useMemo(
    () => getMaxCopiesForConfig(photoType, paperSize),
    [photoType, paperSize]
  );

  const handlePhotoTypeChange = useCallback(
    (nextType) => {
      const prevMax = getMaxCopiesForConfig(photoType, paperSize);
      const nextMax = getMaxCopiesForConfig(nextType, paperSize);
      setPhotoType(nextType);
      setCopies((prev) =>
        prev >= prevMax ? nextMax : Math.min(prev, nextMax)
      );
      setDownloadItem(null);
    },
    [photoType, paperSize]
  );

  const handlePaperSizeChange = useCallback(
    (nextPaper) => {
      const nextMax = getMaxCopiesForConfig(photoType, nextPaper);
      setPaperSize(nextPaper);
      setCopies((prev) =>
        nextPaper === "single"
          ? 1
          : prev === 1 && paperSize === "single"
          ? nextMax
          : Math.min(prev, nextMax)
      );
      setDownloadItem(null);
    },
    [photoType, paperSize]
  );

  const effectiveBgColor = useMemo(() => {
    if (bgPreset === "original") return "transparent";
    if (bgPreset === "custom") return customBgHex || "#6B8EAD";
    const found = PASSPORT_BG_PRESETS.find((p) => p.id === bgPreset);
    return found?.hex || "#6B8EAD";
  }, [bgPreset, customBgHex]);

  const cleanupCanvases = useCallback(() => {
    unstash(PASSPORT_STASH_ID);
    if (origCanvasRef.current) {
      origCanvasRef.current.width = origCanvasRef.current.height = 0;
      origCanvasRef.current = null;
    }
    if (cutoutCanvasRef.current) {
      cutoutCanvasRef.current.width = cutoutCanvasRef.current.height = 0;
      cutoutCanvasRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupCanvases();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, [cleanupCanvases]);

  const ensureCutoutReady = useCallback(
    async (targetFile, forceAi = true) => {
      if (!targetFile) return;
      setIsAiRunning(true);
      setErrorMsg("");
      try {
        setAiStatusText("Securing portrait image in memory…");
        const safeFile = await stash(PASSPORT_STASH_ID, targetFile);
        setFile(safeFile);

        if (!origCanvasRef.current) {
          setAiStatusText("Decoding portrait image…");
          const bmp = await decodeBitmap(safeFile);
          const c = makeCanvas(bmp.width, bmp.height);
          c.getContext("2d").drawImage(bmp, 0, 0);
          bmp.close?.();
          origCanvasRef.current = c;
        }

        if (forceAi && !cutoutCanvasRef.current) {
          setAiStatusText("Removing background with ISNet 1024px AI…");
          const res = await extractSubjectCanvas(safeFile, {
            mode: "ai",
            feather: 1,
            onStatus: (msg) => setAiStatusText(msg),
          });
          cutoutCanvasRef.current = res.canvas;
          setUsedAiCutout(res.usedAi);
        }

        setCanvasVersion((v) => v + 1);
      } catch (err) {
        setErrorMsg(err?.message || "Could not process portrait image");
      } finally {
        setIsAiRunning(false);
      }
    },
    []
  );

  const handleSelectSingleFile = useCallback(
    async (incomingList) => {
      const picked = incomingList?.[0];
      if (!picked) return;
      cleanupCanvases();
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = null;
      }
      setDownloadItem(null);
      setFile(picked);
      setZoom(1.08);
      setPanX(0);
      setPanY(-6);
      await ensureCutoutReady(picked, bgPreset !== "original");
    },
    [bgPreset, cleanupCanvases, ensureCutoutReady]
  );

  useEffect(() => {
    if (
      file &&
      bgPreset !== "original" &&
      !cutoutCanvasRef.current &&
      !isAiRunning
    ) {
      ensureCutoutReady(file, true);
    }
  }, [file, bgPreset, isAiRunning, ensureCutoutReady]);

  useEffect(() => {
    const dstCanvas = previewCanvasRef.current;
    if (!dstCanvas || !file) return;

    const activeSource =
      bgPreset === "original"
        ? origCanvasRef.current
        : cutoutCanvasRef.current || origCanvasRef.current;

    if (!activeSource) return;

    const { canvas: rendered } = renderPassportSheetCanvas({
      sourceCanvas: activeSource,
      photoType,
      paperSize,
      copies,
      bgColor: effectiveBgColor,
      zoom,
      panX,
      panY,
      drawCutBorder,
      previewScale: paperSize === "single" ? 0.65 : 0.35,
    });

    dstCanvas.width = rendered.width;
    dstCanvas.height = rendered.height;
    const ctx = dstCanvas.getContext("2d");
    ctx.drawImage(rendered, 0, 0);
    rendered.width = rendered.height = 0;
  }, [
    file,
    canvasVersion,
    photoType,
    paperSize,
    copies,
    bgPreset,
    effectiveBgColor,
    zoom,
    panX,
    panY,
    drawCutBorder,
  ]);

  const handleExportDownload = async () => {
    if (!file || isExporting || isAiRunning) return;
    setIsExporting(true);
    setErrorMsg("");

    try {
      const activeSource =
        bgPreset === "original"
          ? origCanvasRef.current
          : cutoutCanvasRef.current || origCanvasRef.current;

      if (!activeSource) throw new Error("Please add an image first");

      const res = await exportPassportSheetBlob({
        sourceCanvas: activeSource,
        photoType,
        paperSize,
        copies,
        bgColor: effectiveBgColor,
        zoom,
        panX,
        panY,
        drawCutBorder,
        format,
      });

      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
      const url = URL.createObjectURL(res.blob);
      downloadUrlRef.current = url;

      const ext =
        res.format === "jpeg" || res.format === "jpg" ? "jpg" : res.format;
      const suffix =
        paperSize === "single"
          ? `${photoType}_single`
          : `${photoType}_${paperSize}_${res.placedCopies}copies`;
      const outName = `${stripExt(file.name)}_${suffix}.${ext}`;

      const item = {
        name: outName,
        url,
        size: res.blob.size,
        width: res.width,
        height: res.height,
        placedCopies: res.placedCopies,
      };
      setDownloadItem(item);

      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setErrorMsg(err?.message || "Failed to generate passport sheet");
    } finally {
      setIsExporting(false);
    }
  };

  const copyOptions = useMemo(() => {
    if (paperSize === "single") return [1];
    return Array.from({ length: maxCopies }, (_, i) => i + 1);
  }, [paperSize, maxCopies]);

  const activePhotoSpec = PHOTO_SPECS[photoType] || PHOTO_SPECS.passport;
  const activePaperSpec = PAPER_SPECS[paperSize] || PAPER_SPECS["6x4"];

  return (
    <div className="space-y-12 sm:space-y-20">
      {isAiRunning && (
        <LoadingOverlay
          title="Preparing Passport Photo"
          detail={
            aiStatusText || "Running ISNet 1024px AI background removal…"
          }
          progress={65}
        />
      )}

      {/* Step 1: Upload 1 Portrait Image */}
      <section>
        <StepLabel n={1}>Add 1 portrait photo (1 image at a time)</StepLabel>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif"
          onChange={(e) => {
            if (e.target.files?.length) {
              handleSelectSingleFile(e.target.files);
              e.target.value = "";
            }
          }}
          className="sr-only"
        />

        {!file ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) {
                handleSelectSingleFile(e.dataTransfer.files);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className="group/dz flex h-[280px] w-full cursor-pointer flex-col items-center justify-center rounded-none border-[3px] border-neutral-900 bg-white px-4 text-center shadow-[4px_4px_0_rgba(17,17,17,1)] transition-colors duration-200 hover:bg-neutral-50 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:h-[320px] md:max-w-2xl"
          >
            {/* Original PixShrink Upload Icon */}
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-none border-[3px] border-neutral-900 bg-[var(--accent)] text-neutral-900 shadow-[4px_4px_0_rgba(17,17,17,1)] transition-colors duration-200 group-hover/dz:bg-white">
              <svg
                className="h-8 w-8"
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="square"
                strokeLinejoin="miter"
              >
                <path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
              </svg>
            </div>
            <p className="mb-4 text-sm font-black uppercase tracking-widest text-neutral-900 md:text-base">
              Click to select 1 photo{" "}
              <span className="text-neutral-500">or drag & drop</span>
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="mr-1 font-mono text-[11px] font-bold uppercase tracking-widest text-neutral-400">
                Sizes
              </span>
              <span className="rounded-none border-[2px] border-neutral-900 bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-neutral-900">
                3.5 × 4.5 CM
              </span>
              <span className="rounded-none border-[2px] border-neutral-900 bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-neutral-900">
                2.0 × 2.5 CM
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[2px] border-neutral-900 bg-[#FFE600] font-mono text-xs font-black uppercase text-neutral-900">
                1/1
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-neutral-900">
                  {file.name}
                </p>
                <p className="font-mono text-xs font-semibold text-neutral-500">
                  {formatBytes(file.size)} ·{" "}
                  {usedAiCutout
                    ? "ISNet AI Background Removed"
                    : bgPreset === "original"
                    ? "Original Background"
                    : "Studio Cutout Ready"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer border-[2px] border-neutral-900 bg-[var(--accent)] px-3 py-1.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
              >
                Replace Photo
              </button>
              <button
                type="button"
                onClick={() => {
                  cleanupCanvases();
                  setFile(null);
                  setDownloadItem(null);
                }}
                className="cursor-pointer border-[2px] border-neutral-900 bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)] hover:bg-neutral-100"
              >
                Remove
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Step 2: Size, Paper, Copies & AI Background Color */}
      <section>
        <StepLabel n={2}>
          Choose photo size, paper sheet, copies & AI background
        </StepLabel>

        <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
          {/* Controls Column (static shadow so clicking inside never shifts/animates) */}
          <div className="space-y-6 border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-8 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] xl:col-span-7">
            <div>
              <div className={labelCls}>
                <span>Photo Standard Size</span>
                <span className="font-mono text-xs font-bold text-neutral-500">
                  {activePhotoSpec.widthCm} cm × {activePhotoSpec.heightCm} cm
                </span>
              </div>
              <Segmented
                options={PHOTO_TYPE_OPTIONS}
                value={photoType}
                onChange={handlePhotoTypeChange}
              />
              <p className="mt-2 text-[11px] font-medium text-neutral-500">
                {photoType === "passport"
                  ? "Standard Passport Size (3.5 cm × 4.5 cm). Maximum 8 copies per print sheet with proper cutting gaps."
                  : "Standard Stamp Size (2.0 cm × 2.5 cm). Maximum 9 copies per print sheet with proper cutting gaps."}
              </p>
            </div>

            {/* Paper Size */}
            <div className="border-t-2 border-neutral-100 pt-5">
              <div className={labelCls}>
                <span>Paper / Output Size</span>
                <span className="font-mono text-[11px] font-bold text-neutral-500">
                  {activePaperSpec.desc}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PAPER_SIZE_OPTIONS.map((opt) => {
                  const active = paperSize === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handlePaperSizeChange(opt.value)}
                      className={`cursor-pointer border-[2px] border-neutral-900 px-3 py-2.5 text-left transition-colors ${
                        active
                          ? "bg-[var(--accent)] text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                          : "bg-white text-neutral-900 hover:bg-neutral-100"
                      }`}
                    >
                      <span className="block text-xs font-black uppercase tracking-wider">
                        {opt.label}
                      </span>
                      <span className="block font-mono text-[10px] font-bold text-neutral-600">
                        {opt.value === "single"
                          ? "1 Soft Copy"
                          : `Up to ${PHOTO_SPECS[photoType].maxCopiesPerSheet} copies`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Number of Copies (1 to Max: 8 for Passport, 9 for Stamp) */}
            <div className="border-t-2 border-neutral-100 pt-5">
              <div className={labelCls}>
                <span>Number of Copies on Page</span>
                <span className="rounded-none border-[2px] border-neutral-900 bg-[#FFE600] px-2 py-0.5 font-mono text-xs font-black text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]">
                  {paperSize === "single"
                    ? "1 Soft Copy"
                    : copies === maxCopies
                    ? `MAX (${maxCopies} Copies)`
                    : `${copies} ${copies === 1 ? "Copy" : "Copies"}`}
                </span>
              </div>

              {paperSize === "single" ? (
                <p className="border-[2px] border-neutral-900 bg-[#F8F7F4] px-3 py-2 font-mono text-xs font-bold text-neutral-700">
                  Single (Soft Copy) mode exports 1 standalone digital photo (
                  {activePhotoSpec.widthCm} cm × {activePhotoSpec.heightCm} cm).
                  Select <strong>6×4 inch</strong> or <strong>A4</strong> above
                  to print multiple copies.
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                  {copyOptions.map((n) => {
                    const isMax = n === maxCopies;
                    const active = copies === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setCopies(n);
                          setDownloadItem(null);
                        }}
                        className={`h-10 cursor-pointer border-[2px] border-neutral-900 font-mono text-xs font-black uppercase transition-colors ${
                          active
                            ? "bg-[var(--accent)] text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
                            : "bg-white text-neutral-900 hover:bg-neutral-100"
                        }`}
                      >
                        {isMax ? `MAX (${n})` : n}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* AI Background Color (Muted Blue & Off-White Presets + Custom) */}
            <div className="border-t-2 border-neutral-100 pt-5">
              <div className={labelCls}>
                <span>AI Background Color</span>
                <span className="font-mono text-xs font-bold uppercase text-neutral-500">
                  {bgPreset === "original"
                    ? "Original backdrop"
                    : effectiveBgColor}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {PASSPORT_BG_PRESETS.map((preset) => {
                  const active = bgPreset === preset.id;
                  const swatchHex =
                    preset.id === "custom" ? customBgHex : preset.hex;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setBgPreset(preset.id);
                        setDownloadItem(null);
                      }}
                      className={`flex cursor-pointer items-center gap-2.5 border-[2px] border-neutral-900 px-3 py-2 text-left transition-colors ${
                        active
                          ? "bg-neutral-900 text-white shadow-[3px_3px_0_#FF5500]"
                          : "bg-white text-neutral-900 hover:bg-neutral-100"
                      }`}
                    >
                      <span
                        className="h-5 w-5 shrink-0 border border-neutral-900"
                        style={{
                          background:
                            preset.id === "original"
                              ? "repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 50% / 8px 8px"
                              : swatchHex || "#6B8EAD",
                        }}
                      />
                      <div className="min-w-0">
                        <span className="block truncate text-xs font-black uppercase tracking-wider">
                          {preset.label}
                        </span>
                        {preset.badge && (
                          <span
                            className={`inline-block font-mono text-[9px] font-bold uppercase ${
                              active ? "text-[#FFE600]" : "text-neutral-500"
                            }`}
                          >
                            {preset.badge}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {bgPreset === "custom" && (
                <div className="mt-3 flex flex-wrap items-center gap-3 border-[2px] border-neutral-900 bg-[#F8F7F4] p-3">
                  <input
                    type="color"
                    value={customBgHex}
                    onChange={(e) => {
                      setCustomBgHex(e.target.value);
                      setDownloadItem(null);
                    }}
                    className="h-10 w-14 cursor-pointer border-[2px] border-neutral-900 bg-white p-0.5"
                  />
                  <input
                    type="text"
                    value={customBgHex}
                    onChange={(e) => {
                      setCustomBgHex(e.target.value);
                      setDownloadItem(null);
                    }}
                    className="h-10 w-28 border-[2px] border-neutral-900 bg-white px-2.5 font-mono text-xs font-bold uppercase"
                  />
                  <span className="text-xs font-bold text-neutral-600">
                    Pick any custom passport backdrop shade
                  </span>
                </div>
              )}
            </div>

            {/* Portrait Framing & Cut Border Sliders */}
            <div className="grid grid-cols-1 gap-4 border-t-2 border-neutral-100 pt-5 sm:grid-cols-3">
              <div>
                <div className="mb-1 flex justify-between text-[11px] font-black uppercase">
                  <span>Zoom</span>
                  <span className="font-mono">{zoom.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={2.2}
                  step={0.02}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="ps-slider w-full cursor-pointer"
                />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px] font-black uppercase">
                  <span>Horizontal Pan</span>
                  <span className="font-mono">{panX}%</span>
                </div>
                <input
                  type="range"
                  min={-40}
                  max={40}
                  step={1}
                  value={panX}
                  onChange={(e) => setPanX(Number(e.target.value))}
                  className="ps-slider w-full cursor-pointer"
                />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[11px] font-black uppercase">
                  <span>Vertical Pan</span>
                  <span className="font-mono">{panY}%</span>
                </div>
                <input
                  type="range"
                  min={-40}
                  max={40}
                  step={1}
                  value={panY}
                  onChange={(e) => setPanY(Number(e.target.value))}
                  className="ps-slider w-full cursor-pointer"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t-2 border-neutral-100 pt-5">
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={drawCutBorder}
                  onChange={(e) => setDrawCutBorder(e.target.checked)}
                  className="h-4 w-4 accent-neutral-900"
                />
                <span className="text-xs font-black uppercase tracking-wider text-neutral-900">
                  Print Scissor Cut Border & Crop Ticks
                </span>
              </label>
            </div>

            <div className="border-t-2 border-neutral-100 pt-5">
              <div className={labelCls}>
                <span>Output File Format</span>
                <span className="font-mono text-xs font-bold text-neutral-500">
                  Calibrated 300 DPI print sheet
                </span>
              </div>
              <Segmented
                options={EXPORT_FORMAT_OPTIONS}
                value={format}
                onChange={setFormat}
              />
            </div>
          </div>

          {/* Live Sheet Preview Column */}
          <div className="flex flex-col justify-between border-[3px] border-neutral-900 bg-[#F8F7F4] p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-5 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] xl:col-span-5">
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b-2 border-neutral-900 pb-2.5">
                <div>
                  <span className="block font-mono text-[10px] font-black uppercase tracking-widest text-neutral-500">
                    Live Print Sheet Preview
                  </span>
                  <h3 className="text-sm font-black uppercase text-neutral-900">
                    {activePaperSpec.label} ·{" "}
                    {paperSize === "single"
                      ? `1 × ${activePhotoSpec.shortLabel}`
                      : `${copies} × ${activePhotoSpec.shortLabel}`}
                  </h3>
                </div>
                <span className="border border-neutral-900 bg-[#FFE600] px-2 py-0.5 font-mono text-[10px] font-black uppercase text-neutral-900">
                  300 DPI
                </span>
              </div>

              <div className="flex min-h-[280px] items-center justify-center border-[2px] border-neutral-900 bg-neutral-200/70 p-3 sm:min-h-[320px] sm:p-4">
                {file ? (
                  <canvas
                    ref={previewCanvasRef}
                    className="max-h-[400px] max-w-full border border-neutral-400 bg-white shadow-[4px_4px_0_rgba(17,17,17,0.85)]"
                  />
                ) : (
                  <p className="max-w-[24ch] text-center font-mono text-xs font-bold uppercase text-neutral-500">
                    Add 1 portrait photo in Step 1 to see your live passport
                    sheet preview
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-1.5 border-t-2 border-neutral-900 pt-3 font-mono text-[11px] font-bold text-neutral-600">
              <div className="flex justify-between">
                <span>PHOTO DIMENSION:</span>
                <span className="text-neutral-900">
                  {activePhotoSpec.widthCm} cm × {activePhotoSpec.heightCm} cm
                </span>
              </div>
              <div className="flex justify-between">
                <span>MAX COPIES ALLOWED:</span>
                <span className="text-neutral-900">
                  {paperSize === "single"
                    ? "1 (Soft Copy)"
                    : `${maxCopies} per sheet (${
                        photoType === "passport" ? "Passport" : "Stamp"
                      } limit)`}
                </span>
              </div>
              <div className="flex justify-between">
                <span>BACKGROUND FILL:</span>
                <span className="uppercase text-neutral-900">
                  {bgPreset === "original" ? "Original" : effectiveBgColor}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Step 3: Generate & Download */}
      <section>
        <StepLabel n={3}>
          Generate & download print-ready passport photo
        </StepLabel>
        <div className="flex flex-col items-stretch gap-6">
          <div className="w-full sm:w-auto sm:self-start">
            <button
              type="button"
              onClick={handleExportDownload}
              disabled={!file || isAiRunning || isExporting}
              className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors sm:min-w-[24rem] md:text-base ${
                !file || isAiRunning || isExporting
                  ? "pointer-events-none cursor-not-allowed border-neutral-300 bg-neutral-200 text-neutral-400"
                  : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
              }`}
            >
              <span>
                {isExporting
                  ? "Generating 300 DPI Sheet..."
                  : paperSize === "single"
                  ? `Download Single ${
                      photoType === "passport" ? "Passport" : "Stamp"
                    } Photo`
                  : `Download ${activePaperSpec.label} Sheet (${copies} ${
                      copies === 1 ? "Copy" : "Copies"
                    })`}
              </span>
            </button>
          </div>

          {errorMsg && (
            <div className="w-full border-[3px] border-neutral-900 bg-[#FFE600] p-4 font-bold text-neutral-900 shadow-[4px_4px_0_rgba(17,17,17,1)] md:max-w-2xl">
              {errorMsg}
            </div>
          )}

          {downloadItem && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)] sm:p-5 sm:shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-neutral-500">
                  Print-Ready File Generated
                </p>
                <p className="mt-0.5 text-base font-black text-neutral-900">
                  {downloadItem.name}
                </p>
                <p className="font-mono text-xs font-semibold text-neutral-500">
                  {downloadItem.width}×{downloadItem.height} px (300 DPI) ·{" "}
                  {downloadItem.placedCopies}{" "}
                  {downloadItem.placedCopies === 1 ? "photo" : "photos"} ·{" "}
                  {formatBytes(downloadItem.size)}
                </p>
              </div>
              <a
                href={downloadItem.url}
                download={downloadItem.name}
                className="border-[2px] border-neutral-900 bg-[var(--accent)] px-4 py-2 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
              >
                Download Again
              </a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
});

export default PassportPhotoMaker;
