import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { formatHelperValue, record, type CategorySnapshot, type HelperRow } from "../core/priceHelper.js";
import { identifyHelperReward, parseRewardCatalog, parseRewardListingPrices, buildRewardTradeQuery, buildRewardTradeUrl, type RewardCatalogEntry, type RewardIdentity } from "../core/helperReward.js";

export interface HelperRewardResult { payload?: unknown; fetchedAt?: string; tradeUrl?: string; error?: string }
export interface HelperRewardOptions {
  directory: string;
  readCatalog(): Promise<unknown>;
  fetchReward(identity: RewardIdentity, league: string, canRun?: () => boolean): Promise<HelperRewardResult>;
  now?: () => number;
}
type Offer = { amount: number; currency: "chaos" | "divine" | "exalted" };
interface Quote { at: number; offers: Offer[]; error?: string }
const QUOTE_MS = 10 * 60_000, RETRY_MS = 60_000, CATALOG_MS = 24 * 3600_000;
function readBounded(file: string): unknown {
  try { return existsSync(file) && statSync(file).size <= 2_000_000 ? JSON.parse(readFileSync(file, "utf8")) : undefined; } catch { return undefined; }
}

/** Known item identities and bounded, deduplicated listing samples. Never stores seller data. */
export class HelperRewardService {
  catalog: RewardCatalogEntry[] = [];
  catalogError?: string;
  private catalogAt = 0;
  private catalogRequest?: Promise<void>;
  private quotes = new Map<string, Quote>();
  private pending = new Map<string, Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private options: HelperRewardOptions) {
    const saved = record(readBounded(this.file("catalog.json")));
    if (typeof saved.at === "number" && saved.at <= this.now() && saved.at > 0) {
      try { this.catalog = parseRewardCatalog(saved.payload); this.catalogAt = saved.at; } catch { /* Re-fetch an invalid catalog explicitly. */ }
    }
    const cached = record(readBounded(this.file("reward-quotes.json")));
    for (const [key, value] of Object.entries(cached).slice(0, 200)) {
      const q = record(value);
      if (key.length > 800 || typeof q.at !== "number" || q.at > this.now() || this.now() - q.at > CATALOG_MS || !Array.isArray(q.offers) || q.offers.length > 10) continue;
      if (q.offers.every(raw => { const o = record(raw); return typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount > 0 && o.amount <= 1e12 && ["chaos", "divine", "exalted"].includes(String(o.currency)); })) this.quotes.set(key, { at: q.at, offers: q.offers as Offer[] });
    }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private file(name: string): string { return path.join(this.options.directory, name); }
  private save(name: string, value: unknown): void {
    try { mkdirSync(this.options.directory, { recursive: true }); writeFileSync(this.file(name), JSON.stringify(value)); } catch { /* Memory cache remains usable. */ }
  }
  refreshCatalog(): Promise<void> {
    if (this.catalogRequest) return this.catalogRequest;
    if (this.catalog.length && this.now() - this.catalogAt < CATALOG_MS) return Promise.resolve();
    this.catalogRequest = (async () => {
      try { const payload = await this.options.readCatalog(), catalog = parseRewardCatalog(payload); if (!catalog.length) throw new Error("Reward catalog was empty or invalid. Retained the previous catalog."); this.catalog = catalog; this.catalogAt = this.now(); this.catalogError = undefined; this.save("catalog.json", { at: this.catalogAt, payload }); }
      catch (error) { this.catalogError = error instanceof Error ? error.message : "Reward catalog unavailable."; }
    })().finally(() => { this.catalogRequest = undefined; });
    return this.catalogRequest;
  }
  identity(text: string): RewardIdentity | undefined { return identifyHelperReward(text, this.catalog); }
  private key(identity: RewardIdentity, league: string): string { return JSON.stringify([league, identity.kind, identity.name, identity.type, identity.gemLevel]); }
  tradeUrl(text: string, league: string): string | undefined { const identity = this.identity(text); return identity ? buildRewardTradeUrl(identity, league) : undefined; }
  row(text: string, league: string, snapshots: CategorySnapshot[]): HelperRow | undefined {
    const identity = this.identity(text);
    if (!identity) {
      if (/^(?:(?:very rare|rare)\s+)?unique\s+(?:item|ring|belt|amulet|jewellery|wand|two hand mace|talisman|staff|spear|shield|sceptre|quiver|quarterstaff|one hand mace|focus|crossbow|bow|helmet|gloves|boots|body armour)$/i.test(text.trim()) || /^(?:random currency|verisium pile)$/i.test(text.trim())) return { text, state: "no-data", stale: false, detail: "Random reward — the actual item is not known yet." };
      return undefined;
    }
    const eligible = Boolean(buildRewardTradeQuery(identity));
    const row: HelperRow = { text, name: identity.name, quantity: identity.quantity, state: "no-data", stale: false, liveLookup: eligible, detail: eligible ? "Live price lookup available." : "Gem level unreadable or unspecified — enter the exact level to look up prices." };
    if (!eligible) return row;
    const key = this.key(identity, league), quote = this.quotes.get(key);
    if (this.pending.has(key)) { row.lookupState = "pending"; row.detail = "Checking live asking prices…"; }
    if (!quote) return row;
    if (quote.error || !quote.offers.length) { if (row.lookupState !== "pending") { row.lookupState = quote.error ? "error" : "unavailable"; row.detail = quote.error ?? "No matching priced listings. Open the trade search to inspect availability."; } return row; }
    const currency = snapshots.find(s => s.category === "Currency");
    const ratesAge = currency ? this.now() - Date.parse(currency.fetchedAt) : Infinity;
    const ratesFresh = currency && !currency.error && ratesAge >= 0 && ratesAge < 30 * 60_000;
    const divine = ratesFresh ? currency.prices.find(p => p.name === "Divine Orb")?.chaos : undefined;
    const exalted = ratesFresh ? currency.prices.find(p => p.name === "Exalted Orb")?.chaos : undefined;
    const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
    const allDivine = quote.offers.every(o => o.currency === "divine");
    const amounts = quote.offers.map(o => o.currency === "chaos" ? o.amount : o.currency === "divine" && positive(divine) ? o.amount * divine : o.currency === "exalted" && positive(exalted) ? o.amount * exalted : undefined);
    if (amounts.some(v => !positive(v)) && !allDivine) { row.lookupState = "unavailable"; row.detail = "Refresh currency rates to compare these live listings safely."; return row; }
    const count = identity.quantity ?? 1;
    const lowChaos = Math.min(...amounts.filter(positive)), useDivine = allDivine && !positive(divine) || positive(divine) && lowChaos * count >= divine;
    const values = allDivine && !positive(divine) ? quote.offers.map(o => o.amount) : (amounts as number[]).map(v => useDivine ? v / divine! : v);
    const low = Math.min(...values), high = Math.max(...values);
    row.state = "priced"; row.source = "trade"; row.currency = useDivine ? "div" : "chaos"; row.unit = low; row.rangeHigh = high * count; row.sampleCount = values.length;
    if (!identity.quantityUncertain) { row.quantity = count; row.total = low * count; }
    row.stale = this.now() - quote.at >= QUOTE_MS;
    const range = `${formatHelperValue(low * count)}${high !== low ? `–${formatHelperValue(high * count)}` : ""} ${row.currency}`;
    row.detail = `≈${range}${identity.quantityUncertain ? " each · quantity unreadable" : ""} · ${values.length} sampled offers · ${new Date(quote.at).toLocaleTimeString()}${identity.kind === "gem" ? ` · level ${identity.gemLevel}; quality, corruption and sockets vary` : " · item rolls may vary"}${row.stale ? " · stale" : ""}`;
    if (!row.stale && values.length >= 3 && useDivine) { if (low * count >= 10) row.valueTier = "very-high"; else if (low * count >= 1) row.valueTier = "high"; }
    return row;
  }
  request(text: string, league: string, canRun: () => boolean): Promise<void> {
    const identity = this.identity(text);
    if (!identity || !buildRewardTradeQuery(identity)) return Promise.resolve();
    const key = this.key(identity, league), cached = this.quotes.get(key), active = this.pending.get(key);
    if (active) return active;
    if (cached && this.now() - cached.at < (cached.error || !cached.offers.length ? RETRY_MS : QUOTE_MS)) return Promise.resolve();
    if (this.pending.size >= 6) return Promise.resolve();
    const request = this.chain.then(async () => {
      if (!canRun()) return;
      try {
        const result = await this.options.fetchReward(identity, league, canRun);
        if (!canRun()) return;
        const offers = result.payload === undefined ? [] : parseRewardListingPrices(result.payload, identity);
        const stamp = result.fetchedAt === undefined ? this.now() : Date.parse(result.fetchedAt);
        if (!Number.isFinite(stamp) || stamp <= 0 || stamp > this.now()) throw new Error("Live listing timestamp is invalid.");
        this.quotes.set(key, { at: stamp, offers, ...(result.error ? { error: result.error.slice(0, 300) } : {}) });
      } catch (error) { if (canRun()) this.quotes.set(key, { at: this.now(), offers: [], error: error instanceof Error ? error.message.slice(0, 300) : "Live lookup failed." }); }
      while (this.quotes.size > 200) this.quotes.delete(this.quotes.keys().next().value!);
      this.save("reward-quotes.json", Object.fromEntries([...this.quotes].filter(([, q]) => !q.error && q.offers.length)));
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request); this.chain = request.catch(() => undefined); return request;
  }
}
