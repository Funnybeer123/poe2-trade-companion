/**
 * The death-screenshot index: ids, file names, sanitizer, JSONL and the
 * prune plan. Pure — the service does the actual writing.
 *
 * WHY a sanitizer with a basename rule: the index is the only thing that
 * decides which file `session:death-open` hands to the OS. A record that
 * carried `..\\..\\something.exe` would turn a convenience button into an
 * arbitrary-open. File names here are basenames or the record is dropped;
 * the service additionally asserts the resolved path stays inside the
 * deaths directory.
 */

export interface DeathCapture {
  id: string;
  at: string;
  kind: "death" | "manual";
  character?: string;
  areaId?: string;
  areaName?: string;
  areaLevel?: number;
  runId?: string;
  file: string;
  thumbFile: string;
  width: number;
  height: number;
  bytes: number;
  sourceName: string;
}

export type CaptureSkipReason =
  | "disabled"
  | "no-source"
  | "black-frame"
  | "write-failed"
  | "busy"
  | "no-display";

export const DEFAULT_MAX_DEATH_SCREENSHOTS = 60;
export const THUMB_WIDTH = 320;
export const JPEG_QUALITY = 82;
/** Mean grey below this is a black frame (exclusive fullscreen captures black). */
export const BLACK_FRAME_MEAN = 8;

export function deathCaptureId(at: string, kind: DeathCapture["kind"]): string {
  return `cap-${at.replace(/[:.]/g, "-")}-${kind}`;
}

export function deathFileNames(id: string, areaId?: string): { file: string; thumbFile: string } {
  const token = areaId ? areaId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "";
  const base = token ? `${id}-${token}` : id;
  return { file: `${base}.jpg`, thumbFile: `${base}.thumb.jpg` };
}

function isBasename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !/^[A-Za-z]:/.test(value)
  );
}

function text(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function finite(raw: unknown): number | undefined {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function sanitizeDeathCapture(raw: unknown): DeathCapture | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 120);
  const at = text(source.at, 40);
  const kind = source.kind === "manual" ? "manual" : source.kind === "death" ? "death" : undefined;
  if (!id || !at || !kind || !Number.isFinite(Date.parse(at))) return undefined;
  if (!isBasename(source.file) || !isBasename(source.thumbFile)) return undefined;
  const level = finite(source.areaLevel);
  return {
    id,
    at,
    kind,
    ...(text(source.character, 40) ? { character: text(source.character, 40) } : {}),
    ...(text(source.areaId, 80) ? { areaId: text(source.areaId, 80) } : {}),
    ...(text(source.areaName, 120) ? { areaName: text(source.areaName, 120) } : {}),
    ...(level !== undefined && level > 0 ? { areaLevel: Math.round(level) } : {}),
    ...(text(source.runId, 80) ? { runId: text(source.runId, 80) } : {}),
    file: source.file,
    thumbFile: source.thumbFile,
    width: Math.max(0, Math.round(finite(source.width) ?? 0)),
    height: Math.max(0, Math.round(finite(source.height) ?? 0)),
    bytes: Math.max(0, Math.round(finite(source.bytes) ?? 0)),
    sourceName: text(source.sourceName, 120) ?? "unknown",
  };
}

/** JSONL, oldest first; a duplicate id keeps the first record. */
export function parseDeathIndex(text_: string): DeathCapture[] {
  const out: DeathCapture[] = [];
  const seen = new Set<string>();
  for (const line of text_.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const capture = sanitizeDeathCapture(JSON.parse(line));
      if (!capture || seen.has(capture.id)) continue;
      seen.add(capture.id);
      out.push(capture);
    } catch {
      // Torn line: skip.
    }
  }
  return out;
}

export function serializeDeathCapture(capture: DeathCapture): string {
  return JSON.stringify(capture);
}

/** Oldest beyond `max` go; the index keeps the newest. */
export function pruneDeathPlan(
  records: readonly DeathCapture[],
  max: number,
): { keep: DeathCapture[]; remove: DeathCapture[] } {
  const limit = Math.max(1, Math.round(max));
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length <= limit) return { keep: sorted, remove: [] };
  return { keep: sorted.slice(sorted.length - limit), remove: sorted.slice(0, sorted.length - limit) };
}
