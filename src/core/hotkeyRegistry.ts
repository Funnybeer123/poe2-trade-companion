/**
 * Pure rules for the configurable hotkeys: Electron accelerator grammar,
 * the keys this app must never rebind, collisions between actions, the
 * persisted bindings file, and turning a browser keydown into an accelerator.
 *
 * Why a pure module: the main process registers the shortcuts, the Hotkeys
 * UI validates while the user types, and both must agree byte-for-byte on
 * what "Alt+E" means. No Electron, no DOM.
 */
import type { HotkeyBindingsFile, HotkeyValidation } from "../shared/hotkeys.js";

/** Modifiers Electron accepts, in canonical spelling. */
const MODIFIER_ALIASES: Record<string, string> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  control: "Control",
  ctrl: "Control",
  command: "Command",
  cmd: "Command",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift",
  super: "Super",
  meta: "Meta",
};

const MODIFIER_ORDER = ["CommandOrControl", "Control", "Command", "AltGr", "Alt", "Shift", "Super", "Meta"];

/** Named key codes Electron accepts (lower-case lookup → canonical spelling). */
const NAMED_KEYS: Record<string, string> = {
  plus: "Plus",
  space: "Space",
  tab: "Tab",
  capslock: "Capslock",
  numlock: "Numlock",
  scrolllock: "Scrolllock",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Return",
  enter: "Return",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  esc: "Escape",
  volumeup: "VolumeUp",
  volumedown: "VolumeDown",
  volumemute: "VolumeMute",
  medianexttrack: "MediaNextTrack",
  mediaprevioustrack: "MediaPreviousTrack",
  mediastop: "MediaStop",
  mediaplaypause: "MediaPlayPause",
  printscreen: "PrintScreen",
  numdec: "Numdec",
  numadd: "Numadd",
  numsub: "Numsub",
  nummult: "Nummult",
  numdiv: "Numdiv",
};

const PUNCTUATION_KEYS = new Set([")", "!", "@", "#", "$", "%", "^", "&", "*", "(", ":", ";", "+", "=", "<", ",", "_", "-", ">", ".", "?", "/", "~", "`", "{", "]", "[", "|", "\\", "}", "\""]);

export interface ParsedAccelerator {
  modifiers: string[];
  key: string;
  /** Canonical spelling, e.g. "CommandOrControl+Shift+F". */
  text: string;
  /** Platform-independent identity for collision checks ("control+shift+f"). */
  identity: string;
}

/** Canonical spelling for one key token, or undefined when Electron would not accept it. */
function canonicalKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if (/^num[0-9]$/.test(lower)) return `Num${lower.slice(3)}`;
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (token.length === 1 && PUNCTUATION_KEYS.has(token)) return token;
  return undefined;
}

/**
 * Parses an Electron accelerator ("Alt+E", "CommandOrControl+Shift+F",
 * "F5", "Num1"). Returns undefined for anything Electron's parser would
 * reject; the reason is reported by validateAccelerator.
 */
export function parseAccelerator(raw: string): ParsedAccelerator | undefined {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  // "Plus" is the spelled-out form; a literal "+" key must be written as "Plus".
  const parts = text.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) return undefined;
  const modifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return undefined;
    modifiers.add(modifier);
  }
  const key = canonicalKey(parts[parts.length - 1]!);
  if (!key) return undefined;
  const ordered = MODIFIER_ORDER.filter((name) => modifiers.has(name));
  const identityMods = [...new Set(ordered.map(platformModifier))].sort();
  return {
    modifiers: ordered,
    key,
    text: [...ordered, key].join("+"),
    identity: [...identityMods, key.toLowerCase()].join("+"),
  };
}

/** Windows-first: CommandOrControl and Command both resolve to Control; Meta and Super are the Windows key. */
function platformModifier(modifier: string): string {
  if (modifier === "CommandOrControl" || modifier === "Command") return "control";
  if (modifier === "Meta" || modifier === "Super") return "super";
  return modifier.toLowerCase();
}

/** Collision identity for an accelerator string; undefined when it does not parse. */
export function acceleratorIdentity(raw: string): string | undefined {
  return parseAccelerator(raw)?.identity;
}

/**
 * Keys the app owns elsewhere and must never hand to a feature: the kill
 * switch, the classic price check, the clipboard keys the sorter relies on
 * (Ctrl+C is how items are identified), and the numpad daemon's keys.
 */
export const RESERVED_ACCELERATORS: ReadonlyArray<{ accelerator: string; label: string }> = [
  { accelerator: "CommandOrControl+Shift+Escape", label: "Emergency stop" },
  { accelerator: "CommandOrControl+D", label: "Price check (clipboard)" },
  { accelerator: "CommandOrControl+C", label: "Copy (item identification)" },
  { accelerator: "CommandOrControl+V", label: "Paste" },
  ...Array.from({ length: 10 }, (_, digit) => ({
    accelerator: `Num${digit}`,
    label: `Numpad ${digit} (hotkey daemon)`,
  })),
  { accelerator: "Numsub", label: "Numpad − (auto-flask pause)" },
  { accelerator: "Numadd", label: "Numpad + (hotkey daemon)" },
  { accelerator: "Nummult", label: "Numpad * (hotkey daemon)" },
  { accelerator: "Numdiv", label: "Numpad / (hotkey daemon)" },
];

export interface ValidateAcceleratorOptions {
  /** Extra reserved accelerators (the voice hotkey), with a label for the message. */
  reserved?: ReadonlyArray<{ accelerator: string; label: string }>;
  /** Current bindings of every action, to detect collisions. */
  bindings?: Record<string, string | null>;
  /** Labels for the collision message, keyed by action id. */
  labels?: Record<string, string>;
  /** The action being bound (excluded from the collision check). */
  forId?: string;
}

/**
 * Grammar + reserved keys + collisions. A bare letter/digit (no modifier)
 * is refused because it would fire while the user types in chat; F-keys
 * and named keys are fine on their own (that is how PoE Overlay binds them).
 */
export function validateAccelerator(raw: string, options: ValidateAcceleratorOptions = {}): HotkeyValidation {
  const parsed = parseAccelerator(raw);
  if (!parsed) {
    return { ok: false, reason: "Not a valid shortcut. Use modifiers plus one key, e.g. Alt+E or Ctrl+Shift+F." };
  }
  const bareKey = parsed.modifiers.length === 0;
  if (bareKey && /^[A-Z0-9]$/.test(parsed.key)) {
    return { ok: false, reason: "Add a modifier (Ctrl, Alt or Shift) — a bare key would fire while typing in game." };
  }
  if (bareKey && parsed.key === "Escape") {
    return { ok: false, reason: "Escape closes overlay panels and cannot be bound globally." };
  }
  for (const entry of [...RESERVED_ACCELERATORS, ...(options.reserved ?? [])]) {
    if (acceleratorIdentity(entry.accelerator) === parsed.identity) {
      return { ok: false, reason: `${parsed.text} is reserved for ${entry.label}.`, conflictsWith: entry.label };
    }
  }
  for (const [id, accelerator] of Object.entries(options.bindings ?? {})) {
    if (id === options.forId || !accelerator) continue;
    if (acceleratorIdentity(accelerator) === parsed.identity) {
      const label = options.labels?.[id] ?? id;
      return { ok: false, reason: `${parsed.text} is already bound to ${label}.`, conflictsWith: id };
    }
  }
  return { ok: true };
}

export interface NormalizedHotkeyBindings {
  bindings: Record<string, string | null>;
  issues: string[];
}

/**
 * Sanitizes the persisted bindings file. Unknown shapes become an empty
 * map; entries that are neither a string nor null are dropped with an
 * issue so a hand edit never crashes start-up. Grammar is NOT enforced
 * here: an invalid persisted accelerator surfaces as a binding error in the
 * UI instead of silently reverting to the default.
 */
export function normalizeHotkeyBindingsFile(raw: unknown): NormalizedHotkeyBindings {
  const issues: string[] = [];
  const bindings: Record<string, string | null> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("bindings file is not an object; starting from defaults");
    return { bindings, issues };
  }
  const doc = raw as Partial<HotkeyBindingsFile>;
  if (doc.version !== undefined && doc.version !== 1) {
    issues.push(`unknown bindings file version ${String(doc.version)}; reading what fits`);
  }
  const source = doc.bindings;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    if (source !== undefined) issues.push("bindings is not an object; ignored");
    return { bindings, issues };
  }
  for (const [id, value] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9._-]*$/i.test(id)) {
      issues.push(`ignored binding with invalid id "${id}"`);
      continue;
    }
    if (value === null) {
      bindings[id] = null;
    } else if (typeof value === "string") {
      bindings[id] = value.trim().slice(0, 64);
    } else {
      issues.push(`ignored binding "${id}": expected an accelerator string or null`);
    }
  }
  return { bindings, issues };
}

export function serializeHotkeyBindingsFile(bindings: Record<string, string | null>): string {
  const file: HotkeyBindingsFile = { version: 1, bindings };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The slice of a browser KeyboardEvent the capture input needs (pure, testable). */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Return",
  NumpadEnter: "Return",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  CapsLock: "Capslock",
  NumLock: "Numlock",
  ScrollLock: "Scrolllock",
  PrintScreen: "PrintScreen",
  NumpadAdd: "Numadd",
  NumpadSubtract: "Numsub",
  NumpadMultiply: "Nummult",
  NumpadDivide: "Numdiv",
  NumpadDecimal: "Numdec",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

/**
 * Turns a keydown into an accelerator using the physical `code` (so the
 * binding survives keyboard layouts and Shift). Returns undefined while
 * only modifiers are held, so the capture input can keep listening.
 */
export function acceleratorFromKeyEvent(event: KeyEventLike): string | undefined {
  const code = event.code ?? "";
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = `Num${code.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (CODE_TO_KEY[code]) key = CODE_TO_KEY[code];
  else if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(code) || /^(Control|Shift|Alt|Meta|OS)$/.test(event.key ?? "")) {
    return undefined;
  } else if (event.key && event.key.length === 1 && /^[a-z0-9]$/i.test(event.key)) {
    key = event.key.toUpperCase();
  }
  if (!key) return undefined;
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}
