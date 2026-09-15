/**
 * Global hotkey registry for feature actions (brief D3).
 *
 * Features `contribute()` actions; this service binds the persisted (or
 * default) accelerator through an injected globalShortcut-like object,
 * keeps registration failures visible instead of throwing, and persists
 * the user's choices to `%APPDATA%/poe2-trade-companion/overlay-hotkeys.json`.
 * Electron is injected so the tests never touch the OS.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeHotkeyBindingsFile,
  serializeHotkeyBindingsFile,
  validateAccelerator,
} from "../core/hotkeyRegistry.js";
import type { HotkeyActionInfo, HotkeyBindingView, HotkeyValidation } from "../shared/hotkeys.js";

export interface HotkeyAction extends HotkeyActionInfo {
  run: () => void | Promise<void>;
}

export interface HotkeyService {
  /** Registers the action; binds the persisted (or default) accelerator. Returns the un-contribute. */
  contribute(action: HotkeyAction): () => void;
  list(): HotkeyBindingView[];
  rebind(id: string, accelerator: string | null): HotkeyBindingView[];
  validate(accelerator: string, forId?: string): HotkeyValidation;
  trigger(id: string): Promise<boolean>;
}

/** The slice of Electron's globalShortcut the service uses (fakeable). */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface HotkeyServiceOptions {
  globalShortcut: GlobalShortcutLike;
  /** The persisted bindings file. */
  file: string;
  /** Injected for tests; defaults to the real fs. */
  fs?: {
    read: (file: string) => string | undefined;
    write: (file: string, text: string) => void;
  };
  /** Accelerators owned elsewhere at call time (the voice hotkey), re-read on every validation. */
  reserved?: () => ReadonlyArray<{ accelerator: string; label: string }>;
  /** Fired after any binding change (the feature module emits "hotkeys:changed"). */
  onChange?: (bindings: HotkeyBindingView[]) => void;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export function hotkeyBindingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, "overlay-hotkeys.json");
}

const realFs = {
  read: (file: string): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
  write: (file: string, text: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  },
};

interface Entry {
  action: HotkeyAction;
  accelerator: string | null;
  registered: boolean;
  error?: string;
}

export class HotkeyServiceImpl implements HotkeyService {
  private readonly entries = new Map<string, Entry>();
  /** Only the ids the user changed; absent = default. */
  private persisted: Record<string, string | null>;
  private readonly io: NonNullable<HotkeyServiceOptions["fs"]>;
  /** Issues found in the persisted file at start-up (shown in the UI through the first binding error). */
  readonly fileIssues: string[];
  lastWriteError: string | undefined;

  constructor(private readonly options: HotkeyServiceOptions) {
    this.io = options.fs ?? realFs;
    const text = this.io.read(options.file);
    let raw: unknown;
    if (text !== undefined) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
    }
    const normalized = normalizeHotkeyBindingsFile(raw);
    this.persisted = normalized.bindings;
    this.fileIssues = normalized.issues;
    for (const issue of normalized.issues) options.log?.("warn", `overlay-hotkeys.json: ${issue}`);
  }

  contribute(action: HotkeyAction): () => void {
    if (this.entries.has(action.id)) {
      throw new Error(`hotkey action "${action.id}" is already contributed`);
    }
    const accelerator = Object.hasOwn(this.persisted, action.id)
      ? this.persisted[action.id]!
      : action.defaultAccelerator;
    const entry: Entry = { action, accelerator, registered: false };
    this.entries.set(action.id, entry);
    this.bind(entry);
    this.announce();
    return () => {
      const current = this.entries.get(action.id);
      if (current !== entry) return;
      this.unbind(entry);
      this.entries.delete(action.id);
      this.announce();
    };
  }

  list(): HotkeyBindingView[] {
    return [...this.entries.values()].map((entry) => this.view(entry));
  }

  rebind(id: string, accelerator: string | null): HotkeyBindingView[] {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown hotkey action "${id}"`);
    const next = accelerator === null ? null : String(accelerator).trim() || null;
    this.unbind(entry);
    entry.accelerator = next;
    this.bind(entry);
    if (next === entry.action.defaultAccelerator) delete this.persisted[id];
    else this.persisted[id] = next;
    this.persist();
    this.announce();
    return this.list();
  }

  /** Back to the default accelerator for one action, or every action. */
  reset(id?: string): HotkeyBindingView[] {
    const targets = id ? [id] : [...this.entries.keys()];
    for (const target of targets) {
      const entry = this.entries.get(target);
      if (!entry) throw new Error(`unknown hotkey action "${target}"`);
      this.unbind(entry);
      entry.accelerator = entry.action.defaultAccelerator;
      delete this.persisted[target];
      this.bind(entry);
    }
    this.persist();
    this.announce();
    return this.list();
  }

  validate(accelerator: string, forId?: string): HotkeyValidation {
    const bindings: Record<string, string | null> = {};
    const labels: Record<string, string> = {};
    for (const entry of this.entries.values()) {
      bindings[entry.action.id] = entry.accelerator;
      labels[entry.action.id] = entry.action.label;
    }
    return validateAccelerator(accelerator, {
      reserved: this.options.reserved?.() ?? [],
      bindings,
      labels,
      forId,
    });
  }

  async trigger(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      await entry.action.run();
    } catch (error) {
      this.options.log?.("error", `hotkey action "${id}" failed`, error);
    }
    return true;
  }

  /** Unregisters everything (app quit). */
  dispose(): void {
    for (const entry of this.entries.values()) this.unbind(entry);
    this.entries.clear();
  }

  private view(entry: Entry): HotkeyBindingView {
    const { run: _run, ...info } = entry.action;
    return {
      ...info,
      accelerator: entry.accelerator,
      registered: entry.registered,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private bind(entry: Entry): void {
    entry.registered = false;
    entry.error = undefined;
    if (!entry.accelerator) return;
    const validation = this.validate(entry.accelerator, entry.action.id);
    if (!validation.ok) {
      entry.error = validation.reason;
      return;
    }
    let ok = false;
    try {
      ok = this.options.globalShortcut.register(entry.accelerator, () => {
        void this.trigger(entry.action.id);
      });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      return;
    }
    if (!ok) {
      entry.error = `${entry.accelerator} could not be registered — another application may already use it.`;
      return;
    }
    entry.registered = true;
  }

  private unbind(entry: Entry): void {
    if (entry.registered && entry.accelerator) {
      try {
        this.options.globalShortcut.unregister(entry.accelerator);
      } catch {
        // Already gone.
      }
    }
    entry.registered = false;
  }

  private persist(): void {
    try {
      this.io.write(this.options.file, serializeHotkeyBindingsFile(this.persisted));
      this.lastWriteError = undefined;
    } catch (error) {
      this.lastWriteError = error instanceof Error ? error.message : String(error);
      this.options.log?.("warn", `could not save ${this.options.file}: ${this.lastWriteError}`);
    }
  }

  private announce(): void {
    try {
      this.options.onChange?.(this.list());
    } catch (error) {
      this.options.log?.("warn", "hotkeys onChange listener failed", error);
    }
  }
}

export function createHotkeyService(options: HotkeyServiceOptions): HotkeyServiceImpl {
  return new HotkeyServiceImpl(options);
}
