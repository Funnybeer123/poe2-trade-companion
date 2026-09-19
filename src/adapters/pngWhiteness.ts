import { inflateSync } from "node:zlib";
import { channelValue, type PlaneChannel, type WhiteFrame } from "../core/followerPerception.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes the PNGs the follower recorder writes (8-bit RGB or RGBA, non-interlaced) into the
 * same single-channel plane the live capture host produces. Not a general PNG decoder.
 */
export function pngWhiteness(png: Buffer): WhiteFrame { return pngPlane(png, "white"); }
export function pngPlane(png: Buffer, channel: PlaneChannel): WhiteFrame { return pngPlanes(png, [channel])[0]; }
/** Several channels from one decode. */
export function pngPlanes(png: Buffer, planeChannels: readonly PlaneChannel[]): WhiteFrame[] {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file.");
  let width = 0, height = 0, channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error("Truncated PNG.");
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const colour = body[9];
      if (body[8] !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) throw new Error("Unsupported PNG: expected 8-bit RGB or RGBA without interlacing.");
      if (!width || !height || width > 8192 || height > 8192) throw new Error("Unsupported PNG size.");
      channels = colour === 2 ? 3 : 4;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!channels || !data.length) throw new Error("PNG has no image data.");
  const stride = width * channels, raw = inflateSync(Buffer.concat(data));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG image data has an unexpected size.");
  const planes = planeChannels.map(() => new Uint8Array(width * height)), previous = new Uint8Array(stride), row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0, up = previous[i], upLeft = i >= channels ? previous[i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft); predicted = a <= b && a <= c ? left : b <= c ? up : upLeft; }
      else if (filter !== 0) throw new Error("Corrupt PNG filter.");
      row[i] = (source[i] + predicted) & 255;
    }
    for (let x = 0, i = 0; x < width; x++, i += channels) for (let p = 0; p < planes.length; p++) planes[p][y * width + x] = channelValue(row[i], row[i + 1], row[i + 2], planeChannels[p]);
    previous.set(row);
  }
  return planes.map(pixels => ({ width, height, pixels }));
}
