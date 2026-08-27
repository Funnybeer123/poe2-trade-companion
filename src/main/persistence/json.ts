import { createHash } from "node:crypto";

export const DEFAULT_JSON_CAP_BYTES = 262_144;
export const MAX_JSON_DEPTH = 50;
export const MAX_JSON_NODES = 100_000;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeJson(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();

  const visit = (current: unknown, depth: number, path: string): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new Error(`JSON exceeds the ${MAX_JSON_NODES} node cap`);
    }
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`JSON exceeds the ${MAX_JSON_DEPTH} level depth cap`);
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(`${path} contains a non-finite number`);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new Error(`${path} contains a cycle`);
      seen.add(current);
      const normalized = current.map((entry, index) =>
        visit(entry, depth + 1, `${path}[${index}]`),
      );
      seen.delete(current);
      return normalized;
    }
    if (!isRecord(current)) {
      throw new Error(`${path} contains unsupported value type '${typeof current}'`);
    }
    if (seen.has(current)) throw new Error(`${path} contains a cycle`);
    seen.add(current);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`${path}.${key} uses a forbidden key`);
      const entry = current[key];
      if (entry === undefined) continue;
      output[key] = visit(entry, depth + 1, `${path}.${key}`);
    }
    seen.delete(current);
    return output;
  };

  return visit(value, 0, "$");
}

export function deterministicJson(
  value: unknown,
  field = "payload",
  maxBytes = DEFAULT_JSON_CAP_BYTES,
): string {
  const json = JSON.stringify(normalizeJson(value));
  if (byteLength(json) > maxBytes) {
    throw new Error(`${field} exceeds the ${maxBytes} byte cap`);
  }
  return json;
}

export function parseDeterministicJson<T>(json: string, field = "payload"): T {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error(`Stored ${field} is malformed JSON`);
  }
  // Re-validate persisted data before exposing it to callers.
  normalizeJson(value);
  return value as T;
}

export function boundedText(
  value: unknown,
  field: string,
  maxLength = 512,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return text;
}

export function optionalBoundedText(
  value: unknown,
  field: string,
  maxLength = 512,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, field, maxLength);
}

export function stableId(kind: string, ...parts: Array<string | number>): string {
  const safeKind = boundedText(kind, "ID kind", 32).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const digest = createHash("sha256")
    .update(parts.map(String).join("\0"), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${safeKind}_${digest}`;
}

export function validatedId(value: unknown, field = "id"): string {
  const id = boundedText(value, field, 128);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${field} contains unsupported characters`);
  }
  return id;
}

export function utcTimestamp(value: Date | string | number, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

export function finiteNumber(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be at most ${options.max}`);
  }
  return value;
}

export function positiveSchemaVersion(value: unknown, field = "schemaVersion"): number {
  const version = finiteNumber(value, field, { min: 1, max: 1_000_000 });
  if (!Number.isInteger(version)) throw new Error(`${field} must be an integer`);
  return version;
}
