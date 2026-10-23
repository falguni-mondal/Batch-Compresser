"use client";

import { memo, useRef, useState } from "react";
import { formatBytes, formatDuration } from "@/components/StepHeader";

function VideoDropzone({
  videos,
  limits,
  mobile,
  onPickFiles,
  onRemoveVideo,
  onClearVideos,
  extraBadge,
}) {
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer?.files?.length) onPickFiles(e.dataTransfer.files);
      }}
      onClick={(e) => {
        if (e.target === inputRef.current) return;
        if (videos.length === 0) inputRef.current?.click();
      }}
      className={`group/dz relative flex w-full flex-col overflow-hidden rounded-none border-[3px] border-neutral-900 shadow-[6px_6px_0_rgba(17,17,17,1)] transition-colors duration-200 ${
        videos.length > 0
          ? "min-h-[260px] bg-white"
          : `h-[280px] cursor-pointer items-center justify-center md:h-[320px] ${
              isDragging ? "bg-[var(--accent)]" : "bg-white hover:bg-neutral-50"
            }`
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
        multiple={limits.maxFiles > 1}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files?.length) onPickFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {videos.length > 0 ? (
        <div className="flex h-full w-full flex-col">
          <div className="flex shrink-0 items-center justify-between border-b-[3px] border-neutral-900 bg-white px-5 py-4">
            <span className="text-xs font-black uppercase tracking-widest text-neutral-900">
              <span className="font-mono text-sm">{videos.length}</span>{" "}
              {videos.length === 1 ? "video" : "videos"} queued
            </span>
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearVideos();
                }}
                className="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-wider text-neutral-500 hover:text-red-600"
              >
                Clear all
              </button>
              {videos.length < limits.maxFiles && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    inputRef.current?.click();
                  }}
                  className="cursor-pointer rounded-none border-[2px] border-neutral-900 bg-[var(--accent)] px-4 py-1.5 text-xs font-black uppercase tracking-widest text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)]"
                >
                  Add more +
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-3 bg-neutral-50 p-5">
            {videos.map((v) => (
              <div
                key={v.id}
                className="flex flex-wrap items-center justify-between gap-3 border-[3px] border-neutral-900 bg-white p-4 shadow-[4px_4px_0_rgba(17,17,17,1)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-black uppercase tracking-wide text-neutral-900">
                    {v.file.name}
                  </p>
                  <p className="mt-1 font-mono text-[11px] font-bold text-neutral-500">
                    {v.width}×{v.height}px · {formatDuration(v.duration)} (
                    {Math.round(v.duration)}s) · {formatBytes(v.file.size)}
                  </p>
                  {extraBadge && extraBadge(v)}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveVideo(v.id)}
                  className="cursor-pointer border-[2px] border-neutral-900 bg-white px-3 py-1.5 text-xs font-black uppercase text-neutral-900 shadow-[2px_2px_0_rgba(17,17,17,1)] hover:bg-[var(--accent)]"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="pointer-events-none flex flex-col items-center justify-center px-4 text-center">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-none border-[3px] border-neutral-900 bg-[var(--accent)] text-neutral-900 shadow-[4px_4px_0_rgba(17,17,17,1)] transition-colors duration-200 group-hover/dz:bg-white">
            <svg
              className="h-8 w-8"
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
            Click to select video{" "}
            <span className="text-neutral-500">or drag & drop</span>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="mr-2 font-mono text-[11px] font-bold uppercase tracking-widest text-neutral-400">
              Supports
            </span>
            {["MP4", "WEBM", "MOV"].map((t) => (
              <span
                key={t}
                className="rounded-none border-[2px] border-neutral-900 bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-neutral-900"
              >
                {t}
              </span>
            ))}
            <span className="ml-2 font-mono text-[10px] font-bold uppercase text-neutral-400">
              Max {limits.maxFileMB}MB · {Math.round(limits.maxDurationSec / 60)}m (
              {mobile ? "Phone" : "PC"})
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(VideoDropzone);
