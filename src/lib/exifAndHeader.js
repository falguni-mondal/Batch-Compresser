// Image binary header parser, EXIF orientation reader, format signature verifier,
// and multi-fallback input materializer.

import { isHeicFile } from "./fileTypes";

const INPUT_HEADER_BYTES = 256 * 1024;
const OUTPUT_HEADER_BYTES = 32 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ascii = (bytes, start, end) =>
  String.fromCharCode(...bytes.subarray(start, end));

function readViaFileReaderSyncOrAsync(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReaderSync !== "undefined") {
      try {
        const syncReader = new FileReaderSync();
        resolve(syncReader.readAsArrayBuffer(blob));
        return;
      } catch {}
    }
    if (typeof FileReader === "undefined") {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
}

function readViaObjectUrlFetch(blob) {
  return new Promise((resolve, reject) => {
    if (typeof URL === "undefined" || typeof fetch === "undefined") {
      reject(new Error("ObjectURL fetch unavailable"));
      return;
    }
    const url = URL.createObjectURL(blob);
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((ab) => {
        URL.revokeObjectURL(url);
        resolve(ab);
      })
      .catch((err) => {
        URL.revokeObjectURL(url);
        reject(err);
      });
  });
}

export async function readFileBytesWithRetry(file) {
  if (file instanceof Uint8Array) return file.buffer;
  if (file instanceof ArrayBuffer) return file;

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (typeof file.arrayBuffer === "function") {
        const ab = await file.arrayBuffer();
        if (ab && ab.byteLength > 0) return ab;
      }
    } catch (e) {
      lastError = e;
    }
    try {
      const ab = await readViaFileReaderSyncOrAsync(file);
      if (ab && ab.byteLength > 0) return ab;
    } catch (e) {
      lastError = e;
    }
    try {
      const ab = await readViaObjectUrlFetch(file);
      if (ab && ab.byteLength > 0) return ab;
    } catch (e) {
      lastError = e;
    }
    if (attempt < 3) await sleep(100 * (attempt + 1));
  }
  const reason = lastError
    ? `${lastError.name || "Error"}: ${
        lastError.message || "could not read file"
      }`
    : "file is empty or unreadable";
  throw new Error(`Could not read "${file?.name || "file"}" - ${reason}`);
}

export async function materializeInput(file) {
  const name = file?.name || "image";
  const type = file?.type || "";
  const heic = isHeicFile(file);

  if (file instanceof Uint8Array) {
    return {
      bytes: file,
      blob: new Blob([file], { type: type || "application/octet-stream" }),
      name,
      type,
      heic,
    };
  }

  const ab = await readFileBytesWithRetry(file);
  const bytes = new Uint8Array(ab);
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });
  return { bytes, blob, name, type, heic };
}

function parseExifOrientation(b, app1Start, segLen) {
  try {
    const end = Math.min(b.length, app1Start + segLen);
    if (end - app1Start < 14) return 1;
    if (
      b[app1Start + 2] !== 0x45 ||
      b[app1Start + 3] !== 0x78 ||
      b[app1Start + 4] !== 0x69 ||
      b[app1Start + 5] !== 0x66 ||
      b[app1Start + 6] !== 0x00 ||
      b[app1Start + 7] !== 0x00
    ) {
      return 1;
    }
    const tiff = app1Start + 8;
    const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
    const u16 = (o) =>
      little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
    const u32 = (o) =>
      little
        ? (b[o] |
            (b[o + 1] << 8) |
            (b[o + 2] << 16) |
            (b[o + 3] << 24)) >>>
          0
        : ((b[o] << 24) |
            (b[o + 1] << 16) |
            (b[o + 2] << 8) |
            b[o + 3]) >>>
          0;

    if (u16(tiff + 2) !== 0x002a) return 1;
    const ifd0 = tiff + u32(tiff + 4);
    if (ifd0 + 2 > end) return 1;
    const entries = u16(ifd0);
    for (let e = 0; e < entries; e++) {
      const pos = ifd0 + 2 + e * 12;
      if (pos + 12 > end) break;
      if (u16(pos) === 0x0112) {
        const val = u16(pos + 8);
        return val >= 1 && val <= 8 ? val : 1;
      }
    }
  } catch {}
  return 1;
}

export async function getImageSize(
  fileOrBytes,
  maxBytes = INPUT_HEADER_BYTES
) {
  try {
    let b;
    if (fileOrBytes instanceof Uint8Array) {
      b =
        fileOrBytes.length > maxBytes
          ? fileOrBytes.subarray(0, maxBytes)
          : fileOrBytes;
    } else {
      const slice = fileOrBytes.slice(0, maxBytes);
      b = new Uint8Array(await readFileBytesWithRetry(slice));
    }
    if (b.length < 30) return null;

    if (
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47
    ) {
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return {
        width: view.getUint32(16),
        height: view.getUint32(20),
        rotated: false,
      };
    }

    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      let orientation = 1;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        while (i < b.length && b[i] === 0xff) i++;
        if (i + 7 >= b.length) break;
        const marker = b[i];
        if (
          marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd9)
        ) {
          i += 2;
          continue;
        }
        const segLen = (b[i + 2] << 8) | b[i + 3];
        if (segLen < 2) break;
        if (marker === 0xe1 && orientation === 1) {
          orientation = parseExifOrientation(b, i + 2, segLen);
        }
        const isSOF =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc;
        if (isSOF) {
          const rawH = (b[i + 5] << 8) | b[i + 6];
          const rawW = (b[i + 7] << 8) | b[i + 8];
          if (!rawW || !rawH) return null;
          const rotated = orientation >= 5 && orientation <= 8;
          return {
            width: rotated ? rawH : rawW,
            height: rotated ? rawW : rawH,
            rotated,
          };
        }
        i += 2 + segLen;
      }
      return null;
    }

    const tag = String.fromCharCode(
      b[0],
      b[1],
      b[2],
      b[3],
      b[8],
      b[9],
      b[10],
      b[11]
    );
    if (tag === "RIFFWEBP") {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8 ") {
        return {
          width: (b[26] | (b[27] << 8)) & 0x3fff,
          height: (b[28] | (b[29] << 8)) & 0x3fff,
          rotated: false,
        };
      }
      if (chunk === "VP8L") {
        return {
          width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
          height:
            1 +
            (((b[24] & 0x0f) << 10) |
              (b[23] << 2) |
              ((b[22] & 0xc0) >> 6)),
          rotated: false,
        };
      }
      if (chunk === "VP8X") {
        return {
          width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
          height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
          rotated: false,
        };
      }
    }
  } catch {}
  return null;
}

export function matchesFormatSignature(bytes, format) {
  if (!bytes || bytes.length < 12) return false;
  switch (format) {
    case "png":
      return bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG";
    case "jpg":
    case "jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "avif":
      return (
        ascii(bytes, 4, 8) === "ftyp" &&
        /avif|avis/.test(ascii(bytes, 8, Math.min(bytes.length, 32)))
      );
    default:
      return false;
  }
}

export async function verifyOutput(blob, format, width, height) {
  if (!blob || blob.size === 0) {
    throw new Error("the encoder produced an empty file");
  }

  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (!matchesFormatSignature(head, format)) {
    throw new Error(
      `the result is not a valid ${format.toUpperCase()} file`
    );
  }

  if (format !== "avif") {
    const size = await getImageSize(blob, OUTPUT_HEADER_BYTES);
    if (size && (size.width !== width || size.height !== height)) {
      throw new Error(
        `the result is ${size.width}x${size.height}px but ${width}x${height}px was expected`
      );
    }
  }
}
