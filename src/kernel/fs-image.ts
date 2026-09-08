import { createHash } from "node:crypto";
import { ReadError, readContainedBytes, type ReadOptions } from "./fs-read.js";

export const MAX_IMAGE_BYTES = 4 * 1_048_576;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const IMAGE_DISPLAY_GUIDANCE =
  "When the user asks to see this image, attach and embed it in the final answer using the client's supported file/image mechanism. " +
  "If needed, materialize the image block's base64 data as a local file and verify sha256 before attaching. " +
  "Use sandbox links only when the client actually provides such a local attachment path. " +
  "Do not print base64 or invent URLs. Model vision does not prove user-visible display; report unsupported display explicitly.";

function invalid(): never {
  throw new ReadError("invalid_encoding", "Unsupported or malformed image; expected PNG or JPEG");
}

/** Inspect container headers, not a full pixel decode. Original bytes and EXIF are preserved. */
export function imageDimensions(data: Buffer): {
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
} {
  let width = 0;
  let height = 0;
  let mimeType: "image/png" | "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = "image/png";
    let offset = 8;
    let sawData = false;
    let sawEnd = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset);
      if (size > data.length - offset - 12) invalid();
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (offset === 8) {
        if (type !== "IHDR" || size !== 13) invalid();
        width = data.readUInt32BE(offset + 8);
        height = data.readUInt32BE(offset + 12);
      } else if (type === "IHDR") invalid();
      if (type === "IDAT" && size > 0) sawData = true;
      offset += size + 12;
      if (type === "IEND") {
        if (size !== 0 || offset !== data.length) invalid();
        sawEnd = true;
        break;
      }
    }
    if (!sawData || !sawEnd) invalid();
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    mimeType = "image/jpeg";
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) invalid();
    let offset = 2;
    let sawScan = false;
    while (offset + 1 < data.length) {
      if (data[offset++] !== 0xff) invalid();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) invalid();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) invalid();
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const components = data[offset + 7];
        if (size < 8 || components === undefined || components === 0 || size !== 8 + 3 * components)
          invalid();
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
      }
      if (marker === 0xda) {
        if (size < 6 || offset + size >= data.length - 2) invalid();
        sawScan = true;
        break;
      }
      offset += size;
    }
    if (!sawScan) invalid();
  } else invalid();
  if (width <= 0 || height <= 0) invalid();
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ReadError("too_large", "Image exceeds the 25 megapixel limit");
  }
  return { mimeType, width, height };
}

export async function readContainedImage(root: string, path: string, options: ReadOptions = {}) {
  const bytes = await readContainedBytes(root, path, MAX_IMAGE_BYTES, options);
  const dimensions = imageDimensions(bytes);
  return {
    ...dimensions,
    data: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
