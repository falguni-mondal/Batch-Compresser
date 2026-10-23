// Local Passport & Stamp Size Photo Sheet Generator
//
// Exact Physical Specifications:
//   - Passport Photo Size : 3.5 cm × 4.5 cm (35 mm × 45 mm) -> Max 8 copies per sheet
//   - Stamp Photo Size    : 2.0 cm × 2.5 cm (20 mm × 25 mm) -> Max 9 copies per sheet
//
// Supported Paper / Output Sizes (at 300 DPI print calibration):
//   - `single` : Soft copy of 1 photo (3.5×4.5 cm @ 450 DPI = 620×797 px, or 2.0×2.5 cm @ 450 DPI = 354×443 px)
//   - `6x4`    : 6 × 4 inch sheet (15.24 cm × 10.16 cm = 1800 × 1200 px @ 300 DPI)
//   - `a4`     : A4 sheet (21.0 cm × 29.7 cm = 2480 × 3508 px @ 300 DPI)
//   - `5x7`    : 5 × 7 inch sheet (17.78 cm × 12.70 cm = 2100 × 1500 px @ 300 DPI)
//   - `a5`     : A5 sheet (14.8 cm × 21.0 cm = 1748 × 2480 px @ 300 DPI)
//
// Strict Max Copies Rule:
//   - On any multi-photo sheet (`6x4`, `a4`, `5x7`, `a5`), choosing `Max` places at most:
//       * 8 copies for Passport Size (3.5 cm × 4.5 cm) with proper cutting gaps
//       * 9 copies for Stamp Size (2.0 cm × 2.5 cm) with proper cutting gaps
//     regardless of remaining blank space on the page.

import { MIME, canEncode, canvasToBlob, makeCanvas } from "./encodeCore";

export const PHOTO_SPECS = {
  passport: {
    id: "passport",
    label: "Passport Size (3.5 × 4.5 cm)",
    shortLabel: "Passport (3.5×4.5 cm)",
    widthCm: 3.5,
    heightCm: 4.5,
    maxCopiesPerSheet: 8,
    defaultCols: 4, // 4 columns × 2 rows = 8 max copies
  },
  stamp: {
    id: "stamp",
    label: "Stamp Size (2.0 × 2.5 cm)",
    shortLabel: "Stamp (2.0×2.5 cm)",
    widthCm: 2.0,
    heightCm: 2.5,
    maxCopiesPerSheet: 9,
    defaultCols: 3, // 3 columns × 3 rows = 9 max copies
  },
};

export const PAPER_SPECS = {
  single: {
    id: "single",
    label: "Single (Soft Copy)",
    desc: "Digital 1-photo file (exact cm ratio)",
    isSingle: true,
    dpi: 450,
  },
  "6x4": {
    id: "6x4",
    label: "6 × 4 inch",
    desc: "Standard photo lab print (15.24 × 10.16 cm)",
    widthCm: 15.24,
    heightCm: 10.16,
    dpi: 300,
  },
  a4: {
    id: "a4",
    label: "A4 Sheet",
    desc: "Standard office/home printer (21.0 × 29.7 cm)",
    widthCm: 21.0,
    heightCm: 29.7,
    dpi: 300,
  },
  "5x7": {
    id: "5x7",
    label: "7 × 5 inch",
    desc: "Medium photo sheet (17.78 × 12.70 cm)",
    widthCm: 17.78,
    heightCm: 12.7,
    dpi: 300,
  },
  a5: {
    id: "a5",
    label: "A5 Sheet",
    desc: "Half-A4 print sheet (14.8 × 21.0 cm)",
    widthCm: 14.8,
    heightCm: 21.0,
    dpi: 300,
  },
};

export const PASSPORT_BG_PRESETS = [
  {
    id: "muted-blue",
    label: "Muted Blue",
    hex: "#6B8EAD",
    badge: "Default",
  },
  {
    id: "off-white",
    label: "Off-White",
    hex: "#F5F4EE",
    badge: "Preset",
  },
  {
    id: "sky-blue",
    label: "Passport Blue",
    hex: "#8FB1CC",
  },
  {
    id: "pure-white",
    label: "Pure White",
    hex: "#FFFFFF",
  },
  {
    id: "light-grey",
    label: "Studio Grey",
    hex: "#E5E7EB",
  },
  {
    id: "custom",
    label: "Custom Color",
    hex: null,
  },
  {
    id: "original",
    label: "Original BG",
    hex: "transparent",
  },
];

const cmToPx = (cm, dpi = 300) => Math.round((cm / 2.54) * dpi);

/**
 * Returns the maximum allowed copies for a given photoType and paperSize.
 * - `single` paper size -> always 1 copy
 * - Any sheet size (`6x4`, `a4`, `5x7`, `a5`) -> 8 for Passport (3.5×4.5cm), 9 for Stamp (2.0×2.5cm)
 */
export function getMaxCopiesForConfig(photoType = "passport", paperSize = "6x4") {
  if (paperSize === "single") return 1;
  const spec = PHOTO_SPECS[photoType] || PHOTO_SPECS.passport;
  return spec.maxCopiesPerSheet;
}

/**
 * Renders a single cropped, background-filled passport or stamp photo onto a canvas.
 */
export function renderSinglePassportTile({
  sourceCanvas,
  photoType = "passport",
  dpi = 300,
  bgColor = "#6B8EAD",
  zoom = 1,
  panX = 0,
  panY = 0,
  drawCutBorder = true,
}) {
  const spec = PHOTO_SPECS[photoType] || PHOTO_SPECS.passport;
  const tileW = cmToPx(spec.widthCm, dpi);
  const tileH = cmToPx(spec.heightCm, dpi);

  const canvas = makeCanvas(tileW, tileH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // 1. Fill background color (unless keeping original opaque image)
  if (bgColor && bgColor !== "transparent") {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, tileW, tileH);
  } else {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, tileW, tileH);
  }

  // 2. Compute center-cover crop with user zoom & pan
  if (sourceCanvas) {
    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;
    const targetAspect = tileW / tileH;
    const srcAspect = srcW / srcH;

    let baseCropW;
    let baseCropH;
    if (srcAspect > targetAspect) {
      baseCropH = srcH;
      baseCropW = srcH * targetAspect;
    } else {
      baseCropW = srcW;
      baseCropH = srcW / targetAspect;
    }

    const z = Math.max(1, Math.min(3, Number(zoom) || 1));
    const cropW = baseCropW / z;
    const cropH = baseCropH / z;

    const maxShiftX = (srcW - cropW) / 2;
    const maxShiftY = (srcH - cropH) / 2;
    const normPanX = Math.max(-50, Math.min(50, Number(panX) || 0)) / 50;
    const normPanY = Math.max(-50, Math.min(50, Number(panY) || 0)) / 50;

    // Default slight upward bias (-8% Y) if panY is 0 so head is framed nicely
    const sx = (srcW - cropW) / 2 - normPanX * maxShiftX;
    const sy = (srcH - cropH) / 2 - normPanY * maxShiftY;

    ctx.drawImage(
      sourceCanvas,
      Math.max(0, Math.min(srcW - cropW, sx)),
      Math.max(0, Math.min(srcH - cropH, sy)),
      cropW,
      cropH,
      0,
      0,
      tileW,
      tileH
    );
  }

  // 3. Optional thin white inner collar + crisp scissor cut line
  if (drawCutBorder) {
    const strokePx = Math.max(1, Math.round(dpi / 150));
    ctx.strokeStyle = "rgba(17, 17, 17, 0.55)";
    ctx.lineWidth = strokePx;
    ctx.strokeRect(
      strokePx / 2,
      strokePx / 2,
      tileW - strokePx,
      tileH - strokePx
    );
  }

  return canvas;
}

/**
 * Renders the complete Passport/Stamp sheet (or Single soft copy) onto a canvas.
 */
export function renderPassportSheetCanvas({
  sourceCanvas,
  photoType = "passport",
  paperSize = "6x4",
  copies = 8,
  bgColor = "#6B8EAD",
  zoom = 1,
  panX = 0,
  panY = 0,
  drawCutBorder = true,
  previewScale = 1,
}) {
  const photoSpec = PHOTO_SPECS[photoType] || PHOTO_SPECS.passport;
  const paperSpec = PAPER_SPECS[paperSize] || PAPER_SPECS["6x4"];
  const effectiveDpi = Math.max(72, Math.round(paperSpec.dpi * previewScale));

  // Case 1: Single soft copy (1 image at exact 3.5×4.5 cm or 2.0×2.5 cm)
  if (paperSpec.isSingle) {
    const singleCanvas = renderSinglePassportTile({
      sourceCanvas,
      photoType,
      dpi: effectiveDpi,
      bgColor,
      zoom,
      panX,
      panY,
      drawCutBorder: false,
    });
    return {
      canvas: singleCanvas,
      width: singleCanvas.width,
      height: singleCanvas.height,
      placedCopies: 1,
      maxCopies: 1,
    };
  }

  // Case 2: Standard print sheet (6x4, A4, 5x7, A5)
  // Enforce strict upper cap: max 8 for passport (3.5×4.5cm), max 9 for stamp (2.0×2.5cm)
  const maxAllowed = photoSpec.maxCopiesPerSheet;
  const numCopies = Math.max(
    1,
    Math.min(maxAllowed, Number(copies) || maxAllowed)
  );

  const sheetW = cmToPx(paperSpec.widthCm, effectiveDpi);
  const sheetH = cmToPx(paperSpec.heightCm, effectiveDpi);

  const tileCanvas = renderSinglePassportTile({
    sourceCanvas,
    photoType,
    dpi: effectiveDpi,
    bgColor,
    zoom,
    panX,
    panY,
    drawCutBorder,
  });

  const tileW = tileCanvas.width;
  const tileH = tileCanvas.height;

  // Proper gapping between photos: ~0.36 cm (3.6 mm) gap so scissors can cut cleanly
  // while 4×2 passport tiles (4*3.5 = 14.0cm + 3*0.32 = 14.96cm <= 15.24cm,
  // 2*4.5 = 9.0cm + 1*0.36 = 9.36cm <= 10.16cm) fit inside 6×4 inch with outer margin!
  const gapCm = paperSize === "6x4" ? 0.28 : 0.42;
  const gapX = cmToPx(gapCm, effectiveDpi);
  const gapY = cmToPx(gapCm, effectiveDpi);

  // Determine grid columns that fit within sheet width
  let cols = photoSpec.defaultCols; // 4 for passport, 3 for stamp
  while (cols > 1 && cols * tileW + (cols - 1) * gapX > sheetW - cmToPx(0.3, effectiveDpi)) {
    cols--;
  }

  const activeCols = Math.min(cols, numCopies);
  const rows = Math.ceil(numCopies / activeCols);

  const gridW = activeCols * tileW + (activeCols - 1) * gapX;
  const gridH = rows * tileH + (rows - 1) * gapY;

  // Center horizontally; on 6x4/5x7 center vertically, on A4/A5 place with top margin (1.2 cm)
  const startX = Math.max(0, Math.round((sheetW - gridW) / 2));
  const startY =
    paperSize === "a4" || paperSize === "a5"
      ? Math.max(cmToPx(1.0, effectiveDpi), Math.min(cmToPx(1.5, effectiveDpi), Math.round((sheetH - gridH) / 2)))
      : Math.max(0, Math.round((sheetH - gridH) / 2));

  const sheetCanvas = makeCanvas(sheetW, sheetH);
  const ctx = sheetCanvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, sheetW, sheetH);

  let placed = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < activeCols; c++) {
      if (placed >= numCopies) break;
      const x = startX + c * (tileW + gapX);
      const y = startY + r * (tileH + gapY);
      ctx.drawImage(tileCanvas, x, y);

      // Subtle corner crop ticks outside each tile for easy cutting
      if (drawCutBorder) {
        const tickLen = Math.max(3, Math.round(effectiveDpi * 0.04));
        ctx.strokeStyle = "rgba(17, 17, 17, 0.35)";
        ctx.lineWidth = Math.max(1, Math.round(effectiveDpi / 200));
        ctx.beginPath();
        // Top-left
        ctx.moveTo(x - tickLen, y);
        ctx.lineTo(x, y);
        ctx.moveTo(x, y - tickLen);
        ctx.lineTo(x, y);
        // Top-right
        ctx.moveTo(x + tileW, y);
        ctx.lineTo(x + tileW + tickLen, y);
        ctx.moveTo(x + tileW, y - tickLen);
        ctx.lineTo(x + tileW, y);
        // Bottom-left
        ctx.moveTo(x - tickLen, y + tileH);
        ctx.lineTo(x, y + tileH);
        ctx.moveTo(x, y + tileH);
        ctx.lineTo(x, y + tileH + tickLen);
        // Bottom-right
        ctx.moveTo(x + tileW, y + tileH);
        ctx.lineTo(x + tileW + tickLen, y + tileH);
        ctx.moveTo(x + tileW, y + tileH);
        ctx.lineTo(x + tileW, y + tileH + tickLen);
        ctx.stroke();
      }
      placed++;
    }
  }

  tileCanvas.width = tileCanvas.height = 0;

  return {
    canvas: sheetCanvas,
    width: sheetW,
    height: sheetH,
    placedCopies: placed,
    maxCopies: maxAllowed,
  };
}

/**
 * Exports the full-resolution 300/450 DPI print sheet or single soft copy as a Blob.
 */
export async function exportPassportSheetBlob({
  sourceCanvas,
  photoType = "passport",
  paperSize = "6x4",
  copies = 8,
  bgColor = "#6B8EAD",
  zoom = 1,
  panX = 0,
  panY = 0,
  drawCutBorder = true,
  format = "jpeg",
}) {
  const outFormat =
    format === "png"
      ? "png"
      : format === "webp" && (await canEncode("webp"))
      ? "webp"
      : "jpeg";
  const mime = MIME[outFormat];

  const { canvas, width, height, placedCopies, maxCopies } =
    renderPassportSheetCanvas({
      sourceCanvas,
      photoType,
      paperSize,
      copies,
      bgColor,
      zoom,
      panX,
      panY,
      drawCutBorder,
      previewScale: 1,
    });

  try {
    const q = outFormat === "png" ? 1 : 0.96;
    const blob = await canvasToBlob(canvas, mime, q);
    if (!blob || blob.size === 0)
      throw new Error("Failed to encode passport image sheet");
    return {
      blob,
      format: outFormat,
      width,
      height,
      placedCopies,
      maxCopies,
    };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
