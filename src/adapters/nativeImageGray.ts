import type { NativeImage } from "electron";
import type { GrayImage } from "../core/grayImage.js";

export function nativeImageToGray(image: NativeImage): GrayImage {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 1) {
    const b = bgra[i * 4] ?? 0;
    const g = bgra[i * 4 + 1] ?? 0;
    const r = bgra[i * 4 + 2] ?? 0;
    pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, pixels };
}

export function grayMean(image: GrayImage, samples = 2000): number {
  if (image.pixels.length === 0) return 0;
  const step = Math.max(1, Math.floor(image.pixels.length / samples));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < image.pixels.length; i += step) {
    sum += image.pixels[i] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}
