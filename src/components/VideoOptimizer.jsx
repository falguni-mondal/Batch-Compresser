"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { LoadingOverlay } from "@/components/PixelLoader";
import VideoDropzone from "@/components/VideoDropzone";
import {
  Segmented,
  StepLabel,
  formatBytes,
  labelCls,
  stripExt,
} from "@/components/StepHeader";
import {
  compressVideoLocally,
  getSupportedVideoFormats,
  probeVideoMetadata,
} from "@/lib/localVideoCompress";
import { VIDEO_LIMITS, getVideoLimits, isMobileDevice } from "@/lib/device";

const VIDEO_PLATFORM_PRESETS = [
  {
    label: "Web Optimized",
    badge: "1080p · 2.5 Mbps · Fast Stream",
    h: 1080,
    br: 2500,
    fps: 30,
  },
  {
    label: "4K Ultra HD",
    badge: "2160p (4K) · 12 Mbps · 30fps",
    h: 2160,
    br: 12000,
    fps: 30,
  },
  {
    label: "2K QHD",
    badge: "1440p (2K) · 8 Mbps · 30fps",
    h: 1440,
    br: 8000,
    fps: 30,
  },
  {
    label: "YouTube HD",
    badge: "1080p · 4.5 Mbps · 30fps",
    h: 1080,
    br: 4500,
    fps: 30,
  },
  {
    label: "Instagram / Reels",
    badge: "1080p · 3.5 Mbps · 30fps",
    h: 1080,
    br: 3500,
    fps: 30,
  },
  {
    label: "Facebook HD",
    badge: "720p · 2.2 Mbps · 30fps",
    h: 720,
    br: 2200,
    fps: 30,
  },
  {
    label: "WhatsApp / Chat",
    badge: "720p · 1.2 Mbps · 30fps",
    h: 720,
    br: 1200,
    fps: 30,
  },
];

function VideoOptimizer() {
  const [limits, setLimits] = useState({
    ...VIDEO_LIMITS.desktop,
    maxFileBytes: VIDEO_LIMITS.desktop.maxFileMB * 1024 * 1024,
  });
  const [mobile, setMobile] = useState(false);

  const [videos, setVideos] = useState([]);
  const [maxHeight, setMaxHeight] = useState(VIDEO_LIMITS.desktop.defaultHeightPx);

  useEffect(() => {
    const l = getVideoLimits();
    setLimits(l);
    setMobile(isMobileDevice());
    setMaxHeight(l.defaultHeightPx);
  }, []);
  const [bitrateKbps, setBitrateKbps] = useState(2500);
  const [fps, setFps] = useState(30);
  const [format, setFormat] = useState("mp4");
  const [muteAudio, setMuteAudio] = useState(false);
  const [supported, setSupported] = useState({ mp4: true, webm: true });

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState([]);
  const [failed, setFailed] = useState([]);

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
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const current = [...videos];
    const warnings = [];

    for (const file of incoming) {
      if (
        !file.type.startsWith("video/") &&
        !/\.(mp4|webm|mov|m4v)$/i.test(file.name)
      ) {
        warnings.push(
          `"${file.name}" skipped: only MP4, WebM, and MOV are supported`
        );
        continue;
      }
      if (current.length >= limits.maxFiles) {
        warnings.push(
          `Batch limit: up to ${limits.maxFiles} video${
            limits.maxFiles === 1 ? "" : "s"
          } per batch on this ${mobile ? "phone" : "device"}`
        );
        break;
      }
      if (file.size > limits.maxFileBytes) {
        warnings.push(
          `"${file.name}" skipped: exceeds the ${
            limits.maxFileMB
          } MB limit on this ${mobile ? "phone" : "device"}`
        );
        continue;
      }

      try {
        const meta = await probeVideoMetadata(file);
        if (meta.duration > limits.maxDurationSec) {
          warnings.push(
            `"${file.name}" skipped: ${Math.round(
              meta.duration
            )}s exceeds the ${limits.maxDurationSec}s limit on this ${
              mobile ? "phone" : "device"
            }`
          );
          continue;
        }
        current.push({
          id: `${file.name}-${file.size}-${Date.now()}`,
          file,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
        });
      } catch (err) {
        warnings.push(err.message);
      }
    }

    setVideos(current);
    setNotice(warnings.join(". "));
  };

  const runVideoCompress = async () => {
    if (!videos.length || isProcessing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);
    setProgress(0);
    revokeUrls();
    setResults([]);
    setFailed([]);

    const out = [];
    const errs = [];

    try {
      for (let i = 0; i < videos.length; i++) {
        if (controller.signal.aborted) break;
        const item = videos[i];
        try {
          const res = await compressVideoLocally(item.file, {
            maxHeight,
            videoBitrate: bitrateKbps * 1000,
            fps,
            format,
            muteAudio,
            signal: controller.signal,
            onProgress: (p) => {
              const overall = Math.round(((i + p / 100) / videos.length) * 100);
              setProgress(overall);
            },
          });
          const outName = `${stripExt(item.file.name)}_${res.height}p.${
            res.format
          }`;
          const url = URL.createObjectURL(res.blob);
          urlsRef.current.push(url);
          out.push({
            name: outName,
            url,
            originalSize: item.file.size,
            size: res.blob.size,
            width: res.width,
            height: res.height,
            format: res.format,
          });
        } catch (err) {
          if (err?.code !== "CANCELLED") {
            errs.push({ name: item.file.name, reason: err.message });
          }
        }
      }
      setResults(out);
      setFailed(errs);
      if (out.length > 0) setVideos([]);
    } finally {
      setIsProcessing(false);
      abortRef.current = null;
    }
  };

  const brPct = Math.min(
    100,
    Math.max(0, ((bitrateKbps - 400) / (16000 - 400)) * 100)
  );

  const resOptions = [
    {
      value: 2160,
      label: "4K",
      disabled: limits.maxHeightPx < 2160,
      title:
        limits.maxHeightPx < 2160 ? "4K is available on PC/Laptop" : "2160p 4K",
    },
    { value: 1440, label: "2K", title: "1440p QHD" },
    { value: 1080, label: "1080p" },
    { value: 720, label: "720p" },
    { value: 480, label: "480p" },
  ];

  return (
    <div className="space-y-14 sm:space-y-20">
      {isProcessing && (
        <LoadingOverlay
          title="Compressing & converting video"
          detail={`${progress}% complete · Keep this tab open`}
          progress={progress}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      <section>
        <StepLabel n={1}>Add your video</StepLabel>

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
          onRemoveVideo={(id) =>
            setVideos((prev) => prev.filter((v) => v.id !== id))
          }
          onClearVideos={() => {
            setVideos([]);
            revokeUrls();
            setResults([]);
          }}
        />
      </section>

      <section>
        <StepLabel n={2}>Choose your settings</StepLabel>

        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start">
          <span className={`${labelCls} pt-2 sm:w-32 sm:shrink-0`}>
            Quick Presets
          </span>
          <div className="flex flex-wrap gap-2.5">
            {VIDEO_PLATFORM_PRESETS.map((p) => {
              const clampedH = Math.min(p.h, limits.maxHeightPx);
              const active =
                maxHeight === clampedH &&
                bitrateKbps === p.br &&
                fps === p.fps;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setMaxHeight(clampedH);
                    setBitrateKbps(p.br);
                    setFps(p.fps);
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
              <span className={labelCls}>Resolution</span>
              <span className="font-mono text-xs font-bold text-neutral-400">
                {maxHeight === 2160
                  ? "4K UHD"
                  : maxHeight === 1440
                  ? "2K QHD"
                  : `${maxHeight}P`}
              </span>
            </div>
            <div className="flex h-10 items-center">
              <Segmented
                options={resOptions}
                value={maxHeight}
                onChange={setMaxHeight}
                label="Video resolution"
                fullWidth
              />
            </div>
          </div>

          <div className="flex flex-col justify-between">
            <div className="mb-4 flex h-8 items-center justify-between">
              <span className={labelCls}>Bitrate</span>
              <span className="font-mono text-lg font-black text-neutral-900">
                {(bitrateKbps / 1000).toFixed(1)} Mbps
              </span>
            </div>
            <div className="flex h-10 items-center">
              <input
                type="range"
                min="400"
                max="16000"
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
              <span className={labelCls}>Format</span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--accent)]">
                LOCAL ENCODE
              </span>
            </div>
            <div className="flex h-10 items-center">
              <Segmented
                options={[
                  { value: "mp4", label: "MP4", disabled: !supported.mp4 },
                  { value: "webm", label: "WebM", disabled: !supported.webm },
                ]}
                value={format}
                onChange={setFormat}
                label="Output video format"
                fullWidth
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex items-center gap-3">
            <span className={labelCls}>Frame Rate</span>
            <Segmented
              options={[
                { value: 24, label: "24 FPS" },
                { value: 30, label: "30 FPS" },
                { value: 60, label: "60 FPS" },
              ]}
              value={fps}
              onChange={setFps}
              label="Frame rate"
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
            Remove audio track (Mute video)
          </label>
        </div>
      </section>

      <section>
        <StepLabel n={3}>Compress and download</StepLabel>

        <div className="flex flex-col items-stretch gap-6">
          <div className="w-full sm:w-auto sm:self-start">
            <button
              type="button"
              onClick={runVideoCompress}
              disabled={videos.length === 0 || isProcessing}
              className={`group relative flex h-14 w-full items-center justify-center gap-3 rounded-none border-[3px] border-neutral-900 px-6 text-sm font-black uppercase tracking-widest transition-colors sm:min-w-[22rem] md:text-base ${
                videos.length === 0 || isProcessing
                  ? "pointer-events-none cursor-not-allowed bg-neutral-200 text-neutral-400 border-neutral-300"
                  : "cursor-pointer bg-[var(--accent)] text-neutral-900 neo-shadow"
              }`}
            >
              <span>
                {isProcessing
                  ? "Compressing Video..."
                  : "Compress & Download Video"}
              </span>
              {!isProcessing && videos.length > 0 && (
                <span className="rounded-full bg-neutral-900 px-2.5 py-1 font-mono text-[11px] leading-none text-white">
                  {videos.length}
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

          {results.length > 0 && (
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
                    Video Compression Complete
                  </h3>
                  <p className="mt-1 text-xs font-medium text-neutral-500">
                    Your optimized video is ready to preview or download.
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-5">
                {results.map((r) => {
                  const saved =
                    r.originalSize > 0
                      ? Math.round(
                          ((r.originalSize - r.size) / r.originalSize) * 100
                        )
                      : 0;
                  return (
                    <div
                      key={r.name}
                      className="space-y-4 border-t-2 border-neutral-100 pt-5"
                    >
                      <video
                        src={r.url}
                        controls
                        playsInline
                        className="max-h-72 w-full border-[3px] border-neutral-900 bg-black"
                      />
                      <div className="flex items-end justify-between gap-4">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">
                            Original
                          </p>
                          <p className="font-mono text-sm font-medium text-neutral-400 line-through">
                            {formatBytes(r.originalSize)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold uppercase tracking-widest text-neutral-900">
                            New Size ({r.width}×{r.height})
                          </p>
                          <p className="font-mono text-2xl font-black text-neutral-900 md:text-3xl">
                            {formatBytes(r.size)}
                          </p>
                        </div>
                      </div>
                      <a
                        href={r.url}
                        download={r.name}
                        className="flex items-center justify-between border-[3px] border-neutral-900 bg-[var(--accent)] px-4 py-3 text-xs font-black uppercase tracking-wider text-neutral-900 shadow-[3px_3px_0_rgba(17,17,17,1)]"
                      >
                        <span className="truncate">Download {r.name}</span>
                        <span className="font-mono text-[11px]">
                          {saved >= 0 ? `Saved ${saved}%` : formatBytes(r.size)}
                        </span>
                      </a>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div className="w-full border-[3px] border-neutral-900 bg-red-50 p-4 text-xs font-bold text-red-600 shadow-[4px_4px_0_rgba(17,17,17,1)] md:max-w-2xl">
              {failed[0].name}: {failed[0].reason}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default memo(VideoOptimizer);
