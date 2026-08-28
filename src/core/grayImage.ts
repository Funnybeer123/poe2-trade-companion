export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function createGray(width: number, height: number, fill = 0): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function fillRect(
  image: GrayImage,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + w));
  const y1 = Math.min(image.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    const row = yy * image.width;
    for (let xx = x0; xx < x1; xx += 1) {
      image.pixels[row + xx] = value;
    }
  }
}

export function crop(image: GrayImage, x: number, y: number, w: number, h: number): GrayImage {
  const out = createGray(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
  for (let yy = 0; yy < out.height; yy += 1) {
    for (let xx = 0; xx < out.width; xx += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, Math.floor(x) + xx));
      const sy = Math.min(image.height - 1, Math.max(0, Math.floor(y) + yy));
      out.pixels[yy * out.width + xx] = image.pixels[sy * image.width + sx];
    }
  }
  return out;
}

export function downsample(image: GrayImage, width: number, height: number): GrayImage {
  const out = createGray(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor((x * image.width) / width);
      const sy = Math.floor((y * image.height) / height);
      out.pixels[y * width + x] = image.pixels[sy * image.width + sx];
    }
  }
  return out;
}

/**
 * mean/variance/bright-fraction over a region, allocation-free. Matches
 * crop()+meanVariance() exactly: fractional origin floors, sub-1 sizes clamp
 * to one pixel, and out-of-bounds samples repeat the edge pixel.
 */
export function regionStats(
  image: GrayImage,
  x: number,
  y: number,
  w: number,
  h: number,
  brightThreshold = Number.POSITIVE_INFINITY,
): { mean: number; variance: number; brightFraction: number } {
  const outW = Math.max(1, Math.floor(w));
  const outH = Math.max(1, Math.floor(h));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let sum = 0;
  let sumSq = 0;
  let bright = 0;
  for (let yy = 0; yy < outH; yy += 1) {
    const sy = Math.min(image.height - 1, Math.max(0, y0 + yy));
    const row = sy * image.width;
    for (let xx = 0; xx < outW; xx += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, x0 + xx));
      const value = image.pixels[row + sx]!;
      sum += value;
      sumSq += value * value;
      if (value > brightThreshold) bright += 1;
    }
  }
  const n = outW * outH;
  const mean = sum / n;
  return { mean, variance: sumSq / n - mean * mean, brightFraction: bright / n };
}

export function meanVariance(image: GrayImage): { mean: number; variance: number } {
  if (image.pixels.length === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  for (const value of image.pixels) sum += value;
  const mean = sum / image.pixels.length;
  let acc = 0;
  for (const value of image.pixels) {
    const d = value - mean;
    acc += d * d;
  }
  return { mean, variance: acc / image.pixels.length };
}

/** Normalized cross-correlation in [-1, 1]. */
export function ncc(haystack: GrayImage, needle: GrayImage, ox: number, oy: number): number {
  if (ox < 0 || oy < 0 || ox + needle.width > haystack.width || oy + needle.height > haystack.height) {
    return -1;
  }
  let hSum = 0;
  let nSum = 0;
  const n = needle.width * needle.height;
  for (let y = 0; y < needle.height; y += 1) {
    for (let x = 0; x < needle.width; x += 1) {
      hSum += haystack.pixels[(oy + y) * haystack.width + (ox + x)];
      nSum += needle.pixels[y * needle.width + x];
    }
  }
  const hMean = hSum / n;
  const nMean = nSum / n;
  let num = 0;
  let hDen = 0;
  let nDen = 0;
  for (let y = 0; y < needle.height; y += 1) {
    for (let x = 0; x < needle.width; x += 1) {
      const hv = haystack.pixels[(oy + y) * haystack.width + (ox + x)] - hMean;
      const nv = needle.pixels[y * needle.width + x] - nMean;
      num += hv * nv;
      hDen += hv * hv;
      nDen += nv * nv;
    }
  }
  const den = Math.sqrt(hDen * nDen);
  return den === 0 ? 0 : num / den;
}

export function bestNcc(
  haystack: GrayImage,
  needle: GrayImage,
  step = 2,
): { x: number; y: number; score: number } {
  let best = { x: 0, y: 0, score: -1 };
  const maxX = haystack.width - needle.width;
  const maxY = haystack.height - needle.height;
  if (maxX < 0 || maxY < 0) return best;
  for (let y = 0; y <= maxY; y += step) {
    for (let x = 0; x <= maxX; x += step) {
      const score = ncc(haystack, needle, x, y);
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

export function grayToJson(image: GrayImage) {
  return { width: image.width, height: image.height, pixels: Array.from(image.pixels) };
}

export function grayFromJson(data: { width: number; height: number; pixels: number[] }): GrayImage {
  return { width: data.width, height: data.height, pixels: Uint8Array.from(data.pixels) };
}
