/**
 * Remembered nameplate positions (pure).
 *
 * Nameplate hunting (Stash, ZELINA, Ange) used to OCR the full 3840x2160
 * frame every time (~2 s at 4K) because mid-size crops hit a
 * Windows.Media.Ocr dead zone while small bands work. Hideout NPCs and the
 * stash chest sit where they sat last time, so the finder
 * (adapters/nameplateFinder) OCRs a small band around the remembered point
 * first and only falls back to the full frame on a miss. This module is the
 * map behind that: name -> { x, y, seenAt, hits }, 24 h TTL, with load/save
 * helpers over an injected fs so it stays testable without disk.
 */

export interface NameplateEntry {
  /** Plate-text centre in screen pixels (NOT the click point). */
  x: number;
  y: number;
  /** Epoch ms of the last confirmed sighting. */
  seenAt: number;
  /** Band-OCR confirmations since the last full-screen find. */
  hits: number;
}

export type NameplateCache = Record<string, NameplateEntry>;

export const NAMEPLATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface NameplateCacheFs {
  /** The file's text, or undefined when it does not exist. */
  readFile(file: string): string | undefined;
  /** Write the file, creating parent directories as needed. */
  writeFile(file: string, text: string): void;
}

export interface Point {
  x: number;
  y: number;
}

export function normalizeNameplateKey(key: string): string {
  return key.trim().toLowerCase();
}

export function isNameplateExpired(entry: NameplateEntry, now: number, ttlMs = NAMEPLATE_TTL_MS): boolean {
  return now - entry.seenAt > ttlMs;
}

/** Parse the JSON map, dropping malformed and expired entries. */
export function parseNameplateCache(
  text: string | undefined,
  now: number,
  ttlMs = NAMEPLATE_TTL_MS,
): NameplateCache {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const cache: NameplateCache = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const raw = value as Partial<NameplateEntry> | null;
    if (
      !raw ||
      typeof raw !== "object" ||
      !Number.isFinite(raw.x) ||
      !Number.isFinite(raw.y) ||
      !Number.isFinite(raw.seenAt)
    ) {
      continue;
    }
    const entry: NameplateEntry = {
      x: raw.x as number,
      y: raw.y as number,
      seenAt: raw.seenAt as number,
      hits: Number.isFinite(raw.hits) ? Math.max(0, Math.floor(raw.hits as number)) : 0,
    };
    if (isNameplateExpired(entry, now, ttlMs)) continue;
    cache[normalizeNameplateKey(key)] = entry;
  }
  return cache;
}

export function serializeNameplateCache(cache: NameplateCache): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/** The remembered point for `key`, or undefined when absent or older than the TTL. */
export function lookupNameplate(
  cache: NameplateCache,
  key: string,
  now: number,
  ttlMs = NAMEPLATE_TTL_MS,
): NameplateEntry | undefined {
  const entry = cache[normalizeNameplateKey(key)];
  if (!entry || isNameplateExpired(entry, now, ttlMs)) return undefined;
  return entry;
}

/** A full-screen find: store the point fresh (hit count restarts). */
export function rememberNameplate(cache: NameplateCache, key: string, point: Point, now: number): NameplateCache {
  return {
    ...cache,
    [normalizeNameplateKey(key)]: { x: Math.round(point.x), y: Math.round(point.y), seenAt: now, hits: 0 },
  };
}

/** A band-OCR confirmation around the remembered point: refresh it and count the hit. */
export function recordNameplateHit(cache: NameplateCache, key: string, point: Point, now: number): NameplateCache {
  const normalized = normalizeNameplateKey(key);
  const prior = cache[normalized];
  return {
    ...cache,
    [normalized]: {
      x: Math.round(point.x),
      y: Math.round(point.y),
      seenAt: now,
      hits: (prior?.hits ?? 0) + 1,
    },
  };
}

/** Load the cache file; a missing, unreadable or corrupt file is an empty cache. */
export function loadNameplateCache(
  file: string,
  fs: NameplateCacheFs,
  now: number,
  ttlMs = NAMEPLATE_TTL_MS,
): NameplateCache {
  let text: string | undefined;
  try {
    text = fs.readFile(file);
  } catch {
    return {};
  }
  return parseNameplateCache(text, now, ttlMs);
}

export function saveNameplateCache(file: string, cache: NameplateCache, fs: NameplateCacheFs): void {
  fs.writeFile(file, serializeNameplateCache(cache));
}
