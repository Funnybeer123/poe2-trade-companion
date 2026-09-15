/**
 * Evaluate — the main-process service behind the `evaluate:*` channels.
 *
 * Budget discipline (the reason this file exists at all):
 *   - ONE gesture = at most one paced search + one paced fetch. Paging is
 *     explicit ("Load 10 more" = one fetch), currency uses one exchange.
 *   - `tradeBudget()` is read BEFORE every request; a penalty window or an
 *     empty budget produces an error on the session, never a queued retry.
 *   - Re-searching the same body inside 60 s is served by the feed's own
 *     search cache, so ticking a client-side filter costs nothing.
 *   - Every hotkey press is debounced (whatever the capture mode), and a
 *     repeat on the same item re-shows the session — including while its
 *     first search is still in flight — instead of spending a second lookup.
 *   - `open()` returns (and the panel appears) BEFORE the auto-search: the
 *     lookup runs in the background and reaches the panel as a session
 *     event, so a slow trade2 never leaves the user staring at nothing.
 *
 * Game input: none of it lives here. The single audited Ctrl+C is
 * `chatCommands.copyHoveredItem` (F3) — this service only maps its outcome
 * onto a capture state the panel can explain.
 */
import { itemSummary, staticCurrencyIds } from "../../../core/evaluateItem.js";
import {
  initialQueryState,
  profileOf,
  queryStateToTradeQuery,
  sanitizeQueryState,
  complexityHint,
} from "../../../core/evaluateQuery.js";
import {
  estimateFor,
  exchangeSummary,
  historyFor,
  listingRow,
  feedPriceExalted,
} from "../../../core/evaluateResults.js";
import { parseAdvancedItemText, type AdvancedItemText } from "../../../core/itemAnnotations.js";
import { looksLikePoeItemText, parseItemText } from "../../../core/parseItem.js";
import { MOD_FAMILIES } from "../../../core/modKnowledge.js";
import type { PriceTable } from "../../../core/priceTable.js";
import { buildStatCatalogue, type StatCatalogue } from "../../../core/statIds.js";
import type { LearnedTiers } from "../../../core/tierLearning.js";
import {
  toExchangeBody,
  toTradeSearchBody,
  tradeQueryUrl,
  type EvaluateProfileId,
} from "../../../core/tradeQuery.js";
import type { ParsedItem } from "../../../core/types.js";
import type { TierVerdict } from "../../../core/valueTiers.js";
import { tradeCategoryForClass, watchForItem, type Watch } from "../../../core/watchlist.js";
import type { ChatCopyOutcome } from "../../../shared/chatCommands.js";
import {
  autoSearchKeyFor,
  type EvaluateBudgetView,
  type EvaluateCaptureStatus,
  type EvaluateCopyKind,
  type EvaluateEstimate,
  type EvaluateOpenFailure,
  type EvaluateOpenInput,
  type EvaluateQueryState,
  type EvaluateSession,
  type EvaluateSettings,
} from "../../../shared/evaluate.js";
import type { MarketTrendsService } from "../../marketTrendsService.js";
import type { PriceFeedService } from "../../priceFeedService.js";
import type { ItemIntelligenceService } from "../../itemIntelligenceService.js";
import type { WatchlistService } from "../../watchlistService.js";

/** Stat types the builder resolves ids from (explicit-only would lose pseudo). */
export const EVALUATE_STAT_TYPES: readonly string[] = [
  "explicit",
  "implicit",
  "pseudo",
  "rune",
  "enchant",
  "fractured",
  "desecrated",
];

/** Repeat presses of the hotkey inside this window are one gesture. */
export const CAPTURE_DEBOUNCE_MS = 500;
/** Matches the feed's own generic search cache: re-show instead of re-searching. */
export const SESSION_REUSE_MS = 60_000;
/** Sessions kept in memory (the newest is "current"). */
const MAX_SESSIONS = 5;

export type EvaluatePriceFeed = Pick<
  PriceFeedService,
  | "tradeSearch"
  | "tradeFetch"
  | "tradeExchange"
  | "tradeBudget"
  | "hasSession"
  | "statCatalogue"
  | "learnedTiers"
  | "status"
> & {
  /**
   * Optional: the 7-day cached `/data/static` payload, used only to find an
   * exchange id for a stackable TRADE_CURRENCY_NAMES does not know (keys,
   * fragments, essences). Absent on a fake — the fallback still works.
   */
  fetchStatic?: PriceFeedService["fetchStatic"];
  /** Offline metadata for local learned-price sessions. */
  statsPayloadCached?: PriceFeedService["statsPayloadCached"];
};

export type EvaluateItemIntelligence = Pick<ItemIntelligenceService, "getPriceTable" | "evaluateTier">;
export type EvaluateMarketTrends = Pick<MarketTrendsService, "series">;
export type EvaluateWatchlist = Pick<WatchlistService, "overview" | "save">;

export interface EvaluateServiceOptions {
  priceFeed: EvaluatePriceFeed;
  itemIntelligence: EvaluateItemIntelligence;
  marketTrends: EvaluateMarketTrends;
  watchlist: EvaluateWatchlist;
  settings: () => EvaluateSettings;
  clipboard: { readText(): string; writeText(text: string): void };
  openExternal: (url: string) => Promise<void>;
  /** The one audited Ctrl+C (chatCommands.copyHoveredItem), bound by the module. */
  capture: () => Promise<ChatCopyOutcome>;
  onSession: (session: EvaluateSession) => void;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

/** Everything main keeps about a session that never crosses the bridge. */
interface SessionRecord {
  session: EvaluateSession;
  raw: string;
  parsed: ParsedItem;
  advanced: AdvancedItemText;
  verdict?: TierVerdict;
  catalogue?: StatCatalogue;
  learnedTiers?: LearnedTiers;
  priceTable?: PriceTable;
  /** The auto-search fired after open() returned; awaited only by tests. */
  pending?: Promise<unknown>;
  /** Search ids not fetched yet (paging), and the search they belong to. */
  remainingIds: string[];
  searchId?: string;
  league?: string;
  lastBody?: Record<string, unknown>;
}

export function newSessionId(now: Date): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `ev_${now.getTime().toString(36)}_${random}`;
}

function failure(error: string, reason: EvaluateOpenFailure["reason"]): EvaluateOpenFailure {
  return { error, reason };
}

/** `blockedBy` → what the panel tells the user, in their words. */
function captureReason(outcome: ChatCopyOutcome): { status: EvaluateCaptureStatus; reason: string } {
  if (outcome.dryRun) {
    return {
      status: "dry-run",
      reason: "Dry-run: no Ctrl+C was sent — the clipboard item was used. Price lookups still run.",
    };
  }
  switch (outcome.blockedBy) {
    case "timeout":
      return {
        status: "timeout",
        reason:
          "No item text arrived within 900 ms — hover the item and press Ctrl+C yourself, then press the Evaluate hotkey again.",
      };
    case "kill-switch":
      return { status: "blocked", reason: "Emergency stop is latched — re-arm it in the top bar." };
    case "another-host":
      return {
        status: "blocked",
        reason: "Another input host is running (numpad daemon, a CLI or the flask guard).",
      };
    case "not-foreground":
    case "process-not-allowed":
      return {
        status: "blocked",
        reason: "Path of Exile is not the foreground window — click the game, then press the hotkey.",
      };
    case "rate-limit":
      return { status: "blocked", reason: "Too many input gestures just now — try again in a moment." };
    case "disabled":
      return {
        status: "blocked",
        reason: "Game input is switched off in Tools → Settings; copy the item with Ctrl+C instead.",
      };
    default:
      return {
        status: "blocked",
        reason: outcome.error ?? "The hovered item could not be copied.",
      };
  }
}

export class EvaluateService {
  private readonly records = new Map<string, SessionRecord>();
  private order: string[] = [];
  private currentId: string | undefined;
  private lastCaptureAt = 0;
  private staticIds: Map<string, string> | undefined;
  private disposed = false;

  constructor(private readonly options: EvaluateServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private log(level: "info" | "warn" | "error", message: string, detail?: unknown): void {
    this.options.log?.(level, message, detail);
  }

  budget(): EvaluateBudgetView {
    const budget = this.options.priceFeed.tradeBudget();
    const status = this.options.priceFeed.status();
    return {
      lookups: budget.lookups,
      searchesSpare: budget.searchesSpare,
      fetchesSpare: budget.fetchesSpare,
      ...(budget.restrictedUntilIso ? { restrictedUntilIso: budget.restrictedUntilIso } : {}),
      hasSession: this.options.priceFeed.hasSession(),
      ...(status.resolvedLeague ? { league: status.resolvedLeague } : {}),
      leagueAmbiguous: status.leagueAmbiguous,
    };
  }

  current(): EvaluateSession | null {
    if (!this.currentId) return null;
    return this.records.get(this.currentId)?.session ?? null;
  }

  private announce(record: SessionRecord): EvaluateSession {
    record.session.budget = this.budget();
    if (!this.disposed) this.options.onSession(record.session);
    return record.session;
  }

  private require(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`unknown evaluate session "${sessionId}"`);
    return record;
  }

  private remember(record: SessionRecord): void {
    this.records.set(record.session.id, record);
    this.order = [record.session.id, ...this.order.filter((id) => id !== record.session.id)];
    while (this.order.length > MAX_SESSIONS) {
      const dropped = this.order.pop();
      if (dropped) this.records.delete(dropped);
    }
    this.currentId = record.session.id;
  }

  /**
   * The text for this gesture. A hotkey press asks the chat-commands service
   * for ONE Ctrl+C; everything else (Ctrl+D, Item log, a paste) reads the
   * clipboard or takes the text it was handed.
   */
  private async textFor(
    input: EvaluateOpenInput,
  ): Promise<
    | { ok: true; text: string; capture?: { status: EvaluateCaptureStatus; reason: string } }
    | { ok: false; failure: EvaluateOpenFailure }
  > {
    if (typeof input.text === "string" && input.text.trim()) {
      return { ok: true, text: input.text };
    }
    const settings = this.options.settings();
    const wantsCapture = input.source === "hotkey" && settings.captureMode === "auto";
    if (!wantsCapture) {
      const text = this.options.clipboard.readText();
      if (!text.trim()) {
        return {
          ok: false,
          failure: failure("The clipboard is empty — hover an item and press Ctrl+C first.", "empty"),
        };
      }
      return {
        ok: true,
        text,
        capture: { status: "clipboard", reason: "Read from the clipboard (no game input)." },
      };
    }
    let outcome: ChatCopyOutcome;
    const restore = this.markCapturing();
    try {
      outcome = await this.options.capture();
      restore();
    } catch (error) {
      restore();
      this.log("warn", "evaluate capture failed", error);
      return {
        ok: false,
        failure: failure(
          error instanceof Error ? error.message : "The hovered item could not be copied.",
          "blocked",
        ),
      };
    }
    const capture = captureReason(outcome);
    const text = outcome.text ?? "";
    if (!text.trim()) {
      if (outcome.ok && outcome.dryRun) {
        return {
          ok: false,
          failure: failure(
            "Dry-run is on and the clipboard holds no item text — copy an item with Ctrl+C first.",
            "empty",
          ),
        };
      }
      return {
        ok: false,
        failure: failure(capture.reason, capture.status === "timeout" ? "timeout" : "blocked"),
      };
    }
    return {
      ok: true,
      text,
      capture: outcome.ok && !outcome.dryRun ? { status: "copied", reason: "Copied with one Ctrl+C." } : capture,
    };
  }

  /**
   * The panel is normally already open when the next capture starts: mark the
   * current session "capturing" so its spinner is real, and hand back the
   * undo so the previous busy state (a search still in flight) survives.
   */
  private markCapturing(): () => void {
    const record = this.currentId ? this.records.get(this.currentId) : undefined;
    if (!record) return () => undefined;
    const before = record.session.busy;
    record.session.busy = "capturing";
    this.announce(record);
    return () => {
      if (record.session.busy !== "capturing") return;
      record.session.busy = before === "capturing" ? "idle" : before;
      this.announce(record);
    };
  }

  /**
   * Open (or re-show) a session for one item. Never spends a lookup unless
   * the auto-search rule for that item kind says so — and when it does, the
   * lookup runs AFTER this resolves, so the panel is on screen first.
   */
  async open(input: EvaluateOpenInput): Promise<EvaluateSession | EvaluateOpenFailure> {
    // One gesture, whatever the capture mode: a held hotkey must never queue
    // a lookup per auto-repeat (compliance §1 item 2).
    if (input.source === "hotkey") {
      const at = this.now().getTime();
      if (at - this.lastCaptureAt < CAPTURE_DEBOUNCE_MS) {
        return failure("Ignored a repeated Evaluate press within half a second.", "blocked");
      }
      this.lastCaptureAt = at;
    }
    const resolved = await this.textFor(input);
    if (!resolved.ok) return resolved.failure;
    const raw = resolved.text;
    if (!looksLikePoeItemText(raw)) {
      return failure("That does not look like a Path of Exile item copy.", "not-item-text");
    }

    const now = this.now();
    const settings = this.options.settings();
    const advanced = parseAdvancedItemText(raw);
    const parsed = parseItemText(advanced.plainText);
    const priceTable = this.safe<PriceTable | undefined>(
      () => this.options.itemIntelligence.getPriceTable(),
      undefined,
    );
    const summary = itemSummary(parsed, priceTable ? { priceTable } : {});
    // Read saved corrections before either metadata or market work. Reopening
    // must also see an edit/removal made since the previous Evaluate session.
    const verdict = this.safe(() => this.options.itemIntelligence.evaluateTier(raw), undefined);
    const hasTraining = (verdict?.training?.lessonIds.length ?? 0) > 0;
    const localEstimate = hasTraining && verdict?.training?.status !== "unknown" ? estimateFor({
      parsed, listings: [], basis: "base-type", verdict,
      ...(priceTable ? { priceTable } : {}), now,
    }) : undefined;

    // Same item, still inside the search cache — or still waiting for its
    // first answer: re-show rather than re-spend.
    const existing = this.currentId ? this.records.get(this.currentId) : undefined;
    const fresh =
      existing?.session.results !== undefined &&
      now.getTime() - Date.parse(existing.session.results.fetchedAt) < SESSION_REUSE_MS;
    if (
      existing &&
      !hasTraining && !(existing.verdict?.training?.lessonIds.length) &&
      existing.session.item.fingerprint === summary.fingerprint &&
      (fresh || existing.session.busy !== "idle" || existing.pending !== undefined)
    ) {
      existing.session.source = input.source;
      if (resolved.capture) existing.session.capture = resolved.capture;
      return this.announce(existing);
    }

    if (!hasTraining && summary.kind === "currency" && !summary.currencyId) {
      const fromStatic = await this.resolveStaticCurrencyId(summary.name);
      if (fromStatic) summary.currencyId = fromStatic;
    }

    let catalogue: StatCatalogue | undefined;
    try {
      if (hasTraining) {
        const cached = this.options.priceFeed.statsPayloadCached?.();
        if (cached) catalogue = buildStatCatalogue(cached, MOD_FAMILIES, EVALUATE_STAT_TYPES);
      } else {
        catalogue = await this.options.priceFeed.statCatalogue(EVALUATE_STAT_TYPES);
      }
    } catch (error) {
      this.log("warn", "evaluate stat catalogue unavailable", error);
    }
    const learnedTiers = this.safe(() => this.options.priceFeed.learnedTiers(), undefined);
    const query = initialQueryState({
      parsed,
      summary,
      advanced,
      ...(verdict?.appraisal ? { appraisal: verdict.appraisal } : {}),
      ...(catalogue ? { catalogue } : {}),
      ...(learnedTiers ? { learnedTiers } : {}),
      ...(priceTable ? { priceTable } : {}),
      settings,
    });

    const session: EvaluateSession = {
      id: newSessionId(now),
      source: input.source,
      openedAt: now.toISOString(),
      item: summary,
      query,
      busy: "idle",
      ...(localEstimate ? { localEstimate } : {}),
      ...(resolved.capture ? { capture: resolved.capture } : {}),
      catalogueReady: (catalogue?.entryCount ?? 0) > 0,
      budget: this.budget(),
      prefs: { groupBySeller: settings.groupBySeller },
    };
    const record: SessionRecord = {
      session,
      raw,
      parsed,
      advanced,
      ...(verdict ? { verdict } : {}),
      ...(catalogue ? { catalogue } : {}),
      ...(learnedTiers ? { learnedTiers } : {}),
      ...(priceTable ? { priceTable } : {}),
      remainingIds: [],
    };
    this.remember(record);
    await this.attachHistory(record);
    this.announce(record);

    const wantsAuto = input.autoSearch ?? settings.autoSearch[autoSearchKeyFor(summary.kind)];
    if (wantsAuto && !hasTraining) {
      const auto =
        summary.kind === "currency" && settings.exchangeForCurrency && summary.currencyId
          ? () => this.exchange(session.id)
          : () => this.search(session.id, query);
      // Fire, do not await: the caller shows the panel first and the result
      // arrives as an `evaluate:session` event.
      this.track(record, auto());
    }
    return record.session;
  }

  /**
   * Remembers the in-flight auto lookup so a repeat press re-shows this
   * session instead of starting a second one, and so tests can await it.
   */
  private track(record: SessionRecord, task: Promise<unknown>): void {
    const settled = task.catch((error) => {
      this.log("warn", "evaluate auto lookup failed", error);
    });
    record.pending = settled;
    void settled.then(() => {
      if (record.pending === settled) record.pending = undefined;
    });
  }

  /** Tests and callers that need the auto lookup finished. */
  async whenSettled(sessionId: string): Promise<EvaluateSession> {
    const record = this.require(sessionId);
    await record.pending;
    return record.session;
  }

  /**
   * A stackable the currency table does not know may still have an exchange
   * id in `/data/static` (keys, fragments, essences). That read is 7-day
   * cached and unpaced, and only ever happens for a currency-kind item whose
   * name is otherwise unresolved.
   */
  private async resolveStaticCurrencyId(name: string): Promise<string | undefined> {
    const fetchStatic = this.options.priceFeed.fetchStatic;
    if (!fetchStatic) return undefined;
    if (!this.staticIds) {
      try {
        const payload = await fetchStatic.call(this.options.priceFeed);
        this.staticIds = staticCurrencyIds(payload);
      } catch (error) {
        this.log("warn", "evaluate static currency ids unavailable", error);
        this.staticIds = new Map();
      }
    }
    return this.staticIds.get(name.trim().toLowerCase());
  }

  private safe<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      this.log("warn", "evaluate read failed", error);
      return fallback;
    }
  }

  /** The 7-day bars from the market-trends cache. Never triggers a fetch. */
  private async attachHistory(record: SessionRecord): Promise<void> {
    try {
      const trends = await this.options.marketTrends.series({ cachedOnly: true });
      const history = historyFor(
        trends.series,
        record.session.item,
        trends.fetchedAt,
        trends.stale,
        this.now(),
      );
      if (history) record.session.history = history;
    } catch (error) {
      this.log("warn", "evaluate history unavailable", error);
    }
  }

  /** Budget + league gate shared by search, more and exchange. */
  private blockedReason(kind: "search" | "fetch"): string | undefined {
    const budget = this.options.priceFeed.tradeBudget();
    if (budget.restrictedUntilIso) {
      const until = new Date(budget.restrictedUntilIso);
      return `trade2 is rate limited until ${until.toLocaleTimeString()} — nothing was sent.`;
    }
    if (kind === "search" && budget.searchesSpare < 1) {
      return "No spare trade2 search right now — try again in a moment.";
    }
    if (kind === "fetch" && budget.fetchesSpare < 1) {
      return "No spare trade2 fetch right now — try again in a moment.";
    }
    if (budget.lookups < 1) return "No spare trade2 lookup right now — try again in a moment.";
    const status = this.options.priceFeed.status();
    if (status.leagueAmbiguous) {
      return "Two current leagues are live — pin one in Tools → Settings → Market data before pricing.";
    }
    if (!status.resolvedLeague) {
      return "No league resolved yet — refresh market prices in Tools → Settings → Market data.";
    }
    return undefined;
  }

  private fail(record: SessionRecord, message: string): EvaluateSession {
    record.session.busy = "idle";
    record.session.error = message;
    return this.announce(record);
  }

  async search(sessionId: string, query: EvaluateQueryState): Promise<EvaluateSession> {
    const record = this.require(sessionId);
    const state = sanitizeQueryState(query, record.session.query);
    record.session.query = state;
    record.session.error = undefined;
    const blocked = this.blockedReason("search");
    if (blocked) return this.fail(record, blocked);

    const tradeQuery = queryStateToTradeQuery(state);
    const body = toTradeSearchBody(tradeQuery);
    record.lastBody = body;
    record.session.busy = "searching";
    this.announce(record);

    const reason = `evaluate:${sessionId}`;
    try {
      const search = await this.options.priceFeed.tradeSearch(body, { reason, cacheTtlMs: SESSION_REUSE_MS });
      record.searchId = search.id;
      record.league = search.league;
      const now = this.now();
      if (search.complexityError) {
        record.remainingIds = [];
        record.session.busy = "idle";
        record.session.results = {
          searchId: search.id,
          url: search.url,
          queryUrl: tradeQueryUrl(search.league, body),
          league: search.league,
          total: search.total,
          fetched: 0,
          remainingIds: 0,
          rows: [],
          estimate: this.emptyEstimate(record, now),
          cached: search.cached,
          fetchedAt: now.toISOString(),
          complexityError:
            complexityHint(tradeQuery) ??
            "trade2 refused this query as too complex — untick a filter, or add a POESESSID in Tools → Settings → Market data.",
        };
        return this.announce(record);
      }
      const pageSize = this.options.settings().pageSize;
      const ids = search.resultIds.slice(0, pageSize);
      record.remainingIds = search.resultIds.slice(pageSize);
      record.session.busy = "fetching";
      this.announce(record);
      const listings = ids.length > 0 ? await this.options.priceFeed.tradeFetch(ids, search.id, { reason }) : [];
      const rows = listings.map((listing) => listingRow(listing, now.getTime(), record.priceTable));
      record.session.busy = "idle";
      record.session.results = {
        searchId: search.id,
        url: search.url,
        queryUrl: tradeQueryUrl(search.league, body),
        league: search.league,
        total: search.total,
        fetched: rows.length,
        remainingIds: record.remainingIds.length,
        rows,
        estimate: estimateFor({
          parsed: record.parsed,
          listings,
          basis: this.basisFor(record, state),
          ...(record.priceTable ? { priceTable: record.priceTable } : {}),
          ...(record.verdict ? { verdict: record.verdict } : {}),
          now,
        }),
        cached: search.cached,
        fetchedAt: now.toISOString(),
      };
      return this.announce(record);
    } catch (error) {
      this.log("warn", "evaluate search failed", error);
      return this.fail(record, error instanceof Error ? error.message : "The trade2 search failed.");
    }
  }

  private basisFor(record: SessionRecord, state: EvaluateQueryState): "stat-filtered" | "base-type" | "unique-name" {
    if (state.rows.some((row) => row.enabled && row.kind !== "property")) return "stat-filtered";
    return record.session.item.kind === "unique" ? "unique-name" : "base-type";
  }

  /** A band with no listings behind it (complexity refusal): provider says so. */
  private emptyEstimate(record: SessionRecord, now: Date): EvaluateEstimate {
    return estimateFor({
      parsed: record.parsed,
      listings: [],
      basis: this.basisFor(record, record.session.query),
      ...(record.priceTable ? { priceTable: record.priceTable } : {}),
      ...(record.verdict ? { verdict: record.verdict } : {}),
      now,
    });
  }

  /** One more page of the SAME search: one fetch, never a new search. */
  async more(sessionId: string): Promise<EvaluateSession> {
    const record = this.require(sessionId);
    record.session.error = undefined;
    if (!record.searchId || record.remainingIds.length === 0 || !record.session.results) {
      return this.fail(record, "Nothing left to load for this search.");
    }
    const blocked = this.blockedReason("fetch");
    if (blocked) return this.fail(record, blocked);
    const pageSize = this.options.settings().pageSize;
    const ids = record.remainingIds.slice(0, pageSize);
    record.session.busy = "fetching";
    this.announce(record);
    try {
      const listings = await this.options.priceFeed.tradeFetch(ids, record.searchId, {
        reason: `evaluate:${sessionId}`,
      });
      record.remainingIds = record.remainingIds.slice(ids.length);
      const now = this.now();
      const rows = listings.map((listing) => listingRow(listing, now.getTime(), record.priceTable));
      const results = record.session.results;
      results.rows = [...results.rows, ...rows];
      results.fetched = results.rows.length;
      results.remainingIds = record.remainingIds.length;
      results.fetchedAt = now.toISOString();
      record.session.busy = "idle";
      return this.announce(record);
    } catch (error) {
      this.log("warn", "evaluate paging failed", error);
      return this.fail(record, error instanceof Error ? error.message : "The trade2 fetch failed.");
    }
  }

  /**
   * Bulk exchange for a stackable. `tradeExchange` spends a SEARCH slot (the
   * same pacer policy), so the gate is the search gate.
   */
  async exchange(sessionId: string): Promise<EvaluateSession> {
    const record = this.require(sessionId);
    record.session.error = undefined;
    const currencyId = record.session.item.currencyId;
    if (!currencyId) {
      return this.fail(
        record,
        "No bulk-exchange id is known for this item — the listings and the feed price are what there is.",
      );
    }
    const blocked = this.blockedReason("search");
    if (blocked) return this.fail(record, blocked);
    // Pricing exalted in exalted says nothing: quote it in divine instead.
    const quoteCurrency = currencyId === "exalted" ? "divine" : "exalted";
    const body = toExchangeBody({ have: [quoteCurrency], want: [currencyId], status: "online" });
    record.session.busy = "exchanging";
    this.announce(record);
    try {
      const result = await this.options.priceFeed.tradeExchange(body, { reason: `evaluate:${sessionId}` });
      const summary = exchangeSummary(result.offers, result.url, this.now(), quoteCurrency);
      const feed = feedPriceExalted(record.session.item, record.priceTable);
      // A cross-check, not a failure: it rides on the exchange summary so the
      // panel can print it as a note instead of a red alert.
      if (
        feed !== undefined &&
        summary.medianAskQuoted !== undefined &&
        quoteCurrency === "exalted" &&
        Math.abs(summary.medianAskQuoted - feed) / Math.max(feed, 0.01) > 0.25
      ) {
        summary.caution = `The exchange median (${summary.medianAskQuoted} ex) and the feed price (${feed} ex) disagree by more than 25 % — both are estimates.`;
      }
      record.session.exchange = summary;
      record.session.busy = "idle";
      return this.announce(record);
    } catch (error) {
      this.log("warn", "evaluate exchange failed", error);
      return this.fail(record, error instanceof Error ? error.message : "The trade2 exchange failed.");
    }
  }

  /** Rebuild the rows for another profile. No network. */
  setProfile(sessionId: string, profile: EvaluateProfileId): EvaluateSession {
    const record = this.require(sessionId);
    const settings = this.options.settings();
    const next = initialQueryState({
      parsed: record.parsed,
      summary: record.session.item,
      advanced: record.advanced,
      ...(record.verdict?.appraisal ? { appraisal: record.verdict.appraisal } : {}),
      ...(record.catalogue ? { catalogue: record.catalogue } : {}),
      // Without these the learned tier badges would vanish on every profile
      // switch and only come back by re-opening the item.
      ...(record.learnedTiers ? { learnedTiers: record.learnedTiers } : {}),
      ...(record.priceTable ? { priceTable: record.priceTable } : {}),
      settings,
      profile: profileOf(profile, settings).id,
    });
    record.session.query = {
      ...next,
      status: record.session.query.status,
      indexed: record.session.query.indexed,
      priceCurrency: record.session.query.priceCurrency,
    };
    record.session.error = undefined;
    return this.announce(record);
  }

  /** Clipboard only. Nothing here is ever typed into the game. */
  copy(
    sessionId: string,
    what: { kind: EvaluateCopyKind; listingId?: string },
  ): { ok: boolean; text?: string; error?: string } {
    const record = this.require(sessionId);
    const row = what.listingId
      ? record.session.results?.rows.find((entry) => entry.id === what.listingId)
      : undefined;
    let text: string | undefined;
    switch (what.kind) {
      case "note":
        text = row?.stashNote;
        break;
      case "b/o":
        text = row?.buyoutNote;
        break;
      case "whisper":
        text = row?.whisper;
        break;
      case "item":
        text = record.raw;
        break;
      case "query-url":
        text = this.queryUrlFor(record);
        break;
      default:
        text = undefined;
    }
    if (!text) return { ok: false, error: "There is nothing to copy for that yet." };
    try {
      this.options.clipboard.writeText(text);
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The clipboard refused the write." };
    }
  }

  private queryUrlFor(record: SessionRecord): string {
    const body = record.lastBody ?? toTradeSearchBody(queryStateToTradeQuery(record.session.query));
    const league = record.league ?? this.options.priceFeed.status().resolvedLeague ?? "";
    return tradeQueryUrl(league, body);
  }

  /** Opens the trade site in the user's browser. Always a click, never automatic. */
  async openSite(sessionId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const record = this.require(sessionId);
    const url = record.session.results?.url ?? this.queryUrlFor(record);
    if (!url) return { ok: false, error: "There is no search to open yet." };
    try {
      await this.options.openExternal(url);
      return { ok: true, url };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The browser could not be opened." };
    }
  }

  /** Hands the item to the existing Deals watchlist. */
  watch(sessionId: string): { ok: boolean; watchId?: string; error?: string } {
    const record = this.require(sessionId);
    const item = record.session.item;
    try {
      const watch: Watch = watchForItem(
        {
          name: item.name,
          baseType: item.baseType,
          rarity: item.rarity,
          itemClass: item.itemClass,
          ...(item.itemLevel !== undefined ? { itemLevel: item.itemLevel } : {}),
        },
        record.verdict?.appraisal ? { mods: record.verdict.appraisal.mods } : undefined,
      );
      if (!watch.query.itemClass && tradeCategoryForClass(item.itemClass)) {
        watch.query.itemClass = item.itemClass;
      }
      const overview = this.options.watchlist.overview();
      this.options.watchlist.save({ watches: [...overview.watches, watch] });
      return { ok: true, watchId: watch.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The watch could not be saved." };
    }
  }

  /** The panel closed; the session stays for the Item log section. */
  close(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.session.busy = "idle";
    this.announce(record);
  }

  dispose(): void {
    this.disposed = true;
    this.records.clear();
    this.order = [];
    this.currentId = undefined;
  }
}
