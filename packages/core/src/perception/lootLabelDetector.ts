import type { LootTarget, Observation, PixelBox, PixelPoint, WorldState } from "../world-state/types.js";
import type { OcrPort } from "./ocrPort.js";
import type { RgbaImage } from "./templateMatch.js";
import type { PerceptionFrameInput } from "./types.js";

export interface RarityColor {
  rarityCue: string;
  r: number;
  g: number;
  b: number;
}

export const LOOT_RARITY_COLORS: RarityColor[] = [
  { rarityCue: "currency", r: 220, g: 180, b: 40 },
  { rarityCue: "unique", r: 175, g: 96, b: 37 },
  { rarityCue: "rare", r: 255, g: 255, b: 119 },
  { rarityCue: "magic", r: 136, g: 136, b: 255 },
  { rarityCue: "gem", r: 27, g: 168, b: 89 },
  { rarityCue: "normal", r: 200, g: 200, b: 200 },
];

export const DEFAULT_LOOT_COLOR_DISTANCE = 42;
export const DEFAULT_LOOT_MIN_BLOB_PIXELS = 24;

export interface DetectedLootLabels {
  loot: LootTarget[];
  confidence: number;
  source: "fixture" | "color" | "empty";
  evidenceId?: string;
}

export interface LootLabelDetectorOptions {
  ocr?: OcrPort;
  colors?: RarityColor[];
  maxColorDistance?: number;
  minBlobPixels?: number;
}

function isObservation(value: unknown): value is Observation<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "value" in value && "confidence" in value && "observedAtMs" in value;
}

export function lootFromDerived(derived: Partial<WorldState> | undefined): LootTarget[] | undefined {
  if (derived?.loot === undefined) {
    return undefined;
  }
  const raw = derived.loot as unknown;
  if (Array.isArray(raw)) {
    return raw as LootTarget[];
  }
  if (isObservation(raw) && Array.isArray(raw.value)) {
    return raw.value as LootTarget[];
  }
  return undefined;
}

function colorDistance(r: number, g: number, b: number, color: RarityColor): number {
  return Math.hypot(r - color.r, g - color.g, b - color.b);
}

function matchRarity(
  r: number,
  g: number,
  b: number,
  colors: RarityColor[],
  maxDistance: number,
): RarityColor | undefined {
  let best: RarityColor | undefined;
  let bestDistance = maxDistance;
  for (const color of colors) {
    const distance = colorDistance(r, g, b, color);
    if (distance <= bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best;
}

interface Blob {
  rarityCue: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
  count: number;
}

function detectColorBlobs(
  image: RgbaImage,
  colors: RarityColor[],
  maxDistance: number,
  minBlobPixels: number,
): Blob[] {
  const visited = new Uint8Array(image.width * image.height);
  const blobs: Blob[] = [];

  const indexAt = (x: number, y: number): number => y * image.width + x;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = indexAt(x, y);
      if (visited[index] === 1) {
        continue;
      }
      const offset = index * 4;
      const rarity = matchRarity(
        image.pixels[offset] ?? 0,
        image.pixels[offset + 1] ?? 0,
        image.pixels[offset + 2] ?? 0,
        colors,
        maxDistance,
      );
      if (rarity === undefined) {
        visited[index] = 1;
        continue;
      }

      const blob: Blob = {
        rarityCue: rarity.rarityCue,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        sumX: 0,
        sumY: 0,
        count: 0,
      };
      const stack: Array<{ x: number; y: number }> = [{ x, y }];
      visited[index] = 1;

      while (stack.length > 0) {
        const point = stack.pop();
        if (point === undefined) {
          break;
        }
        blob.minX = Math.min(blob.minX, point.x);
        blob.minY = Math.min(blob.minY, point.y);
        blob.maxX = Math.max(blob.maxX, point.x);
        blob.maxY = Math.max(blob.maxY, point.y);
        blob.sumX += point.x;
        blob.sumY += point.y;
        blob.count += 1;

        const neighbors = [
          { x: point.x - 1, y: point.y },
          { x: point.x + 1, y: point.y },
          { x: point.x, y: point.y - 1 },
          { x: point.x, y: point.y + 1 },
        ];
        for (const neighbor of neighbors) {
          if (
            neighbor.x < 0 ||
            neighbor.y < 0 ||
            neighbor.x >= image.width ||
            neighbor.y >= image.height
          ) {
            continue;
          }
          const neighborIndex = indexAt(neighbor.x, neighbor.y);
          if (visited[neighborIndex] === 1) {
            continue;
          }
          const neighborOffset = neighborIndex * 4;
          const neighborRarity = matchRarity(
            image.pixels[neighborOffset] ?? 0,
            image.pixels[neighborOffset + 1] ?? 0,
            image.pixels[neighborOffset + 2] ?? 0,
            colors,
            maxDistance,
          );
          if (neighborRarity?.rarityCue !== rarity.rarityCue) {
            continue;
          }
          visited[neighborIndex] = 1;
          stack.push(neighbor);
        }
      }

      if (blob.count >= minBlobPixels) {
        blobs.push(blob);
      }
    }
  }

  return blobs;
}

function blobToTarget(blob: Blob, index: number, labelText?: string): LootTarget {
  const box: PixelBox = {
    x: blob.minX,
    y: blob.minY,
    w: blob.maxX - blob.minX + 1,
    h: blob.maxY - blob.minY + 1,
  };
  const screenPoint: PixelPoint = {
    x: Math.round(blob.sumX / blob.count),
    y: Math.round(blob.sumY / blob.count),
  };
  return {
    id: `${blob.rarityCue}-${String(index + 1)}`,
    labelText,
    screenPoint,
    boundingBox: box,
    rarityCue: blob.rarityCue,
  };
}

export async function detectLootLabels(
  frame: PerceptionFrameInput,
  options: LootLabelDetectorOptions = {},
): Promise<DetectedLootLabels> {
  const fixtureLoot = lootFromDerived(frame.derived);
  if (fixtureLoot !== undefined) {
    return {
      loot: fixtureLoot,
      confidence: 1,
      source: "fixture",
      evidenceId: `loot-fixture:${String(frame.tickId)}`,
    };
  }

  if (frame.pixels === undefined || frame.pixels.length < frame.width * frame.height * 4) {
    return { loot: [], confidence: 0, source: "empty" };
  }

  const blobs = detectColorBlobs(
    { width: frame.width, height: frame.height, pixels: frame.pixels },
    options.colors ?? LOOT_RARITY_COLORS,
    options.maxColorDistance ?? DEFAULT_LOOT_COLOR_DISTANCE,
    options.minBlobPixels ?? DEFAULT_LOOT_MIN_BLOB_PIXELS,
  );

  const loot: LootTarget[] = [];
  for (const [index, blob] of blobs.entries()) {
    const box: PixelBox = {
      x: blob.minX,
      y: blob.minY,
      w: blob.maxX - blob.minX + 1,
      h: blob.maxY - blob.minY + 1,
    };
    const ocr = options.ocr
      ? await options.ocr.recognize({
          pixels: frame.pixels,
          width: frame.width,
          height: frame.height,
          pngPath: frame.pngPath,
          box,
        })
      : undefined;
    loot.push(blobToTarget(blob, index, ocr?.text || undefined));
  }

  return {
    loot,
    confidence: loot.length > 0 ? 0.8 : 0,
    source: loot.length > 0 ? "color" : "empty",
    evidenceId: `loot-color:${String(frame.tickId)}`,
  };
}

export class LootLabelDetector {
  readonly #options: LootLabelDetectorOptions;

  constructor(options: LootLabelDetectorOptions = {}) {
    this.#options = options;
  }

  detect(frame: PerceptionFrameInput): Promise<DetectedLootLabels> {
    return detectLootLabels(frame, this.#options);
  }
}

export function createLootLabelDetector(options: LootLabelDetectorOptions = {}): LootLabelDetector {
  return new LootLabelDetector(options);
}
