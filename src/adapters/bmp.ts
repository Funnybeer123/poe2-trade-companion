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
  for (let y = 0; y < height; y += 1) {
    const srcY = topDown ? y : height - 1 - y;
    const row = offset + srcY * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * (bpp / 8);
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
  for (let i = 0; i < pixels.length; i += 1) {
    const b = data[i * 3];
    const g = data[i * 3 + 1];
    const r = data[i * 3 + 2];
    pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, pixels };
}

export function bmpToGray(path: string): { width: number; height: number; pixels: Uint8Array } {
  return bgrToGray(readBmpBgr(path));
}
