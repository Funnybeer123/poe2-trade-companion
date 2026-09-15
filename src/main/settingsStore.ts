/**
 * One JSON document of per-feature settings namespaces
 * (`%APPDATA%/poe2-trade-companion/companion-settings.json`).
 *
 * Each feature registers a namespace with its own sanitizer (the repo's
 * `normalize*(raw) → value` pattern): the store only ever holds sanitized
 * values, unknown namespaces on disk are kept verbatim until something
 * registers them, and every write is atomic (tmp + rename).
 *
 * Existing settings (price feed config, voice config, numpad bindings) stay
 * in their own files; this store is for the ported overlay features.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SETTINGS_FILE_VERSION = 1 as const;

export interface SettingsDocument {
  version: typeof SETTINGS_FILE_VERSION;
  namespaces: Record<string, unknown>;
}

export interface SettingsNamespace<T extends object> {
  readonly id: string;
  get(): T;
  /** Merge a patch (or replace via a function) and persist; returns the sanitized value. */
  set(patch: Partial<T> | ((current: T) => T)): T;
  onChange(callback: (next: T, previous: T) => void): () => void;
}

export interface SettingsStoreOptions {
  file: string;
  /** Injected for tests; defaults to the real fs. */
  fs?: {
    read: (file: string) => string | undefined;
    write: (file: string, text: string) => void;
  };
}

export function settingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "companion-settings.json");
}

function parseDocument(text: string | undefined): SettingsDocument {
  if (!text) return { version: SETTINGS_FILE_VERSION, namespaces: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { version: SETTINGS_FILE_VERSION, namespaces: {} };
    }
    const doc = parsed as Partial<SettingsDocument>;
    const namespaces =
      typeof doc.namespaces === "object" && doc.namespaces !== null && !Array.isArray(doc.namespaces)
        ? (doc.namespaces as Record<string, unknown>)
        : {};
    return { version: SETTINGS_FILE_VERSION, namespaces: { ...namespaces } };
  } catch {
    return { version: SETTINGS_FILE_VERSION, namespaces: {} };
  }
}

const realFs = {
  read: (file: string): string | undefined =>
    existsSync(file) ? readFileSync(file, "utf8") : undefined,
  write: (file: string, text: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
};

interface Registered<T extends object> {
  sanitize: (raw: unknown) => T;
  value: T;
  listeners: Set<(next: T, previous: T) => void>;
}

export class SettingsStore {
  private readonly file: string;
  private readonly io: NonNullable<SettingsStoreOptions["fs"]>;
  private document: SettingsDocument;
  private readonly registered = new Map<string, Registered<object>>();
  private readonly anyListeners = new Set<(id: string, value: unknown) => void>();
  /** The last write error, surfaced instead of thrown so a read-only disk never breaks a feature. */
  lastWriteError: string | undefined;

  constructor(options: SettingsStoreOptions) {
    this.file = options.file;
    this.io = options.fs ?? realFs;
    this.document = parseDocument(this.io.read(this.file));
  }

  get path(): string {
    return this.file;
  }

  /** Register (or re-register with the same sanitizer) one namespace. */
  namespace<T extends object>(id: string, sanitize: (raw: unknown) => T): SettingsNamespace<T> {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`invalid settings namespace "${id}"`);
    }
    let entry = this.registered.get(id) as Registered<T> | undefined;
    if (!entry) {
      entry = {
        sanitize,
        value: sanitize(this.document.namespaces[id]),
        listeners: new Set(),
      };
      this.registered.set(id, entry as unknown as Registered<object>);
      this.document.namespaces[id] = entry.value;
    }
    const registered = entry;
    return {
      id,
      get: () => registered.value,
      set: (patch) => this.apply(id, patch),
      onChange: (callback) => {
        registered.listeners.add(callback);
        return () => registered.listeners.delete(callback);
      },
    };
  }

  /** Every registered namespace's current (sanitized) value, plus unregistered raw ones. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.document.namespaces };
    for (const [id, entry] of this.registered) out[id] = entry.value;
    return out;
  }

  /** Generic `settings:set`: merge into a registered namespace (unknown → error). */
  setRaw(id: string, patch: unknown): unknown {
    if (!this.registered.has(id)) {
      throw new Error(`unknown settings namespace "${id}"`);
    }
    const merge =
      typeof patch === "object" && patch !== null && !Array.isArray(patch)
        ? (patch as Record<string, unknown>)
        : {};
    return this.apply(id, merge as Partial<object>);
  }

  onAnyChange(callback: (id: string, value: unknown) => void): () => void {
    this.anyListeners.add(callback);
    return () => this.anyListeners.delete(callback);
  }

  private apply<T extends object>(id: string, patch: Partial<T> | ((current: T) => T)): T {
    const entry = this.registered.get(id) as Registered<T> | undefined;
    if (!entry) throw new Error(`unknown settings namespace "${id}"`);
    const previous = entry.value;
    const candidate =
      typeof patch === "function" ? patch(previous) : { ...previous, ...patch };
    const next = entry.sanitize(candidate);
    entry.value = next;
    this.document.namespaces[id] = next;
    this.persist();
    for (const listener of entry.listeners) {
      try {
        listener(next, previous);
      } catch {
        // One bad listener must not block the others.
      }
    }
    for (const listener of this.anyListeners) {
      try {
        listener(id, next);
      } catch {
        // Same.
      }
    }
    return next;
  }

  private persist(): void {
    try {
      this.io.write(this.file, `${JSON.stringify(this.document, null, 2)}\n`);
      this.lastWriteError = undefined;
    } catch (error) {
      this.lastWriteError = error instanceof Error ? error.message : String(error);
    }
  }
}
