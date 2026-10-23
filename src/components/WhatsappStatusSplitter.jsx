"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { LoadingOverlay } from "@/components/PixelLoader";
import VideoDropzone from "@/components/VideoDropzone";
import {
  Segmented,
  StepLabel,
  formatBytes,
  formatDuration,
  labelCls,
  stripExt,
} from "@/components/StepHeader";
import {
  getSupportedVideoFormats,
  probeVideoMetadata,
  splitVideoForWhatsappLocally,
} from "@/lib/localVideoCompress";
import { WHATSAPP_STATUS_LIMITS, getWhatsappStatusLimits, isMobileDevice } from "@/lib/device";

const WA_STATUS_PRESETS = [
  {
    label: "Standard Status (30s)",
    badge: "30s Clips · 720p HD · 1.5 Mbps",
    sec: 30,
    h: 720,
    br: 1500,
  },
  {
    label: "Long Status (60s)",
    badge: "60s Clips · 720p HD · 1.4 Mbps",
    sec: 60,
    h: 720,
    br: 1400,
  },
  {
    label: "Short Story (15s)",
    badge: "15s Clips · 720p HD · 1.6 Mbps",
    sec: 15,
    h: 720,
    br: 1600,
  },
  {
    label: "Data Saver (30s)",
    badge: "30s Clips · 480p · 850 kbps",
    sec: 30,
    h: 480,
    br: 850,
  },
];

function WhatsappStatusSplitter() {
  const [limits, setLimits] = useState({
    ...WHATSAPP_STATUS_LIMITS.desktop,
    maxFileBytes: WHATSAPP_STATUS_LIMITS.desktop.maxFileMB * 1024 * 1024,
  });
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    setLimits(getWhatsappStatusLimits());
    setMobile(isMobileDevice());
  }, []);

  const [videos, setVideos] = useState([]);
  const [clipSec, setClipSec] = useState(30);
  const [maxHeight, setMaxHeight] = useState(720);
  const [bitrateKbps, setBitrateKbps] = useState(1500);
  const [format, setFormat] = useState("mp4");
  const [muteAudio, setMuteAudio] = useState(false);
  const [supported, setSupported] = useState({ mp4: true, webm: true });

  const [isProcessing, setIsProcessing] = useState(false);
  const [statusInfo, setStatusInfo] = useState({
    percent: 0,
    partNumber: 1,
    totalParts: 1,
  });
  const [notice, setNotice] = useState("");
  const [splitParts, setSplitParts] = useState([]);
  const [zipDownload, setZipDownload] = useState(null);
  const [failed, setFailed] = useState("");

  const abortRef = useRef(null);
  const urlsRef = useRef([]);

  useEffect(() => {
    const sup = getSupportedVideoFormats();
    setSupported(sup);
    if (sup.mp4) setFormat("mp4");
    else if (sup.webm) setFormat("webm");
  }, []);

  const revokeUrls = useCallback(() => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  }, []);

  useEffect(() => () => revokeUrls(), [revokeUrls]);

  const handlePickFiles = async (fileList) => {
    const file = fileList?.[0];
    if (!file) return;

    if (
      !file.type.startsWith("video/") &&
      !/\.(mp4|webm|mov|m4v)$/i.test(file.name)
    ) {
      setNotice(
        `"${file.name}" skipped: only MP4, WebM, and MOV videos are supported.`
      );
      return;
    }
    if (file.size > limits.maxFileBytes) {
      setNotice(
        `"${file.name}" exceeds the ${limits.maxFileMB} MB limit on this ${
          mobile ? "phone" : "device"
        }.`
      );
      return;
    }

    try {
      const meta = await probeVideoMetadata(file);
      if (meta.duration > limits.maxDurationSec) {
        setNotice(
          `"${file.name}" is ${Math.round(
            meta.duration
          )}s long (max allowed is ${limits.maxDurationSec}s on this ${
            mobile ? "phone" : "device"
          }).`
        );
        return;
      }
      setNotice("");
      setVideos([
        {
          id: `${file.name}-${file.size}-${Date.now()}`,
          file,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
        },
      ]);
      revokeUrls();
      setSplitParts([]);
      setZipDownload(null);
      setFailed("");
    } catch (err) {
      setNotice(err.message);
    }
  };

  const runWhatsappSplit = async () => {
    const item = videos[0];
    if (!item || isProcessing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);
    const estParts = Math.max(1, Math.ceil((item.duration - 0.15) / clipSec));
    setStatusInfo({ percent: 0, partNumber: 1, totalParts: estParts });
    revokeUrls();
    setSplitParts([]);
    setZipDownload(null);
    setFailed("");

    try {
      const res = await splitVideoForWhatsappLocally(item.file, {
        clipDurationSec: clipSec,
        maxHeight,
        videoBitrate: bitrateKbps * 1000,
        fps: 30,
        format,
        muteAudio,
        signal: controller.signal,
        onProgress: (info) => setStatusInfo(info),
      });

      const base = stripExt(item.file.name);
      const readyParts = res.parts.map((p) => {
        const name = `${base}_status_part${p.partNumber}.${p.format}`;
        const url = URL.createObjectURL(p.blob);
        urlsRef.current.push(url);
        return {
          ...p,
          name,
          url,
          size: p.blob.size,
        };
      });

      if (readyParts.length > 1) {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        readyParts.forEach((p) => zip.file(p.name, p.blob));
        const zipBlob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
        });
        const zipUrl = URL.createObjectURL(zipBlob);
        urlsRef.current.push(zipUrl);
        setZipDownload({
          name: `${base}_whatsapp_status_${readyParts.length}parts.zip`,
          url: zipUrl,
          size: zipBlob.size,
        });
      }

      setSplitParts(readyParts);
      setVideos([]);
    } catch (err) {
      if (err?.code !== "CANCELLED") {
        setFailed(err.message || "Failed to split video for WhatsApp Status");
      }
    } finally {
      setIsProcessing(false);
      abortRef.current = null;
    }
  };

  const activeVideo = videos[0];
  const expectedClips = activeVideo
    ? Math.max(1, Math.ceil((activeVideo.duration - 0.15) / clipSec))
    : 0;
  const brPct = Math.min(
    100,
    Math.max(0, ((bitrateKbps - 500) / (3000 - 500)) * 100)
  );

  return (
    <div className="space-y-14 sm:space-y-20">
      {isProcessing && (
        <LoadingOverlay
          title={`Splitting & optimizing clip ${statusInfo.partNumber} of ${statusInfo.totalParts}`}
          detail={`${statusInfo.percent}% complete · Formatting for WhatsApp Status`}
          progress={statusInfo.percent}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      <section>
        <StepLabel n={1}>Add video for WhatsApp Status</StepLabel>

        {notice && (
          <div className="mb-6 rounded-none border-[3px] border-neutral-900 bg-[#FFE600] p-4 text-left shadow-[4px_4px_0_rgba(17,17,17,1)]">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-900">
              {notice}
            </p>
          </div>
        )}

        <VideoDropzone
          videos={videos}
          limits={limits}
          mobile={mobile}
          onPickFiles={handlePickFiles}
          onRemoveVideo={() => setVideos([])}
          onClearVideos={() => {
            setVideos([]);
            revokeUrls();
            setSplitParts([]);
            setZipDownload(null);
          }}
          extraBadge={(v) => {
            const n = Math.max(1, Math.ceil((v.duration - 0.15) / clipSec));
            return (
              <p className="mt-2 inline-block border-2 border-neutral-900 bg-[#FFE600] px-2.5 py-0.5 font-mono text-[10px] font-black uppercase text-neutral-900">
                Will split into {n} WhatsApp Status {n === 1 ? "clip" : "clips"}{" "}
                (≤{clipSec}s each)
              </p>
            );
          }}
        />
      </section>

      <section>
        <StepLabel n={2}>Choose WhatsApp Status settings</StepLabel>

        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start">
          <span className={`${labelCls} pt-2 sm:w-32 sm:shrink-0`}>
            Quick Presets
          </span>
          <div className="flex flex-wrap gap-2.5">
            {WA_STATUS_PRESETS.map((p) => {
              const active =
                clipSec === p.sec &&
                maxHeight === p.h &&
                bitrateKbps === p.br;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setClipSec(p.sec);
                    setMaxHeight(p.h);
                    setBitrateKbps(p.br);
                  }}
                  aria-pressed={active}
                  className={`cursor-pointer border-[3px] border-neutral-900 px-3.5 py-2 text-left transition-all focus:outline-none ${
                    active
                      ? "bg-neutral-900 text-[var(--accent)] shadow-[3px_3px_0_var(--accent)]"
                      : "bg-white text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)] hover:-translate-y-0.5 hover:translate-x-0.5 hover:shadow-[5px_5px_0_var(--accent)]"
                  }`}
                >
                  <span className="block text-xs font-black uppercase tracking-wider">
                    {p.label}
                  </span>
                  <span
                    className={`mt-0.5 block font-mono text-[10px] font-bold ${
                      active ? "text-white/80" : "text-neutral-500"
                    }`}
                  >
                    {p.badge}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-7 rounded-none border-[3px] border-neutral-900 bg-white p-6 shadow-[6px_6px_0_rgba(17,17,17,1)] md:grid-cols-3 md:gap-8 md:p-8">
          <div className="flex flex-col justify-between">
            <div className="mb-4 flex h-8 items-center justify-between">
              <span className={labelCls}>Max Clip Length</span>
              <span className="font-mono text-xs font-bold text-[var(--accent)]">
                {clipSec} SEC / PART
              </span>
            </div>
            <div className="flex h-10 items-center">
              <Segmented
                options={[
                  { value: 15, label: "15s" },
                  { value: 30, label: "30s (Std)" },
                  { value: 60, label: "60s (Max)" },
                ]}
                value={clipSec}
                onChange={setClipSec}
                label="WhatsApp Status max clip duration"
                fullWidth
              />
            </div>
          </div>

          <div className="flex flex-col justify-between">
            <div className="mb-4 flex h-8 items-center justify-between">
              <span className={labelCls}>Status Bitrate</span>
              <span className="font-mono text-lg font-black text-neutral-900">
                {(bitrateKbps / 1000).toFixed(1)} Mbps
              </span>
            </div>
            <div className="flex h-10 items-center">
              <input
                type="range"
                min="500"
                max="3000"
                step="100"
                value={bitrateKbps}
                onChange={(e) => setBitrateKbps(Number(e.target.value))}
                style={{ "--p": `${brPct}%` }}
                className="cc-range"
              />
            </div>
          </div>

          <div className="flex flex-col justify-between">
            <div className="mb-4 flex h-8 items-center justify-between">
              <span className={labelCls}>Resolution</span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-400">
                WA ANTI-BLUR
              </span>
            </div>
            <div className="flex h-10 items-center">
              <Segmented
                options={[
                  { value: 720, label: "720p HD" },
                  { value: 480, label: "480p Fast" },
                ]}
                value={maxHeight}
                onChange={setMaxHeight}
                label="Status resolution"
                fullWidth
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex items-center gap-3">
            <span className={labelCls}>Format</span>
            <Segmented
              options={[
                { value: "mp4", label: "MP4", disabled: !supported.mp4 },
                { value: "webm", label: "WebM", disabled: !supported.webm },
              ]}
              value={format}
              onChange={setFormat}
              label="Video format"
            />
          </div>

          <label className="flex cursor-pointer select-none items-center gap-3 text-xs font-black uppercase tracking-wider text-neutral-900">
            <div className="relative flex items-center">
              <input
                type="checkbox"
                checked={muteAudio}
                onChange={(e) => setMuteAudio(e.target.checked)}
                className="peer sr-only"
              />
              <div className="h-6 w-6 rounded-none border-[3px] border-neutral-900 bg-white transition-colors duration-200 peer-checked:bg-[var(--accent)]" />
              <svg
                className={`pointer-events-none absolute inset-0 h-6 w-6 stroke-neutral-900 stroke-[3px] transition-transform duration-200 ${
                  muteAudio ? "scale-100" : "scale-0"
                }`}
                fill="none"
                viewBox="0 0 24 24"
                strokeLinecap="square"
                strokeLinejoin="miter"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            Mute status audio
          </label>
        </div>
      </section>

      <section>
        <StepLabel n={3}>Split, optimize & download</StepLabel>

        <div className="flex flex-col items-stretch gap-6">
          <div className="w-full sm:w-auto sm:self-start">
            <button
              type="button"
              onClick={runWhatsappSplit}
              disabled={!activeVideo || isProcessing}
              className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors sm:min-w-[24rem] md:text-base ${
                !activeVideo || isProcessing
                  ? "pointer-events-none cursor-not-allowed bg-neutral-200 text-neutral-400 border-neutral-300"
                  : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
              }`}
            >
              <span>
                {isProcessing
                  ? "Splitting & Optimizing..."
                  : expectedClips > 1
                  ? `Split into ${expectedClips} Status Clips (${clipSec}s)`
                  : "Optimize for WhatsApp Status"}
              </span>
              {!isProcessing && expectedClips > 0 && (
                <span className="rounded-full bg-neutral-900 px-2.5 py-1 font-mono text-[11px] leading-none text-white">
                  {expectedClips} {expectedClips === 1 ? "clip" : "clips"}
                </span>
              )}
              <svg
                className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>

          {splitParts.length > 0 && (
            <div className="w-full rounded-none border-[3px] border-neutral-900 bg-white p-5 text-left shadow-[6px_6px_0_rgba(17,17,17,1)] md:max-w-2xl md:p-6 lg:p-8">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center border-2 border-neutral-900 bg-[var(--accent)] text-neutral-900">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wide text-neutral-900 md:text-base">
                    WhatsApp Status Clips Ready ({splitParts.length}{" "}
                    {splitParts.length === 1 ? "Part" : "Parts"})
                  </h3>
                  <p className="mt-1 text-xs font-medium text-neutral-500">
                    Post these parts in order on WhatsApp Status for a seamless
                    story.
                  </p>
                </div>
              </div>

              {zipDownload && (
                <a
                  href={zipDownload.url}
                  download={zipDownload.name}
                  className="mt-5 flex items-center justify-between border-[3px] border-neutral-900 bg-[var(--accent)] px-4 py-3 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                >
                  <span>Download All {splitParts.length} Clips (.zip)</span>
                  <span className="font-mono text-[11px]">
                    {formatBytes(zipDownload.size)}
                  </span>
                </a>
              )}

              <div className="mt-6 space-y-5 border-t-2 border-neutral-100 pt-5">
                {splitParts.map((part) => (
                  <div
                    key={part.name}
                    className="space-y-3 border-[3px] border-neutral-900 bg-neutral-50 p-4 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="border-2 border-neutral-900 bg-[#FFE600] px-2.5 py-0.5 font-mono text-[11px] font-black uppercase text-neutral-900">
                        Part {part.partNumber} of {part.totalParts} (
                        {formatDuration(part.startSec)} –{" "}
                        {formatDuration(part.endSec)})
                      </span>
                      <span className="font-mono text-xs font-bold text-neutral-500">
                        {formatBytes(part.size)}
                      </span>
                    </div>

                    <video
                      src={part.url}
                      controls
                      playsInline
                      className="max-h-60 w-full border-2 border-neutral-900 bg-black"
                    />

                    <a
                      href={part.url}
                      download={part.name}
                      className="flex items-center justify-between border-[2px] border-neutral-900 bg-[var(--accent)] px-4 py-2.5 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
                    >
                      <span className="truncate">
                        Download Part {part.partNumber}
                      </span>
                      <span className="font-mono text-[11px]">{part.name}</span>
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}

          {failed && (
            <div className="w-full border-[3px] border-neutral-900 bg-red-50 p-4 text-xs font-bold text-red-600 shadow-[4px_4px_0_rgba(17,17,17,1)] md:max-w-2xl">
              {failed}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default memo(WhatsappStatusSplitter);
