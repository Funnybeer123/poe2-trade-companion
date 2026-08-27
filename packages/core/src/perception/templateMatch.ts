import type { PixelBox } from "../world-state/types.js";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface TemplateMatchHit {
  score: number;
  box: PixelBox;
}

function requireRgba(image: RgbaImage, label: string): void {
  const expected = image.width * image.height * 4;
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`${label} must have positive dimensions`);
  }
  if (image.pixels.length < expected) {
    throw new Error(`${label} pixels length ${image.pixels.length} < ${expected}`);
  }
}

export function toGrayscale(image: RgbaImage): Float64Array {
  requireRgba(image, "image");
  const gray = new Float64Array(image.width * image.height);
  for (let i = 0; i < gray.length; i += 1) {
    const offset = i * 4;
    gray[i] =
      0.299 * image.pixels[offset]! +
      0.587 * image.pixels[offset + 1]! +
      0.114 * image.pixels[offset + 2]!;
  }
  return gray;
}

export function normalizedCorrelation(patch: Float64Array, template: Float64Array): number {
  if (patch.length !== template.length || patch.length === 0) {
    return 0;
  }
  let meanPatch = 0;
  let meanTemplate = 0;
  for (let i = 0; i < template.length; i += 1) {
    meanPatch += patch[i]!;
    meanTemplate += template[i]!;
  }
  meanPatch /= template.length;
  meanTemplate /= template.length;

  let numerator = 0;
  let patchEnergy = 0;
  let templateEnergy = 0;
  for (let i = 0; i < template.length; i += 1) {
    const patchDelta = patch[i]! - meanPatch;
    const templateDelta = template[i]! - meanTemplate;
    numerator += patchDelta * templateDelta;
    patchEnergy += patchDelta * patchDelta;
    templateEnergy += templateDelta * templateDelta;
  }
  const denom = Math.sqrt(patchEnergy * templateEnergy);
  if (denom === 0) {
    return meanPatch === meanTemplate ? 1 : 0;
  }
  return numerator / denom;
}

export function scoreToUnitInterval(ncc: number): number {
  if (!Number.isFinite(ncc)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (ncc + 1) / 2));
}

function extractPatch(
  gray: Float64Array,
  imageWidth: number,
  x: number,
  y: number,
  templateWidth: number,
  templateHeight: number,
): Float64Array {
  const patch = new Float64Array(templateWidth * templateHeight);
  let i = 0;
  for (let row = 0; row < templateHeight; row += 1) {
    const src = (y + row) * imageWidth + x;
    for (let col = 0; col < templateWidth; col += 1) {
      patch[i] = gray[src + col]!;
      i += 1;
    }
  }
  return patch;
}

export function templateMatchScoreAt(
  image: RgbaImage,
  template: RgbaImage,
  x: number,
  y: number,
): number {
  requireRgba(image, "image");
  requireRgba(template, "template");
  if (
    x < 0 ||
    y < 0 ||
    x + template.width > image.width ||
    y + template.height > image.height
  ) {
    return 0;
  }
  const imageGray = toGrayscale(image);
  const templateGray = toGrayscale(template);
  const patch = extractPatch(imageGray, image.width, x, y, template.width, template.height);
  return scoreToUnitInterval(normalizedCorrelation(patch, templateGray));
}

/**
 * Brute-force normalized cross-correlation of a template over an RGBA image.
 * Returns the best box and a 0..1 score. Pure: no I/O, no native libs.
 */
export function templateMatch(image: RgbaImage, template: RgbaImage): TemplateMatchHit {
  requireRgba(image, "image");
  requireRgba(template, "template");
  const box: PixelBox = { x: 0, y: 0, w: template.width, h: template.height };
  if (template.width > image.width || template.height > image.height) {
    return { score: 0, box };
  }

  const imageGray = toGrayscale(image);
  const templateGray = toGrayscale(template);
  let bestScore = -Infinity;
  let bestX = 0;
  let bestY = 0;
  const maxX = image.width - template.width;
  const maxY = image.height - template.height;

  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= maxX; x += 1) {
      const patch = extractPatch(imageGray, image.width, x, y, template.width, template.height);
      const score = normalizedCorrelation(patch, templateGray);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  return {
    score: scoreToUnitInterval(bestScore),
    box: { x: bestX, y: bestY, w: template.width, h: template.height },
  };
}
