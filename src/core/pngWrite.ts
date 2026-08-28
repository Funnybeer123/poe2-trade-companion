import { deflateSync } from "node:zlib";

import type { BgrImage } from "./cellOccupancy.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeBuf, data));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a BGR pixel buffer as an 8-bit truecolor PNG. */
export function encodeBgrPng(image: BgrImage): Buffer {
  const { width, height, data } = image;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 3;
      const dst = rowStart + 1 + x * 3;
      raw[dst] = data[src + 2]!;
      raw[dst + 1] = data[src + 1]!;
      raw[dst + 2] = data[src]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
