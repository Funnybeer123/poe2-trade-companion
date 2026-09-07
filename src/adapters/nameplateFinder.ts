/**
 * Cached nameplate finder.
 *
 * Windows.Media.Ocr returns zero lines for mid-size crops (~1800x1000)
 * while small bands (700x110) and the full 3840x2160 frame work, so every
 * nameplate hunt (Stash, ZELINA, Ange) paid for a full-frame OCR (~2 s at
 * 4K). NPCs and the stash chest sit where they sat last time, so: OCR a
 * small band centred on the remembered point first, accept when the pattern
 * matches, otherwise fall back to the full frame; either way remember the
 * plate in artifacts/nameplates.json (24 h TTL, core/nameplateCache).
 *
 * Returns the click point callers use today: the plate-text centre shifted
 * +70 px down (world nameplates float above their object), plus the OCR
 * line itself for callers that pass lines around.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WinReply } from "./winHost.js";
import type { OcrLine } from "../core/tabList.js";
import {
  loadNameplateCache,
  lookupNameplate,
  recordNameplateHit,
  rememberNameplate,
  saveNameplateCache,
  type NameplateCacheFs,
  type Point,
} from "../core/nameplateCache.js";

export interface NameplateHost {
  send(payload: Record<string, unknown>): Promise<WinReply>;
}

/** Small enough to stay out of the OCR dead zone, wide enough for camera drift. */
export const NAMEPLATE_BAND = { width: 800, height: 160 };
export const NAMEPLATE_CLICK_OFFSET_Y = 70;
const SCREEN = { width: 3840, height: 2160 };

export interface FindNameplateOptions {
  /** Cache entry name, e.g. "zelina" or "stash". */
  cacheKey: string;
  /** JSON cache path; see defaultNameplateCacheFile. */
  cacheFile: string;
  /** Hold Alt across the capture so world labels render (bagKit convention). */
  holdAlt?: boolean;
  /**
   * Extra acceptance rule beyond the text pattern (e.g. the Stash plate's
   * Guild-Stash and minimap exclusions). Sees every line of the same pass.
   */
  accept?: (line: OcrLine, lines: OcrLine[]) => boolean;
  /** Called with the lines of a full-screen pass, so a miss can reuse them. */
  onFullScan?: (lines: OcrLine[]) => void;
  /** Pixels below the plate-text centre to return as the click point. */
  clickOffsetY?: number;
  band?: { width: number; height: number };
  screen?: { width: number; height: number };
  /** Test seams. */
  fs?: NameplateCacheFs;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NameplateFind {
  /** Click point (plate centre + clickOffsetY). */
  x: number;
  y: number;
  line: OcrLine;
  source: "band" | "full";
}

export interface OcrRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const nodeNameplateFs: NameplateCacheFs = {
  readFile(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
};

export function defaultNameplateCacheFile(root: string): string {
  return path.join(root, "artifacts", "nameplates.json");
}

/** The OCR band centred on `point`, clamped to the screen. */
export function bandAround(
  point: Point,
  band = NAMEPLATE_BAND,
  screen = SCREEN,
): OcrRegion {
  const width = Math.min(band.width, screen.width);
  const height = Math.min(band.height, screen.height);
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  return {
    left: clamp(Math.round(point.x - width / 2), screen.width - width),
    top: clamp(Math.round(point.y - height / 2), screen.height - height),
    width,
    height,
  };
}

function lineCentre(line: OcrLine): Point {
  return { x: line.x + line.w / 2, y: line.y + line.h / 2 };
}

async function ocrLines(host: NameplateHost, region: OcrRegion | undefined, holdAlt: boolean): Promise<OcrLine[]> {
  const reply = await host.send({ op: "ocr", ...(region ?? {}), ...(holdAlt ? { holdAlt: true } : {}) });
  return (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
}

export async function findNameplate(
  host: NameplateHost,
  pattern: RegExp,
  options: FindNameplateOptions,
): Promise<NameplateFind | undefined> {
  const now = options.now ?? Date.now;
  const fs = options.fs ?? nodeNameplateFs;
  const log = options.log ?? (() => {});
  const holdAlt = options.holdAlt ?? false;
  const offset = options.clickOffsetY ?? NAMEPLATE_CLICK_OFFSET_Y;
  const accept = options.accept ?? (() => true);
  const key = options.cacheKey;

  const pick = (lines: OcrLine[]): OcrLine | undefined =>
    lines.find((line) => pattern.test(line.text.trim()) && accept(line, lines));
  const toFind = (line: OcrLine, source: NameplateFind["source"]): NameplateFind => {
    const centre = lineCentre(line);
    return { x: Math.round(centre.x), y: Math.round(centre.y + offset), line, source };
  };
  const save = (next: Parameters<typeof saveNameplateCache>[1]): void => {
    try {
      saveNameplateCache(options.cacheFile, next, fs);
    } catch {
      // The cache is an optimisation; a read-only artifacts dir must not break the hunt.
    }
  };

  let cache = loadNameplateCache(options.cacheFile, fs, now());
  const cached = lookupNameplate(cache, key, now());
  if (cached) {
    const region = bandAround(cached, options.band, options.screen);
    const line = pick(await ocrLines(host, region, holdAlt));
    if (line) {
      cache = recordNameplateHit(cache, key, lineCentre(line), now());
      save(cache);
      const hits = lookupNameplate(cache, key, now())?.hits ?? 1;
      log(`nameplate "${key}": band hit at (${Math.round(line.x)},${Math.round(line.y)}) — ${hits} hit(s)`);
      return toFind(line, "band");
    }
    log(`nameplate "${key}": band miss around (${cached.x},${cached.y}) — full-screen OCR`);
  }

  const lines = await ocrLines(host, undefined, holdAlt);
  options.onFullScan?.(lines);
  const line = pick(lines);
  if (!line) return undefined;
  cache = rememberNameplate(cache, key, lineCentre(line), now());
  save(cache);
  log(`nameplate "${key}": full-screen find at (${Math.round(line.x)},${Math.round(line.y)}) — remembered`);
  return toFind(line, "full");
}
