/** Independently implemented read-only price helper. No upstream code or binaries. */
export const EXCHANGE_CATEGORIES = ["Currency", "Runes", "Expedition", "Verisium", "UncutGems"] as const;
export type ExchangeCategory = typeof EXCHANGE_CATEGORIES[number];
export const HELPER_LEAGUES = ["Runes of Aldur", "HC Runes of Aldur", "Forbidden Rites", "HC Forbidden Rites", "Standard", "Hardcore"] as const;
export const HELPER_THEMES = { Toxic: "#86efac", Midnight: "#a5b4fc", Obsidian: "#e2e8f0", Abyss: "#67e8f9", Ember: "#fdba74" } as const;
export type HelperMode = "prices" | "rumours";
export interface HelperRegion { x: number; y: number; width: number; height: number; clientWidth: number; clientHeight: number }
export interface HelperConfig {
  league: string;
  autoRefresh: boolean;
  theme: keyof typeof HELPER_THEMES;
  mode: HelperMode;
  debug: boolean;
  minimizeToTray: boolean;
  regions: Partial<Record<HelperMode, HelperRegion>>;
}
export interface ExchangePrice { id: string; name: string; exalted?: number; divine?: number }
export interface CategorySnapshot { category: ExchangeCategory; fetchedAt: string; prices: ExchangePrice[]; error?: string }
export interface Rumour { name: string; map: string; mods: string; rating: string }
export interface HelperRow { text: string; name?: string; quantity?: number; total?: number; unit?: number; currency?: "ex" | "div"; state: "priced" | "unknown" | "no-data" | "rumour"; stale: boolean; detail: string; y?: number; height?: number }
export interface HelperStatus {
  config: HelperConfig; running: boolean; message: string; refreshing: boolean;
  categories: Array<{ category: ExchangeCategory; count: number; fetchedAt?: string; error?: string }>;
  rows: HelperRow[]; rumourCount: number; rumoursFetchedAt?: string; hotkeyErrors: string[];
}
export interface PriceHelperBridge {
  status(): Promise<HelperStatus>;
  configure(config: unknown): Promise<HelperStatus>;
  refresh(): Promise<HelperStatus>;
  refreshRumours(): Promise<HelperStatus>;
  lookup(text: string): Promise<HelperRow[]>;
  calibrate(): Promise<HelperStatus>;
  start(): Promise<HelperStatus>;
  stop(): Promise<HelperStatus>;
}
export function helperDefaults(): HelperConfig {
  return { league: "Runes of Aldur", autoRefresh: false, theme: "Toxic", mode: "prices", debug: false, minimizeToTray: false, regions: {} };
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function validRegion(value: unknown): value is HelperRegion {
  const r = record(value);
  return [r.x, r.y, r.width, r.height, r.clientWidth, r.clientHeight].every(n => typeof n === "number" && Number.isInteger(n)) &&
    Number(r.x) >= 0 && Number(r.y) >= 0 && Number(r.width) >= 20 && Number(r.height) >= 20 &&
    Number(r.width) <= 2000 && Number(r.height) <= 2000 && Number(r.clientWidth) <= 16384 && Number(r.clientHeight) <= 16384 &&
    Number(r.x) + Number(r.width) <= Number(r.clientWidth) && Number(r.y) + Number(r.height) <= Number(r.clientHeight);
}
export function validateHelperConfig(value: unknown): HelperConfig {
  const v = record(value);
  if (typeof v.league !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} '()-]{0,79}$/u.test(v.league)) throw new Error("Enter a valid league name (up to 80 characters).");
  if (!Object.hasOwn(HELPER_THEMES, String(v.theme)) || !["prices", "rumours"].includes(String(v.mode))) throw new Error("Invalid helper theme or mode.");
  if ([v.autoRefresh, v.debug, v.minimizeToTray].some(b => typeof b !== "boolean")) throw new Error("Invalid helper setting.");
  const regions: HelperConfig["regions"] = {};
  for (const mode of ["prices", "rumours"] as const) {
    const region = record(v.regions)[mode];
    if (region !== undefined) {
      if (!validRegion(region)) throw new Error("Invalid capture region. Recalibrate within the game window.");
      regions[mode] = { ...region };
    }
  }
  return { league: v.league.trim(), autoRefresh: v.autoRefresh as boolean, theme: v.theme as HelperConfig["theme"], mode: v.mode as HelperMode, debug: v.debug as boolean, minimizeToTray: v.minimizeToTray as boolean, regions };
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12; }
function safeText(value: unknown, max = 180): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b-\x1f]/.test(value); }
export function normalizeHelperName(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** Prices are denominated in core.primary; Hardcore must not be assumed to use divines. */
export function parseNinjaExchange(payload: unknown): ExchangePrice[] {
  const p = record(payload), core = record(p.core), rates = record(core.rates);
  if (!Array.isArray(p.items) || !Array.isArray(p.lines) || p.items.length > 10000 || p.lines.length > 10000) throw new Error("Invalid poe.ninja response.");
  if (!["divine", "exalted", "chaos"].includes(String(core.primary))) throw new Error("Unknown price denomination.");
  const exRate = core.primary === "exalted" ? 1 : rates.exalted;
  const divRate = core.primary === "divine" ? 1 : rates.divine;
  if (!positive(exRate) && !positive(divRate)) throw new Error("Missing exchange rates.");
  const names = new Map<string, string>();
  for (const item of p.items) {
    const i = record(item);
    if (safeText(i.id) && safeText(i.name)) names.set(i.id, i.name.trim());
  }
  const prices: ExchangePrice[] = [];
  for (const line of p.lines) {
    const l = record(line);
    if (typeof l.id !== "string" || !names.has(l.id)) continue;
    const price: ExchangePrice = { id: l.id, name: names.get(l.id)! };
    if (positive(l.primaryValue)) {
      if (positive(exRate) && positive(l.primaryValue * exRate)) price.exalted = l.primaryValue * exRate;
      if (positive(divRate) && positive(l.primaryValue * divRate)) price.divine = l.primaryValue * divRate;
    }
    prices.push(price);
  }
  if (!prices.length) throw new Error("No items returned by poe.ninja.");
  return prices;
}
export function parseHelperStack(raw: string): { name: string; quantity: number } | undefined {
  let name = raw.trim(), quantity = 1;
  const prefix = name.match(/^(\d{1,5})\s*[x×]\s*/i);
  const suffix = name.match(/\s+(?:[x×]\s*(\d{1,5})|\((\d{1,5})\))\s*$/i);
  if (prefix && suffix) return undefined;
  if (prefix) { quantity = Number(prefix[1]); name = name.slice(prefix[0].length); }
  if (suffix) { quantity = Number(suffix[1] ?? suffix[2]); name = name.slice(0, -suffix[0].length); }
  if (!name || quantity < 1 || quantity > 99999) return undefined;
  return { name: normalizeHelperName(name), quantity };
}
export function priceHelperRow(text: string, snapshots: CategorySnapshot[], now = Date.now()): HelperRow {
  const row: HelperRow = { text: text.slice(0, 300), state: "unknown", stale: false, detail: "? — item, stack, or gem level could not be matched exactly" };
  const stack = parseHelperStack(text);
  if (!stack) return row;
  const matches = snapshots.flatMap(s => s.prices.filter(p => normalizeHelperName(p.name) === stack.name).map(p => ({ p, s })));
  // No fuzzy/prefix fallback: especially never substitute a neighbouring gem level or type.
  if (matches.length !== 1) return row;
  const { p, s } = matches[0]!;
  row.name = p.name; row.quantity = stack.quantity;
  row.stale = Boolean(s.error) || now - Date.parse(s.fetchedAt) >= 30 * 60_000;
  const useDivine = p.divine !== undefined && (p.divine * stack.quantity >= 1 || p.exalted === undefined);
  const unit = useDivine ? p.divine : p.exalted;
  if (unit === undefined) { row.state = "no-data"; row.detail = "No market data in the display currency"; return row; }
  row.currency = useDivine ? "div" : "ex";
  row.unit = unit; row.total = unit * stack.quantity; row.state = "priced";
  row.detail = `${formatHelperValue(row.total)} ${row.currency}${stack.quantity > 1 ? ` (${formatHelperValue(unit)} each)` : ""}${row.stale ? " · stale" : ""}`;
  return row;
}
export function formatHelperValue(value: number): string {
  return value > 0 && value < 0.01 ? "<0.01" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
/** Small RFC4180 reader: fields are displayed as text, never interpreted as formulas or HTML. */
export function parseRumourCsv(csv: string): Rumour[] {
  if (csv.length > 1_000_000) throw new Error("Rumour sheet is too large.");
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(field.replace(/\r$/, "")); field = ""; if (c === "\n") { rows.push(row); row = []; } }
    else field += c;
  }
  if (quoted) throw new Error("Invalid rumour CSV quoting.");
  if (field || row.length) rows.push([...row, field.replace(/\r$/, "")]);
  const header = rows.shift()?.map(c => c.replace(/^\uFEFF/, "").trim().toLowerCase());
  if (header?.slice(0, 4).join(",") !== "rumor,map type,mods,rating") throw new Error("Rumour sheet columns have changed.");
  const entries = rows.filter(r => r.length >= 4 && safeText(r[0]) && safeText(r[1]) && safeText(r[2], 1000) && safeText(r[3], 150)).map(r => ({ name: r[0]!.trim(), map: r[1]!.trim(), mods: r[2]!.trim(), rating: r[3]!.trim() }));
  if (!entries.length || entries.length > 2000) throw new Error("No valid rumour data.");
  return entries;
}
export function rumourHelperRow(text: string, rumours: Rumour[], fetchedAt?: string, now = Date.now()): HelperRow {
  const key = normalizeHelperName(text);
  const exact = rumours.filter(r => normalizeHelperName(r.name) === key);
  const matches = exact.length ? exact : /(?:…|\.\.\.)\s*$/.test(text) && key.length >= 8 ? rumours.filter(r => normalizeHelperName(r.name).startsWith(key)) : [];
  const entry = matches.length === 1 ? matches[0] : undefined;
  return { text: text.slice(0, 300), name: entry?.name, state: entry ? "rumour" : "unknown", stale: !fetchedAt || now - Date.parse(fetchedAt) > 24 * 3600_000, detail: entry ? `${entry.rating} · ${entry.map} · ${entry.mods}` : "? — rumour not matched unambiguously" };
}
