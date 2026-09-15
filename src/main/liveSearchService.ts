/**
 * Live search over the trade2 websocket:
 *   wss://www.pathofexile.com/api/trade2/live/poe2/<league>/<searchId>
 *
 * The socket only announces NEW listing ids (`{ "new": ["id", …] }`); the
 * rows themselves come from the ordinary paced fetch (PriceFeedService
 * .tradeFetch, ≤ 10 ids per GET), so a busy search can never outrun the
 * rate limits — ids are coalesced for a short window and drained one batch
 * at a time. A session cookie is mandatory (the endpoint answers 401/403
 * without one → state "needs-session"); at most twenty sockets are open
 * at once (the site's own cap); drops reconnect with exponential backoff
 * up to five minutes; dispose closes everything.
 *
 * The WebSocket constructor is injected so tests never open a socket.
 */
import type { TradeListing } from "../core/tradeListings.js";
import type { LiveSearchHandle } from "../shared/liveSearch.js";
import { LIVE_SEARCH_MAX_OPEN } from "../shared/liveSearch.js";

export type { LiveSearchHandle } from "../shared/liveSearch.js";

const LIVE_BASE = "wss://www.pathofexile.com/api/trade2/live/poe2";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** Ids announced within this window go out in one fetch. */
const DEFAULT_BATCH_WINDOW_MS = 750;
const FETCH_BATCH = 10;
/**
 * Fetch-policy slots that must stay spare for everything else (Evaluate,
 * Deals, Market, the shop CLI). Twenty sockets on a busy query would
 * otherwise spend the whole five-minute budget while the user is away and
 * earn a 600 s lockout for the entire app (compliance review 0.4).
 */
const DEFAULT_MIN_SPARE_FETCHES = 2;

/** What the guard needs from PriceFeedService.tradeBudget(). */
export interface LiveSearchBudget {
  fetchesSpare: number;
  restrictedUntilIso?: string;
}

/**
 * A TradeRateLimitedError without importing PriceFeedService: the class
 * sets `name` in its constructor, and the service must stay drivable by the
 * structural `LiveSearchFeed` fake the tests inject.
 */
function rateLimitPenalty(error: unknown): { restrictedUntilIso?: string } | undefined {
  if (!(error instanceof Error) || error.name !== "TradeRateLimitedError") return undefined;
  const until = (error as { restrictedUntilIso?: unknown }).restrictedUntilIso;
  return typeof until === "string" && until ? { restrictedUntilIso: until } : {};
}

/** The slice of `ws` (or a fake) the service drives. */
export interface LiveSocket {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number, reason?: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type LiveSocketFactory = (url: string, options: { headers: Record<string, string> }) => LiveSocket;

/** What the service needs from PriceFeedService (structural, for tests). */
export interface LiveSearchFeed {
  hasSession(): boolean;
  tradeHeaders(): Record<string, string>;
  tradeFetch(ids: string[], queryId: string, opts: { reason: string }): Promise<TradeListing[]>;
}

export interface LiveSearchHandlers {
  onListing(listing: TradeListing): void;
  onState(handle: LiveSearchHandle): void;
}

export interface LiveSearchStartInput {
  searchId: string;
  league: string;
  label: string;
}

export interface LiveSearchService {
  start(input: LiveSearchStartInput, handlers: LiveSearchHandlers): LiveSearchHandle;
  stop(id: string): void;
  list(): LiveSearchHandle[];
  /** max ≤ 20 */
  capacity(): { open: number; max: number };
}

export interface LiveSearchServiceOptions {
  feed: LiveSearchFeed;
  /** Defaults to `ws`, loaded lazily on the first connection. */
  createSocket?: LiveSocketFactory;
  /** 1–20; default 20. */
  maxOpen?: number;
  now?: () => Date;
  batchWindowMs?: number;
  /**
   * The trade2 budget, checked before every fetch batch. Wire it to
   * `priceFeed.tradeBudget()`. The default reports an unlimited budget, so
   * a service constructed without it behaves exactly as before.
   */
  budget?: () => LiveSearchBudget;
  /** Fetch slots kept spare for the rest of the app (default 2). */
  minSpareFetches?: number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

interface Entry {
  handle: LiveSearchHandle;
  handlers: LiveSearchHandlers;
  socket: LiveSocket | undefined;
  /** The socket generation, so a stale socket's events are ignored. */
  generation: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  attempts: number;
  stopped: boolean;
  pending: string[];
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  draining: boolean;
}

async function defaultSocketFactory(): Promise<LiveSocketFactory> {
  const mod = await import("ws");
  const Ctor = (mod.default ?? (mod as unknown as { WebSocket: typeof mod.default }).WebSocket) as typeof mod.default;
  return (url, options) => new Ctor(url, { headers: options.headers }) as unknown as LiveSocket;
}

export function liveSearchUrl(league: string, searchId: string): string {
  return `${LIVE_BASE}/${encodeURIComponent(league)}/${encodeURIComponent(searchId)}`;
}

/** Backoff for the n-th consecutive failed attempt (1-based): 1 s, 2 s, 4 s … 5 min. */
export function reconnectDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
}

/** `{ "new": ["id", …] }` → the ids; anything else → []. */
export function newIdsOf(data: unknown): string[] {
  let payload: unknown = data;
  if (typeof data !== "string") {
    try {
      payload = String(data);
    } catch {
      return [];
    }
  }
  if (typeof payload !== "string" || !payload.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  const list = (parsed as { new?: unknown } | null)?.new;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** `{ "auth": false }` — the server refused the session. */
function authRefused(data: unknown): boolean {
  try {
    const parsed = JSON.parse(String(data)) as { auth?: unknown } | null;
    return parsed?.auth === false;
  } catch {
    return false;
  }
}

export class LiveSearchServiceImpl implements LiveSearchService {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(handles: LiveSearchHandle[]) => void>();
  private maxOpen: number;
  private counter = 0;
  private factory: LiveSocketFactory | undefined;
  private disposed = false;

  constructor(private readonly options: LiveSearchServiceOptions) {
    this.maxOpen = clampMax(options.maxOpen);
    this.factory = options.createSocket;
  }

  /** Lower/raise the cap (settings); running searches above a lowered cap keep running. */
  setMaxOpen(maxOpen: number): void {
    this.maxOpen = clampMax(maxOpen);
  }

  /** Called with the full list after every state change. */
  onChange(listener: (handles: LiveSearchHandle[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private log(level: "info" | "warn" | "error", message: string, detail?: unknown): void {
    this.options.log?.(level, message, detail);
  }

  capacity(): { open: number; max: number } {
    return { open: this.entries.size, max: this.maxOpen };
  }

  list(): LiveSearchHandle[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.handle }));
  }

  start(input: LiveSearchStartInput, handlers: LiveSearchHandlers): LiveSearchHandle {
    if (this.disposed) throw new Error("live search service is disposed");
    const searchId = input.searchId.trim();
    const league = input.league.trim();
    if (!searchId || !league) throw new Error("live search needs a search id and a league");
    if (this.entries.size >= this.maxOpen) {
      throw new Error(`live search capacity reached (${this.maxOpen}) — stop one first`);
    }
    this.counter += 1;
    const id = `ls-${this.counter}`;
    const entry: Entry = {
      handle: {
        id,
        searchId,
        league,
        label: input.label.trim() || searchId,
        state: "connecting",
        resultsSeen: 0,
      },
      handlers,
      socket: undefined,
      generation: 0,
      reconnectTimer: undefined,
      attempts: 0,
      stopped: false,
      pending: [],
      drainTimer: undefined,
      draining: false,
    };
    this.entries.set(id, entry);
    if (!this.options.feed.hasSession()) {
      this.setState(entry, "needs-session", "a POESESSID is required for live search (Tools → Settings → Market data)");
      return { ...entry.handle };
    }
    this.announce(entry);
    void this.connect(entry);
    return { ...entry.handle };
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.teardown(entry);
    this.entries.delete(id);
    entry.handle.state = "closed";
    this.announce(entry);
  }

  /** Close every socket and forget every search. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) this.teardown(entry);
    this.entries.clear();
    this.listeners.clear();
  }

  private teardown(entry: Entry): void {
    entry.stopped = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    entry.drainTimer = undefined;
    entry.pending = [];
    this.closeSocket(entry);
  }

  private closeSocket(entry: Entry): void {
    const socket = entry.socket;
    entry.socket = undefined;
    entry.generation += 1;
    if (!socket) return;
    try {
      socket.close(1000, "stopped");
    } catch {
      try {
        socket.terminate?.();
      } catch {
        // Already gone.
      }
    }
  }

  private setState(entry: Entry, state: LiveSearchHandle["state"], error?: string): void {
    entry.handle.state = state;
    if (error) entry.handle.error = error;
    else delete entry.handle.error;
    this.announce(entry);
  }

  private announce(entry: Entry): void {
    const snapshot = { ...entry.handle };
    try {
      entry.handlers.onState(snapshot);
    } catch (error) {
      this.log("warn", "live search onState handler threw", error);
    }
    const all = this.list();
    for (const listener of this.listeners) {
      try {
        listener(all);
      } catch (error) {
        this.log("warn", "live search listener threw", error);
      }
    }
  }

  private async connect(entry: Entry): Promise<void> {
    if (entry.stopped || this.disposed) return;
    let factory = this.factory;
    if (!factory) {
      try {
        factory = await defaultSocketFactory();
        this.factory = factory;
      } catch (error) {
        this.setState(entry, "error", `websocket unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (entry.stopped || this.disposed) return;
    entry.generation += 1;
    const generation = entry.generation;
    const url = liveSearchUrl(entry.handle.league, entry.handle.searchId);
    let socket: LiveSocket;
    try {
      socket = factory(url, {
        headers: { ...this.options.feed.tradeHeaders(), Origin: "https://www.pathofexile.com" },
      });
    } catch (error) {
      this.setState(entry, "error", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect(entry);
      return;
    }
    entry.socket = socket;
    if (entry.handle.state !== "connecting") this.setState(entry, "connecting");
    const live = () => entry.generation === generation && !entry.stopped && !this.disposed;

    socket.on("open", () => {
      if (!live()) return;
      entry.attempts = 0;
      entry.handle.openedAt = this.now().toISOString();
      this.setState(entry, "open");
    });
    socket.on("message", (data) => {
      if (!live()) return;
      if (authRefused(data)) {
        this.closeSocket(entry);
        this.setState(entry, "needs-session", "trade2 refused the session cookie — sign in again and update POESESSID");
        return;
      }
      const ids = newIdsOf(data);
      if (ids.length === 0) return;
      for (const id of ids) if (!entry.pending.includes(id)) entry.pending.push(id);
      this.scheduleDrain(entry);
    });
    socket.on("unexpected-response", (_request, response) => {
      if (!live()) return;
      const status = response?.statusCode;
      entry.socket = undefined;
      entry.generation += 1;
      if (status === 401 || status === 403) {
        this.setState(entry, "needs-session", `trade2 answered HTTP ${status} — the POESESSID is missing or expired`);
        return;
      }
      this.setState(entry, "error", `trade2 live search answered HTTP ${status ?? "?"}`);
      this.scheduleReconnect(entry);
    });
    socket.on("error", (error) => {
      if (!live()) return;
      entry.handle.error = error instanceof Error ? error.message : String(error);
      // The close event follows and drives the reconnect.
    });
    socket.on("close", (code) => {
      if (!live()) return;
      entry.socket = undefined;
      entry.generation += 1;
      if (code === 1008 || code === 4401 || code === 4403) {
        this.setState(entry, "needs-session", `trade2 closed the live search (code ${code}) — the session is not accepted`);
        return;
      }
      this.setState(entry, "error", entry.handle.error ?? `live search closed (code ${code})`);
      this.scheduleReconnect(entry);
    });
  }

  private scheduleReconnect(entry: Entry): void {
    if (entry.stopped || this.disposed || entry.reconnectTimer) return;
    entry.attempts += 1;
    const delay = reconnectDelayMs(entry.attempts);
    this.log("info", `live search ${entry.handle.id} reconnects in ${delay} ms (attempt ${entry.attempts})`);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      if (entry.stopped || this.disposed) return;
      this.setState(entry, "connecting");
      void this.connect(entry);
    }, delay);
  }

  private scheduleDrain(entry: Entry): void {
    if (entry.drainTimer || entry.draining || entry.stopped) return;
    entry.drainTimer = setTimeout(() => {
      entry.drainTimer = undefined;
      void this.drain(entry);
    }, this.options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS);
  }

  /**
   * Why this batch must not go out, or undefined when it may. A penalty
   * window or a fetch budget down to the last slots stops live search
   * first: it is the one consumer that spends while nobody is watching.
   */
  private budgetBlock(): string | undefined {
    let budget: LiveSearchBudget;
    try {
      budget = this.options.budget?.() ?? { fetchesSpare: Number.POSITIVE_INFINITY };
    } catch {
      return undefined; // an unreadable budget is not a reason to drop rows
    }
    if (budget.restrictedUntilIso) {
      return `trade2 rate limited until ${new Date(budget.restrictedUntilIso).toLocaleTimeString()}`;
    }
    const min = this.options.minSpareFetches ?? DEFAULT_MIN_SPARE_FETCHES;
    if (typeof budget.fetchesSpare === "number" && budget.fetchesSpare < min) {
      return `trade2 fetch budget low (${Math.max(0, budget.fetchesSpare)} spare)`;
    }
    return undefined;
  }

  /**
   * A trade2 penalty window earned mid-drain stops EVERY live search: the
   * sockets keep announcing ids nobody may fetch, and reconnecting inside
   * the window only extends it. The handles stay listed in state "error"
   * with the penalty time so the user can see why and restart them.
   */
  private haltAll(message: string): void {
    for (const entry of this.entries.values()) {
      if (entry.stopped) continue;
      this.teardown(entry);
      this.setState(entry, "error", message);
    }
  }

  /** Fetch pending ids ten at a time, one batch in flight per search. */
  private async drain(entry: Entry): Promise<void> {
    if (entry.draining) return;
    entry.draining = true;
    try {
      while (entry.pending.length > 0 && !entry.stopped && !this.disposed) {
        const batch = entry.pending.splice(0, FETCH_BATCH);
        const blocked = this.budgetBlock();
        if (blocked) {
          // Dropped, never queued for later: the budget is spent by the
          // whole app, and a backlog would spend it again the moment it
          // frees up. The count is what the UI reports.
          entry.handle.skippedResults = (entry.handle.skippedResults ?? 0) + batch.length;
          entry.handle.error = `${blocked} — ${batch.length} result${batch.length === 1 ? "" : "s"} not fetched`;
          this.log("warn", `live search ${entry.handle.id} skipped ${batch.length} ids: ${blocked}`);
          this.announce(entry);
          continue;
        }
        let listings: TradeListing[];
        try {
          listings = await this.options.feed.tradeFetch(batch, entry.handle.searchId, {
            reason: `live search ${entry.handle.label}`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const penalty = rateLimitPenalty(error);
          if (penalty) {
            const until = penalty.restrictedUntilIso;
            this.log("error", `live search stopped: ${message}`);
            this.haltAll(
              until
                ? `trade2 rate limited until ${new Date(until).toLocaleTimeString()} — live searches stopped`
                : `${message} — live searches stopped`,
            );
            return;
          }
          this.log("warn", `live search ${entry.handle.id} fetch failed: ${message}`);
          // The ids are dropped, not retried: a penalty window must not
          // queue a retry storm. The socket stays open for what comes next.
          entry.handle.error = message;
          this.announce(entry);
          continue;
        }
        if (entry.stopped || this.disposed) return;
        entry.handle.resultsSeen += listings.length;
        if (entry.handle.error) delete entry.handle.error;
        for (const listing of listings) {
          try {
            entry.handlers.onListing(listing);
          } catch (error) {
            this.log("warn", "live search onListing handler threw", error);
          }
        }
        this.announce(entry);
      }
    } finally {
      entry.draining = false;
      if (entry.pending.length > 0 && !entry.stopped) this.scheduleDrain(entry);
    }
  }
}

function clampMax(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return LIVE_SEARCH_MAX_OPEN;
  return Math.min(LIVE_SEARCH_MAX_OPEN, Math.max(1, Math.floor(value)));
}

export function createLiveSearchService(options: LiveSearchServiceOptions): LiveSearchServiceImpl {
  return new LiveSearchServiceImpl(options);
}
