import { CLASS_SIZE_DEFAULTS } from "./itemSizeCatalog.js";

export const DEFAULT_VOICE_TRANSFER_HOTKEY = "CommandOrControl+Alt+V";

export interface VoiceTransferConfig {
  enabled: boolean;
  hotkey: string;
  dryRun: boolean;
  qaAcknowledged: boolean;
  allowlist: string[];
  actionsPerMinute: number;
  maxItems?: number;
  allowLiteralFallback: boolean;
  recognitionTimeoutMs: number;
  minimumConfidence: number;
}

export type VoiceCommandMode = "class" | "literal";

export interface VoiceCommand {
  transcript: string;
  phrase: string;
  mode: VoiceCommandMode;
  wantedClasses: string[];
  searchQuery: string;
}

export type VoiceTransferPhase =
  | "idle"
  | "listening"
  | "recognized"
  | "transferring"
  | "complete"
  | "cancelled"
  | "error";

export interface VoiceTransferState {
  phase: VoiceTransferPhase;
  updatedAt: string;
  source?: "hotkey" | "ui";
  transcript?: string;
  confidence?: number;
  commandMode?: VoiceCommandMode;
  wantedClasses?: string[];
  searchQuery?: string;
  transferReason?: string;
  error?: string;
}

export interface VoiceTransferStatus extends VoiceTransferState {
  config: VoiceTransferConfig;
  hotkeyRegistered: boolean;
  hotkeyError?: string;
}

export const DEFAULT_VOICE_TRANSFER_CONFIG: VoiceTransferConfig = {
  enabled: true,
  hotkey: DEFAULT_VOICE_TRANSFER_HOTKEY,
  dryRun: true,
  qaAcknowledged: false,
  allowlist: [
    "PathOfExileSteam.exe",
    "PathOfExile.exe",
    "PathOfExile_x64Steam.exe",
  ],
  actionsPerMinute: 240,
  allowLiteralFallback: false,
  recognitionTimeoutMs: 6_000,
  minimumConfidence: 0.45,
};

const CLASS_GROUPS: Array<{ aliases: string[]; classes: string[] }> = [
  {
    aliases: ["currency", "currencies", "currency item", "currency items"],
    classes: ["Currency", "Stackable Currency"],
  },
  {
    aliases: ["tablet", "tablets"],
    classes: ["Tablet", "Tablets"],
  },
  {
    aliases: ["gem", "gems"],
    classes: [
      "Gems",
      "Skill Gems",
      "Support Gems",
      "Uncut Skill Gems",
      "Uncut Support Gems",
      "Uncut Spirit Gems",
    ],
  },
  {
    aliases: ["flask", "flasks"],
    classes: [
      "Flasks",
      "Life Flasks",
      "Mana Flasks",
      "Hybrid Flasks",
      "Utility Flasks",
    ],
  },
  {
    aliases: ["body", "body armour", "body armours", "body armor", "body armors"],
    classes: ["Body Armours"],
  },
  {
    aliases: ["focus", "focuses", "foci"],
    classes: ["Foci"],
  },
  {
    aliases: ["staff", "staffs", "stave", "staves"],
    classes: ["Staves"],
  },
  {
    aliases: ["quarterstaff", "quarterstaffs", "quarterstave", "quarterstaves"],
    classes: ["Quarterstaves"],
  },
  {
    aliases: ["sceptre", "sceptres", "scepter", "scepters"],
    classes: ["Sceptres"],
  },
  {
    aliases: ["one hand mace", "one hand maces", "one handed mace", "one handed maces"],
    classes: ["One Hand Maces", "One Handed Maces"],
  },
  {
    aliases: ["one hand axe", "one hand axes", "one handed axe", "one handed axes"],
    classes: ["One Hand Axes", "One Handed Axes"],
  },
  {
    aliases: ["one hand sword", "one hand swords", "one handed sword", "one handed swords"],
    classes: ["One Hand Swords", "One Handed Swords"],
  },
  {
    aliases: ["two hand mace", "two hand maces", "two handed mace", "two handed maces"],
    classes: ["Two Hand Maces", "Two Handed Maces"],
  },
  {
    aliases: ["two hand axe", "two hand axes", "two handed axe", "two handed axes"],
    classes: ["Two Hand Axes", "Two Handed Axes"],
  },
  {
    aliases: ["two hand sword", "two hand swords", "two handed sword", "two handed swords"],
    classes: ["Two Hand Swords", "Two Handed Swords"],
  },
];

const RESERVED_HOTKEYS = new Set([
  "control+shift+escape",
  "control+shift+esc",
  "control+d",
]);

function normalizedPhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function singularAlias(itemClass: string): string {
  const phrase = normalizedPhrase(itemClass);
  if (phrase.endsWith("ies")) return `${phrase.slice(0, -3)}y`;
  if (phrase.endsWith("ves")) return `${phrase.slice(0, -3)}f`;
  if (phrase.endsWith("s")) return phrase.slice(0, -1);
  return phrase;
}

function pluralAlias(itemClass: string): string {
  const phrase = normalizedPhrase(itemClass);
  if (phrase.endsWith("s")) return phrase;
  if (phrase.endsWith("y")) return `${phrase.slice(0, -1)}ies`;
  return `${phrase}s`;
}

function classAliases(): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const group of CLASS_GROUPS) {
    for (const alias of group.aliases) aliases.set(normalizedPhrase(alias), group.classes);
  }
  for (const row of CLASS_SIZE_DEFAULTS) {
    const canonical = normalizedPhrase(row.itemClass);
    const variants = new Set([
      canonical,
      singularAlias(row.itemClass),
      pluralAlias(row.itemClass),
    ]);
    if (canonical.includes("armour")) {
      variants.add(canonical.replaceAll("armour", "armor"));
      variants.add(singularAlias(row.itemClass).replaceAll("armour", "armor"));
    }
    for (const alias of variants) {
      if (alias && !aliases.has(alias)) aliases.set(alias, [row.itemClass]);
    }
  }
  return aliases;
}

const VOICE_CLASS_ALIASES = classAliases();

function uniqueClasses(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function exactClassSearchQuery(classes: string[]): string {
  const canonical = uniqueClasses(classes.map((entry) => entry.trim()).filter(Boolean));
  if (canonical.length === 0) throw new Error("voice-item-class-required");
  const alternatives = canonical.map(escapeRegexLiteral);
  const expression =
    alternatives.length === 1 ? alternatives[0]! : `(${alternatives.join("|")})`;
  const query = `"class: ${expression}"`;
  if (!isSafeStashSearchQuery(query)) throw new Error("voice-search-query-too-long");
  return query;
}

export function isSafeStashSearchQuery(query: string): boolean {
  const bounded =
    query.length >= 3 &&
    query.length <= 250 &&
    !/[\u0000-\u001f\u007f]/.test(query) &&
    query.trim() === query;
  if (!bounded) return false;
  return (
    /^"class: [-a-z0-9 ()|']+"$/i.test(query) ||
    /^"\^[a-z0-9][-a-z0-9 ']*\$"$/i.test(query)
  );
}

function literalSearchQuery(phrase: string): string {
  const literal = phrase
    .trim()
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
  if (
    literal.length < 3 ||
    literal.length > 48 ||
    !/[a-z]/i.test(literal) ||
    !/^[a-z0-9][a-z0-9 '\-]*$/i.test(literal) ||
    /^(?:all|anything|everything|item|items|stuff|stash)$/i.test(literal)
  ) {
    throw new Error("voice-literal-search-unsafe");
  }
  const query = `"^${escapeRegexLiteral(literal)}$"`;
  if (!isSafeStashSearchQuery(query)) throw new Error("voice-literal-search-unsafe");
  return query;
}

function commandBody(transcript: string): {
  phrase: string;
  explicitlyRequestedSearch: boolean;
} {
  let phrase = normalizedPhrase(transcript);
  phrase = phrase.replace(/^please\s+/, "");
  const explicitlyRequestedSearch =
    /^(?:literal|exact|find|search(?:\s+for)?|look\s+for)\b/.test(phrase);
  phrase = phrase.replace(
    /^(?:transfer|withdraw|move|take|grab|find|search(?:\s+for)?|look\s+for|literal(?:\s+search(?:\s+for)?)?|exact(?:\s+search(?:\s+for)?)?)\s+/,
    "",
  );
  phrase = phrase
    .replace(/\s+(?:from\s+(?:the\s+)?stash|to\s+(?:the\s+)?bag|into\s+(?:the\s+)?bag|please)$/g, "")
    .trim();
  return { phrase, explicitlyRequestedSearch };
}

function resolveClassPhrase(phrase: string): string[] | undefined {
  const direct = VOICE_CLASS_ALIASES.get(normalizedPhrase(phrase));
  if (direct) return direct;
  const parts = phrase
    .split(/\s+(?:and|plus)\s+|,\s*/)
    .map(normalizedPhrase)
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const classes: string[] = [];
  for (const part of parts) {
    const resolved = VOICE_CLASS_ALIASES.get(part);
    if (!resolved) return undefined;
    classes.push(...resolved);
  }
  return uniqueClasses(classes);
}

export function resolveVoiceCommand(
  transcript: string,
  allowLiteralFallback = false,
): VoiceCommand {
  const trimmed = transcript.trim();
  if (!trimmed) throw new Error("voice-no-speech");
  const { phrase, explicitlyRequestedSearch } = commandBody(trimmed);
  if (!phrase) throw new Error("voice-command-empty");
  const wantedClasses = resolveClassPhrase(phrase);
  if (wantedClasses) {
    return {
      transcript: trimmed,
      phrase,
      mode: "class",
      wantedClasses,
      searchQuery: exactClassSearchQuery(wantedClasses),
    };
  }
  if (!allowLiteralFallback || !explicitlyRequestedSearch) {
    throw new Error("voice-command-not-supported");
  }
  return {
    transcript: trimmed,
    phrase,
    mode: "literal",
    wantedClasses: [],
    searchQuery: literalSearchQuery(phrase),
  };
}

export function voiceRecognitionPhrases(): string[] {
  const phrases = new Set<string>();
  for (const alias of VOICE_CLASS_ALIASES.keys()) {
    phrases.add(alias);
    phrases.add(`transfer ${alias}`);
    phrases.add(`withdraw ${alias}`);
    phrases.add(`find ${alias}`);
    phrases.add(`search for ${alias}`);
  }
  return [...phrases].sort();
}

function canonicalHotkey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/commandorcontrol|cmdorctrl|command|cmd|ctrl/g, "control")
    .replace(/option/g, "alt");
}

export function validateVoiceHotkey(value: string): string {
  const hotkey = String(value ?? "").trim();
  if (!hotkey || hotkey.length > 64 || /[\u0000-\u001f\u007f]/.test(hotkey)) {
    throw new Error("invalid-voice-hotkey");
  }
  const parts = hotkey.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) throw new Error("voice-hotkey-modifier-required");
  const modifiers = new Set([
    "commandorcontrol",
    "cmdorctrl",
    "control",
    "ctrl",
    "command",
    "cmd",
    "alt",
    "option",
    "shift",
    "super",
    "meta",
  ]);
  if (!parts.slice(0, -1).every((part) => modifiers.has(part.toLowerCase()))) {
    throw new Error("invalid-voice-hotkey");
  }
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|space|tab|escape|esc|home|end|pageup|pagedown)$/i.test(parts.at(-1)!)) {
    throw new Error("invalid-voice-hotkey");
  }
  if (RESERVED_HOTKEYS.has(canonicalHotkey(hotkey))) {
    throw new Error("voice-hotkey-reserved");
  }
  return hotkey;
}

function finiteNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-voice-number");
  return parsed;
}

function booleanSetting(
  value: unknown,
  fallback: boolean,
  error: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(error);
  return value;
}

export function normalizeVoiceTransferConfig(
  value: Partial<VoiceTransferConfig> | undefined,
  base: VoiceTransferConfig = DEFAULT_VOICE_TRANSFER_CONFIG,
): VoiceTransferConfig {
  const actionsPerMinute = Math.floor(
    finiteNumber(value?.actionsPerMinute, base.actionsPerMinute),
  );
  if (actionsPerMinute < 1 || actionsPerMinute > 1_200) {
    throw new Error("invalid-actions-per-minute");
  }
  const recognitionTimeoutMs = Math.floor(
    finiteNumber(value?.recognitionTimeoutMs, base.recognitionTimeoutMs),
  );
  if (recognitionTimeoutMs < 1_500 || recognitionTimeoutMs > 15_000) {
    throw new Error("invalid-voice-timeout");
  }
  const minimumConfidence = finiteNumber(
    value?.minimumConfidence,
    base.minimumConfidence,
  );
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error("invalid-voice-confidence");
  }
  const hasMaxItems = Boolean(
    value && Object.prototype.hasOwnProperty.call(value, "maxItems"),
  );
  const maxItemsValue = value?.maxItems;
  let maxItems = base.maxItems;
  if (!hasMaxItems) {
    maxItems = base.maxItems;
  } else if (maxItemsValue === undefined || Number(maxItemsValue) === 0) {
    maxItems = undefined;
  } else {
    maxItems = Math.floor(Number(maxItemsValue));
    if (!Number.isFinite(maxItems) || maxItems < 1 || maxItems > 60) {
      throw new Error("invalid-max-items");
    }
  }
  if (value?.allowlist !== undefined && !Array.isArray(value.allowlist)) {
    throw new Error("invalid-process-allowlist");
  }
  const allowlist = value?.allowlist
    ? uniqueClasses(value.allowlist.map(String).map((entry) => entry.trim()).filter(Boolean))
    : [...base.allowlist];
  return {
    enabled: booleanSetting(
      value?.enabled,
      base.enabled,
      "invalid-voice-enabled",
    ),
    hotkey: validateVoiceHotkey(value?.hotkey ?? base.hotkey),
    dryRun: booleanSetting(
      value?.dryRun,
      base.dryRun,
      "invalid-voice-dry-run",
    ),
    qaAcknowledged: booleanSetting(
      value?.qaAcknowledged,
      base.qaAcknowledged,
      "invalid-voice-acknowledgement",
    ),
    allowlist,
    actionsPerMinute,
    ...(maxItems ? { maxItems } : {}),
    allowLiteralFallback: booleanSetting(
      value?.allowLiteralFallback,
      base.allowLiteralFallback,
      "invalid-voice-literal-fallback",
    ),
    recognitionTimeoutMs,
    minimumConfidence,
  };
}
