/**
 * Pure reader for the game's `poe2_production_Config.ini`
 * (`%USERPROFILE%\[OneDrive\]Documents\My Games\Path of Exile 2\`).
 *
 * The companion needs three things from it: the client language (whisper
 * templates), the resolution/window mode (overlay placement), and the VK
 * code of the chat key (chat commands press it before typing). Everything
 * else is ignored; missing keys stay undefined so callers apply English /
 * Enter defaults explicitly. Reading the file itself is done by the
 * client-log feature module in main.
 */

export interface GameSettings {
  /** Language code ("en", "ru", …) when the ini names one; raw value if unknown. */
  language?: string;
  resolution?: { width: number; height: number };
  borderlessWindowed?: boolean;
  fullscreen?: boolean;
  /** Windows virtual-key code of the chat key; 13 = Enter. */
  chatKey?: number;
  /** VK code of the stash-search key when the ini names one. */
  searchKey?: number;
}

const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  russian: "ru",
  portuguese: "pt",
  brazilian: "pt",
  korean: "ko",
  german: "de",
  french: "fr",
  spanish: "es",
  thai: "th",
  japanese: "ja",
  "simplified chinese": "zh-Hans",
  simplifiedchinese: "zh-Hans",
  "traditional chinese": "zh-Hant",
  traditionalchinese: "zh-Hant",
};

function parseBoolean(value: string): boolean | undefined {
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return undefined;
}

/** The first integer in a value ("13", "13 0" → 13). */
function parseLeadingInt(value: string): number | undefined {
  const match = /^\s*(-?\d+)/.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Drops a leading UTF-8 byte-order mark (the game writes one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Sections → lowercase key → raw value. Tolerates CRLF, BOM, comments (`;`, `#`) and blank lines. */
export function parseIniSections(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = "";
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      current = section[1].trim().toUpperCase();
      sections[current] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    sections[current] ??= {};
    sections[current][key] = value;
  }
  return sections;
}

export function parseGameSettingsIni(text: string): GameSettings {
  const sections = parseIniSections(text);
  const out: GameSettings = {};

  const display = sections.DISPLAY ?? {};
  const width = parseLeadingInt(display.resolution_width ?? "");
  const height = parseLeadingInt(display.resolution_height ?? "");
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    out.resolution = { width, height };
  }
  const fullscreen = display.fullscreen === undefined ? undefined : parseBoolean(display.fullscreen);
  if (fullscreen !== undefined) out.fullscreen = fullscreen;
  const borderless =
    display.borderless_windowed_fullscreen === undefined
      ? undefined
      : parseBoolean(display.borderless_windowed_fullscreen);
  if (borderless !== undefined) out.borderlessWindowed = borderless;

  const keys = sections.ACTION_KEYS ?? {};
  const chat = keys.chat === undefined ? undefined : parseLeadingInt(keys.chat);
  if (chat !== undefined) out.chatKey = chat;
  const searchKeyName = Object.keys(keys).find((key) => /search/.test(key));
  const search = searchKeyName === undefined ? undefined : parseLeadingInt(keys[searchKeyName]);
  if (search !== undefined) out.searchKey = search;

  for (const section of Object.values(sections)) {
    const language = section.language;
    if (language === undefined || language === "") continue;
    const normalized = language.toLowerCase();
    out.language = LANGUAGE_CODES[normalized] ?? normalized;
    break;
  }
  return out;
}
