import { readFileSync } from "node:fs";

export function readBmpBgr(path: string): { width: number; height: number; data: Buffer } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 2) !== "BM") {
    throw new Error("not-bmp");
  }
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) {
    throw new Error(`unsupported-bmp-${bpp}`);
  }
  const rowBytes = Math.ceil((width * bpp) / 32) * 4;
  const topDown = buf.readInt32LE(22) < 0;
  const data = Buffer.alloc(width * height * 3);
  if (bpp === 24) {
    // Rows are already BGR triplets — bulk-copy each row instead of per-pixel.
    for (let y = 0; y < height; y += 1) {
      const srcY = topDown ? y : height - 1 - y;
      const row = offset + srcY * rowBytes;
      buf.copy(data, y * width * 3, row, row + width * 3);
    }
    return { width, height, data };
  }
  for (let y = 0; y < height; y += 1) {
    const srcY = topDown ? y : height - 1 - y;
    const row = offset + srcY * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * 4;
      const dst = (y * width + x) * 3;
      data[dst] = buf[src];
      data[dst + 1] = buf[src + 1];
      data[dst + 2] = buf[src + 2];
    }
  }
  return { width, height, data };
}

export function bgrToGray(image: {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}): { width: number; height: number; pixels: Uint8Array } {
  const { width, height, data } = image;
  const pixels = new Uint8Array(width * height);
  // Integer BT.601 luma: (306r + 601g + 117b + 512) >> 10 == round(0.299r + 0.587g + 0.114b) ± 1.
  for (let i = 0; i < pixels.length; i += 1) {
    const j = i * 3;
    pixels[i] = (306 * data[j + 2]! + 601 * data[j + 1]! + 117 * data[j]! + 512) >> 10;
  }
  return { width, height, pixels };
}

export function bmpToGray(path: string): { width: number; height: number; pixels: Uint8Array } {
  return bgrToGray(readBmpBgr(path));
}
