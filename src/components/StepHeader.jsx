"use client";

export const labelCls =
  "mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-black uppercase tracking-widest text-neutral-900";

export function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

export const stripExt = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
};

export function StepLabel({ n, children }) {
  return (
    <div className="relative mb-6 flex items-center pt-4 sm:mb-8 sm:pt-6">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 -top-1 z-0 select-none font-[family-name:var(--font-pixel)] text-[4.25rem] leading-none text-neutral-900/5 sm:-left-3 sm:-top-2 sm:text-[7rem]"
      >
        {n}
      </span>
      <h2 className="relative z-10 break-words text-lg font-black uppercase tracking-tight text-neutral-900 sm:text-2xl">
        {children}
      </h2>
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  label,
  fullWidth = false,
}) {
  const many = options.length >= 4;
  return (
    <div
      role="group"
      aria-label={label}
      className={`overflow-hidden rounded-none border-[3px] border-neutral-900 bg-white shadow-[3px_3px_0_rgba(17,17,17,1)] ${
        fullWidth
          ? "flex w-full"
          : many
          ? "grid w-full grid-cols-2 sm:inline-flex sm:w-fit"
          : "flex w-full sm:w-fit"
      }`}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const borderCls = many
          ? `${i % 2 !== 0 ? "border-l-[3px]" : ""} ${
              i >= 2 ? "border-t-[3px] sm:border-t-0" : ""
            } ${i !== 0 ? "sm:border-l-[3px]" : ""} border-neutral-900`
          : i !== 0
          ? "border-l-[3px] border-neutral-900"
          : "";

        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={o.disabled}
            title={o.title}
            aria-pressed={active}
            className={`relative min-w-0 flex-1 py-2 text-center text-[11px] font-black uppercase transition-colors focus:outline-none focus-visible:bg-neutral-200 sm:flex-initial sm:whitespace-nowrap sm:text-xs ${
              fullWidth
                ? "basis-0 px-1.5 tracking-wide sm:flex-1 sm:px-2"
                : "px-2.5 tracking-wider sm:px-4 sm:tracking-widest"
            } ${borderCls} ${
              o.disabled
                ? "cursor-not-allowed bg-neutral-100 text-neutral-300 line-through"
                : active
                ? "cursor-pointer bg-[var(--accent)] text-neutral-900"
                : "cursor-pointer bg-white text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            }`}
          >
            <span className="block truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
