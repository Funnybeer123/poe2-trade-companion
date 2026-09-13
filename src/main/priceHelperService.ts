import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EXCHANGE_CATEGORIES, helperDefaults, parseNinjaExchange, parseRumourCsv, priceHelperRow,
  record, rumourHelperRow, validateHelperConfig, validRegion,
  type CategorySnapshot, type HelperConfig, type HelperRegion, type HelperRow, type HelperStatus, type Rumour,
} from "../core/priceHelper.js";

export const RUMOUR_SHEET = "https://docs.google.com/spreadsheets/d/16YU8mSS7TdLPdmOunVjiPn_NrKVGfcnMkuMQDy8jgZA/export?format=csv&gid=0";
const REFRESH_MS = 30 * 60_000;
export interface HelperCapture {
  read(region: HelperRegion): Promise<Record<string, unknown>>;
  calibrate(): Promise<Record<string, unknown>>;
  close(): void;
}
export interface HelperServiceOptions {
  directory: string;
  capture: HelperCapture;
  show(rows: HelperRow[], target: Record<string, unknown>, config: HelperConfig): Promise<void>;
  hide(): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
function readJson(file: string): unknown {
  try {
    if (!existsSync(file) || statSync(file).size > 5_000_000) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return undefined; }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}
/** Only fixed public data endpoints, with bounded, credential-free HTTPS requests. */
export async function fetchHelperText(url: string, fetchImpl: typeof fetch, signal: AbortSignal, sheet = false): Promise<string> {
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url);
    const allowed = sheet
      ? parsed.hostname === "docs.google.com" || /^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(parsed.hostname)
      : parsed.hostname === "poe.ninja" && parsed.pathname === "/poe2/api/economy/exchange/current/overview";
    if (!allowed || parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) throw new Error("Blocked an unexpected data endpoint.");
    const response = await fetchImpl(parsed.toString(), { signal, redirect: "manual", credentials: "omit", headers: { Accept: sheet ? "text/csv" : "application/json", "User-Agent": "PoE2TradeCompanion/0.1 (read-only price helper)" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || !sheet) throw new Error("Unexpected data redirect.");
      url = new URL(location, url).toString(); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Data service returned HTTP ${response.status}. Retry in a minute.`); }
    const limit = sheet ? 1_000_000 : 4_000_000;
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Data response is too large."); }
    if (!response.body) throw new Error("Empty data response.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length;
        if (length > limit) throw new Error("Data response is too large.");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Too many data redirects.");
}
export class PriceHelperService {
  private config: HelperConfig = helperDefaults();
  private snapshots: CategorySnapshot[] = [];
  private rumours: Rumour[] = [];
  private rumoursFetchedAt?: string;
  private running = false;
  private message = "Ready. Refresh prices, then calibrate an item list.";
  private rows: HelperRow[] = [];
  private generation = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<HelperStatus>;
  private rumourRefresh?: Promise<HelperStatus>;
  private attempts = new Map<string, number>();
  private controllers = new Set<AbortController>();
  hotkeyErrors: string[] = [];
  constructor(private options: HelperServiceOptions) {
    try { const saved = readJson(path.join(options.directory, "settings.json")); if (saved) this.config = validateHelperConfig(saved); } catch { this.message = "Invalid saved settings were reset. Recalibrate before scanning."; }
    this.loadPrices();
    const cached = record(readJson(path.join(options.directory, "rumours.json")));
    if (typeof cached.csv === "string" && typeof cached.at === "string" && this.validStamp(cached.at)) {
      try { this.rumours = parseRumourCsv(cached.csv); this.rumoursFetchedAt = cached.at; } catch { /* Invalid cache is discarded. */ }
    }
    this.armRefresh();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private validStamp(value: string): boolean { const time = Date.parse(value); return Number.isFinite(time) && time <= this.now() && time > 0; }
  private cachePath(league = this.config.league): string { return path.join(this.options.directory, `prices-${createHash("sha256").update(league).digest("hex").slice(0, 24)}.json`); }
  private loadPrices(): void {
    this.snapshots = [];
    const saved = record(readJson(this.cachePath()));
    if (saved.league !== this.config.league || !Array.isArray(saved.categories)) return;
    for (const category of EXCHANGE_CATEGORIES) {
      const cached = record(saved.categories.find(v => record(v).category === category));
      if (typeof cached.fetchedAt !== "string" || !this.validStamp(cached.fetchedAt)) continue;
      try { this.snapshots.push({ category, fetchedAt: cached.fetchedAt, prices: parseNinjaExchange(cached.payload), ...(typeof cached.error === "string" ? { error: cached.error.slice(0, 300) } : {}) }); } catch { /* Ignore invalid category. */ }
    }
  }
  status(): HelperStatus {
    return { config: structuredClone(this.config), running: this.running, message: this.message, refreshing: Boolean(this.refreshing || this.rumourRefresh),
      categories: EXCHANGE_CATEGORIES.map(category => { const s = this.snapshots.find(s => s.category === category); return { category, count: s?.prices.length ?? 0, fetchedAt: s?.fetchedAt, error: s?.error }; }),
      rows: structuredClone(this.rows), rumourCount: this.rumours.length, rumoursFetchedAt: this.rumoursFetchedAt, hotkeyErrors: [...this.hotkeyErrors] };
  }
  configure(raw: unknown): HelperStatus {
    const config = validateHelperConfig(raw), changedLeague = config.league !== this.config.league;
    writeJson(path.join(this.options.directory, "settings.json"), config);
    this.stop(); this.config = config;
    if (changedLeague) this.loadPrices();
    this.armRefresh(); this.message = "Settings saved. Start scanning when ready.";
    return this.status();
  }
  private armRefresh(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.config.autoRefresh || this.disposed) return;
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref?.();
  }
  private async request(url: string, sheet = false): Promise<string> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    try { return await fetchHelperText(url, this.options.fetchImpl ?? fetch, controller.signal, sheet); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  refresh(): Promise<HelperStatus> {
    if (this.refreshing) return this.refreshing;
    if (this.disposed) return Promise.resolve(this.status());
    const league = this.config.league, key = `prices:${league}`, now = this.now();
    if (now - (this.attempts.get(key) ?? -Infinity) < 60_000) { this.message = "Please wait a minute between price refreshes."; return Promise.resolve(this.status()); }
    this.attempts.set(key, now);
    this.refreshing = this.pullPrices(league).finally(() => { this.refreshing = undefined; });
    return this.refreshing.then(() => this.status());
  }
  private async pullPrices(league: string): Promise<HelperStatus> {
    const previous = record(readJson(this.cachePath(league)));
    const cachedCategories: unknown[] = previous.league === league && Array.isArray(previous.categories) ? [...previous.categories] : [];
    const results = await Promise.all(EXCHANGE_CATEGORIES.map(async category => {
      try {
        const payload: unknown = JSON.parse(await this.request(`https://poe.ninja/poe2/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=${category}`));
        const prices = parseNinjaExchange(payload), fetchedAt = new Date(this.now()).toISOString();
        const index = cachedCategories.findIndex(v => record(v).category === category);
        if (index >= 0) cachedCategories.splice(index, 1);
        cachedCategories.push({ category, fetchedAt, payload });
        return { category, fetchedAt, prices } satisfies CategorySnapshot;
      } catch (error) {
        const cachedIndex = cachedCategories.findIndex(v => record(v).category === category);
        if (cachedIndex >= 0) cachedCategories[cachedIndex] = { ...record(cachedCategories[cachedIndex]), error: "Last refresh failed. Cached data may be stale." };
        const old = this.config.league === league ? this.snapshots.find(s => s.category === category) : undefined;
        return { category, fetchedAt: old?.fetchedAt ?? "", prices: old?.prices ?? [], error: error instanceof Error ? error.message : "Refresh failed" } satisfies CategorySnapshot;
      }
    }));
    if (this.disposed) return this.status();
    let cacheError = "";
    try { writeJson(this.cachePath(league), { league, categories: cachedCategories }); } catch { cacheError = " Disk cache could not be saved."; }
    if (this.config.league === league) {
      this.snapshots = results;
      const failed = results.filter(r => "error" in r).length;
      this.message = `${failed ? `${failed} categories could not refresh; retained prices are marked stale.` : "All five price categories refreshed."}${cacheError}`;
    }
    return this.status();
  }
  refreshRumours(): Promise<HelperStatus> {
    if (this.rumourRefresh) return this.rumourRefresh;
    if (this.disposed) return Promise.resolve(this.status());
    if (this.now() - (this.attempts.get("rumours") ?? -Infinity) < 60_000) { this.message = "Please wait a minute between rumour refreshes."; return Promise.resolve(this.status()); }
    this.attempts.set("rumours", this.now());
    this.rumourRefresh = (async () => {
      try {
        const csv = await this.request(RUMOUR_SHEET, true), rumours = parseRumourCsv(csv), at = new Date(this.now()).toISOString();
        if (this.disposed) return this.status();
        writeJson(path.join(this.options.directory, "rumours.json"), { csv, at });
        this.rumours = rumours; this.rumoursFetchedAt = at;
        this.message = "Community rumour ratings refreshed.";
      } catch (error) { this.message = error instanceof Error ? error.message : "Rumour refresh failed."; }
      return this.status();
    })().finally(() => { this.rumourRefresh = undefined; });
    return this.rumourRefresh.then(() => this.status());
  }
  lookup(text: unknown): HelperRow[] {
    if (typeof text !== "string" || text.length > 30_000) throw new Error("Enter at most 30,000 characters.");
    return text.split(/\r?\n/).filter(s => s.trim()).slice(0, 100).map(line => this.config.mode === "prices" ? priceHelperRow(line, this.snapshots, this.now()) : rumourHelperRow(line, this.rumours, this.rumoursFetchedAt, this.now()));
  }
  async calibrate(): Promise<HelperStatus> {
    this.stop(); const generation = this.generation, mode = this.config.mode;
    try {
      const result = await this.options.capture.calibrate();
      if (this.disposed || generation !== this.generation) return this.status();
      if (result.ok !== true || !validRegion(result.region)) throw new Error(String(result.error ?? "Calibration cancelled."));
      this.configure({ ...this.config, regions: { ...this.config.regions, [mode]: result.region } });
      this.message = "Region saved. Return to the game and start scanning.";
    } catch (error) { if (generation === this.generation) this.message = error instanceof Error ? error.message : "Calibration failed."; }
    return this.status();
  }
  start(): HelperStatus {
    if (this.disposed || this.running) return this.status();
    if (!this.config.regions[this.config.mode]) { this.message = "Calibrate this list region before scanning."; return this.status(); }
    if (this.config.mode === "prices" ? !this.snapshots.some(s => s.prices.length) : !this.rumours.length) { this.message = "Refresh data before scanning."; return this.status(); }
    this.running = true; this.message = "Waiting for Path of Exile 2…";
    const generation = ++this.generation;
    void this.tick(generation);
    return this.status();
  }
  stop(): HelperStatus {
    this.running = false; this.generation++; this.rows = []; this.options.hide();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined; this.options.capture.close(); this.message = "Scanning stopped.";
    return this.status();
  }
  private async tick(generation: number): Promise<void> {
    try {
      const result = await this.options.capture.read(this.config.regions[this.config.mode]!);
      if (!this.running || generation !== this.generation) return;
      if (result.dismissed === true) { this.stop(); this.message = "Overlay dismissed. Use Start or Ctrl+Shift+F5 to resume."; return; }
      if (result.ok !== true) throw new Error(String(result.error ?? "Game could not be verified."));
      const lines = Array.isArray(result.lines) ? result.lines.slice(0, 100) : [];
      this.rows = lines.flatMap(line => {
        const l = record(line);
        if (typeof l.text !== "string" || l.text.length > 300 || typeof l.y !== "number" || !Number.isFinite(l.y) || l.y < 0 || l.y >= this.config.regions[this.config.mode]!.height) return [];
        const row = this.lookup(l.text)[0];
        return row ? [{ ...row, y: l.y, height: typeof l.height === "number" && l.height > 0 && l.height < 200 ? l.height : 20 }] : [];
      });
      if (this.rows.length) await this.options.show(this.rows, record(result.target), this.config);
      else this.options.hide();
      if (!this.running || generation !== this.generation) return;
      this.message = this.rows.length ? `Scanning ${this.config.mode} · ${this.rows.length} rows` : "No readable rows. Prices hidden.";
    } catch (error) {
      if (generation !== this.generation) return;
      this.rows = []; this.options.hide(); this.message = error instanceof Error ? error.message : "Scan paused.";
    } finally {
      if (this.running && generation === this.generation) this.scanTimer = setTimeout(() => void this.tick(generation), 750);
    }
  }
  dispose(): void {
    this.disposed = true; this.stop();
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
  }
}
