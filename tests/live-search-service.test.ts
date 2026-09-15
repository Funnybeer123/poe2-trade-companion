import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeListing } from "../src/core/tradeListings.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createLiveSearchModule } from "../src/main/features/liveSearch/index.js";
import {
  createLiveSearchService,
  newIdsOf,
  reconnectDelayMs,
  type LiveSearchBudget,
  type LiveSearchFeed,
  type LiveSearchHandle,
  type LiveSocket,
} from "../src/main/liveSearchService.js";
import { TradeRateLimitedError } from "../src/main/priceFeedService.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { normalizeLiveSearchSettings } from "../src/shared/liveSearch.js";

type Listener = (...args: any[]) => void;

class FakeSocket implements LiveSocket {
  readonly listeners = new Map<string, Listener[]>();
  closed: Array<{ code?: number; reason?: string }> = [];
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }
}

function listing(id: string): TradeListing {
  return {
    id,
    league: "Runes of Aldur",
    seller: { account: "s" },
    listingType: "whisper",
    item: {
      typeLine: "Ruby Ring",
      rarity: "Rare",
      identified: true,
      properties: [],
      requirements: [],
      implicitMods: [],
      explicitMods: [],
      enchantMods: [],
      runeMods: [],
      desecratedMods: [],
      fracturedMods: [],
    },
  };
}

function harness(
  options: {
    session?: boolean;
    maxOpen?: number;
    batchWindowMs?: number;
    minSpareFetches?: number;
    budget?: boolean;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const fetchCalls: Array<{ ids: string[]; queryId: string; reason: string }> = [];
  let failFetch: string | undefined;
  let failWith: Error | undefined;
  let budget: LiveSearchBudget = { fetchesSpare: 9 };
  const feed: LiveSearchFeed = {
    hasSession: () => options.session !== false,
    tradeHeaders: () => ({ "User-Agent": "poe2-trade-companion/0.1 (local desktop tool)", Cookie: "POESESSID=abc" }),
    tradeFetch: async (ids, queryId, opts) => {
      fetchCalls.push({ ids: [...ids], queryId, reason: opts.reason });
      if (failWith) throw failWith;
      if (failFetch) throw new Error(failFetch);
      return ids.map(listing);
    },
  };
  const service = createLiveSearchService({
    feed,
    createSocket: (url, opts) => {
      const socket = new FakeSocket(url, opts.headers);
      sockets.push(socket);
      return socket;
    },
    ...(options.maxOpen !== undefined ? { maxOpen: options.maxOpen } : {}),
    ...(options.budget ? { budget: () => budget } : {}),
    ...(options.minSpareFetches !== undefined ? { minSpareFetches: options.minSpareFetches } : {}),
    batchWindowMs: options.batchWindowMs ?? 100,
    now: () => new Date("2026-09-11T12:00:00.000Z"),
  });
  const states: LiveSearchHandle[] = [];
  const listings: TradeListing[] = [];
  const handlers = {
    onListing: (entry: TradeListing) => listings.push(entry),
    onState: (handle: LiveSearchHandle) => states.push(handle),
  };
  return {
    service,
    sockets,
    fetchCalls,
    states,
    listings,
    handlers,
    setFailFetch: (message: string | undefined) => {
      failFetch = message;
    },
    setFailWith: (error: Error | undefined) => {
      failWith = error;
    },
    setBudget: (next: LiveSearchBudget) => {
      budget = next;
    },
  };
}

/** Let the queued microtasks (the async connect) run under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LiveSearchService", () => {
  it("connects with the session cookie and user agent, batches new ids into paced fetches, and reports state", async () => {
    const h = harness();
    const handle = h.service.start({ searchId: "abc123", league: "Runes of Aldur", label: "Rings" }, h.handlers);
    expect(handle).toEqual({ id: "ls-1", searchId: "abc123", league: "Runes of Aldur", label: "Rings", state: "connecting", resultsSeen: 0 });
    await flush();
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    expect(socket.url).toBe("wss://www.pathofexile.com/api/trade2/live/poe2/Runes%20of%20Aldur/abc123");
    expect(socket.headers).toEqual({
      "User-Agent": "poe2-trade-companion/0.1 (local desktop tool)",
      Cookie: "POESESSID=abc",
      Origin: "https://www.pathofexile.com",
    });

    socket.emit("open");
    expect(h.service.list()[0]).toMatchObject({ state: "open", openedAt: "2026-09-11T12:00:00.000Z" });
    expect(h.states.map((state) => state.state)).toEqual(["connecting", "open"]);

    // Twelve ids across two messages inside the window → one fetch of ten, then one of two.
    socket.emit("message", Buffer.from(JSON.stringify({ new: ["a", "b", "c", "d", "e", "f"] })));
    socket.emit("message", JSON.stringify({ new: ["g", "h", "i", "j", "k", "l", "a"] }));
    socket.emit("message", "not json");
    socket.emit("message", JSON.stringify({ other: true }));
    expect(h.fetchCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls.map((call) => call.ids)).toEqual([
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      ["k", "l"],
    ]);
    expect(h.fetchCalls[0]).toMatchObject({ queryId: "abc123", reason: "live search Rings" });
    expect(h.listings.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]);
    expect(h.service.list()[0]!.resultsSeen).toBe(12);
    expect(h.service.capacity()).toEqual({ open: 1, max: 20 });

    h.service.stop("ls-1");
    expect(socket.closed).toEqual([{ code: 1000, reason: "stopped" }]);
    expect(h.service.list()).toEqual([]);
    expect(h.states.at(-1)).toMatchObject({ id: "ls-1", state: "closed" });
    // Events from the closed socket are ignored.
    socket.emit("close", 1006);
    expect(h.service.list()).toEqual([]);
  });

  it("needs a session: no socket without a cookie, and an auth refusal ends the search", async () => {
    const noCookie = harness({ session: false });
    const handle = noCookie.service.start({ searchId: "s", league: "L", label: "" }, noCookie.handlers);
    expect(handle.state).toBe("needs-session");
    expect(handle.label).toBe("s");
    expect(handle.error).toContain("POESESSID");
    await flush();
    expect(noCookie.sockets).toHaveLength(0);
    expect(noCookie.service.capacity().open).toBe(1);

    const refused = harness();
    refused.service.start({ searchId: "s", league: "L", label: "x" }, refused.handlers);
    await flush();
    refused.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    expect(refused.service.list()[0]).toMatchObject({ state: "needs-session" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refused.sockets).toHaveLength(1); // no reconnect loop against a dead session

    const authFalse = harness();
    authFalse.service.start({ searchId: "s", league: "L", label: "x" }, authFalse.handlers);
    await flush();
    authFalse.sockets[0]!.emit("open");
    authFalse.sockets[0]!.emit("message", JSON.stringify({ auth: false }));
    expect(authFalse.service.list()[0]).toMatchObject({ state: "needs-session" });
    expect(authFalse.sockets[0]!.closed).toHaveLength(1);
  });

  it("reconnects with exponential backoff up to five minutes and resets after a good connection", async () => {
    expect([1, 2, 3, 4, 10, 30].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 300_000, 300_000]);
    const h = harness();
    h.service.start({ searchId: "s", league: "L", label: "x" }, h.handlers);
    await flush();
    h.sockets[0]!.emit("error", new Error("socket hang up"));
    h.sockets[0]!.emit("close", 1006);
    expect(h.service.list()[0]).toMatchObject({ state: "error", error: "socket hang up" });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.service.list()[0]!.state).toBe("connecting");
    h.sockets[1]!.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.sockets).toHaveLength(3);
    h.sockets[2]!.emit("open");
    expect(h.service.list()[0]).toMatchObject({ state: "open" });
    expect(h.service.list()[0]!.error).toBeUndefined();
    // After an open the next drop starts over at one second.
    h.sockets[2]!.emit("close", 1001);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(h.sockets).toHaveLength(4);
    // Stopping mid-backoff cancels the reconnect.
    h.sockets[3]!.emit("close", 1006);
    h.service.stop("ls-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(4);
  });

  it("caps simultaneous searches at maxOpen (never above 20) and frees slots on stop", async () => {
    const h = harness({ maxOpen: 2 });
    h.service.start({ searchId: "a", league: "L", label: "a" }, h.handlers);
    h.service.start({ searchId: "b", league: "L", label: "b" }, h.handlers);
    expect(() => h.service.start({ searchId: "c", league: "L", label: "c" }, h.handlers)).toThrow(/capacity reached \(2\)/);
    expect(h.service.capacity()).toEqual({ open: 2, max: 2 });
    h.service.stop("ls-1");
    expect(h.service.start({ searchId: "c", league: "L", label: "c" }, h.handlers).id).toBe("ls-3");
    h.service.setMaxOpen(99);
    expect(h.service.capacity().max).toBe(20);
    expect(() => h.service.start({ searchId: "", league: "L", label: "c" }, h.handlers)).toThrow(/search id/);
  });

  it("keeps the socket open when a fetch fails, drops those ids, and disposes every socket", async () => {
    const h = harness();
    const seen: LiveSearchHandle[][] = [];
    h.service.onChange((handles) => seen.push(handles));
    h.service.start({ searchId: "a", league: "L", label: "a" }, h.handlers);
    h.service.start({ searchId: "b", league: "L", label: "b" }, h.handlers);
    await flush();
    h.sockets[0]!.emit("open");
    h.setFailFetch("trade2 rate limited until 12:10");
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["x"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.listings).toEqual([]);
    expect(h.service.list()[0]).toMatchObject({ state: "open", error: "trade2 rate limited until 12:10", resultsSeen: 0 });
    h.setFailFetch(undefined);
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["y"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls.map((call) => call.ids)).toEqual([["x"], ["y"]]);
    expect(h.service.list()[0]).toMatchObject({ state: "open", resultsSeen: 1 });
    expect(h.service.list()[0]!.error).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.map((handle) => handle.id)).toEqual(["ls-1", "ls-2"]);

    h.service.dispose();
    expect(h.sockets.map((socket) => socket.closed.length)).toEqual([1, 1]);
    expect(h.service.list()).toEqual([]);
    expect(() => h.service.start({ searchId: "z", league: "L", label: "z" }, h.handlers)).toThrow(/disposed/);
  });

  it("skips a fetch batch while the trade2 budget is thin, counts those ids, and never retries them", async () => {
    const h = harness({ budget: true });
    h.service.start({ searchId: "a", league: "L", label: "Rings" }, h.handlers);
    await flush();
    h.sockets[0]!.emit("open");

    // Under the default two-slot margin: nothing goes out.
    h.setBudget({ fetchesSpare: 1 });
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["x", "y", "z"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls).toEqual([]);
    expect(h.listings).toEqual([]);
    expect(h.service.list()[0]).toMatchObject({ state: "open", skippedResults: 3, resultsSeen: 0 });
    expect(h.service.list()[0]!.error).toBe("trade2 fetch budget low (1 spare) — 3 results not fetched");

    // A penalty window is a skip too, and the counter accumulates.
    h.setBudget({ fetchesSpare: 9, restrictedUntilIso: "2026-09-11T12:10:00.000Z" });
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["p"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls).toEqual([]);
    expect(h.service.list()[0]!.skippedResults).toBe(4);
    expect(h.service.list()[0]!.error).toContain("1 result not fetched");

    // Budget back: only NEW ids are fetched — the skipped ones are gone.
    h.setBudget({ fetchesSpare: 9 });
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["q"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(h.fetchCalls.map((call) => call.ids)).toEqual([["q"]]);
    expect(h.service.list()[0]).toMatchObject({ state: "open", resultsSeen: 1, skippedResults: 4 });
    expect(h.service.list()[0]!.error).toBeUndefined();
  });

  it("takes the margin from minSpareFetches and reports no budget at all as unlimited", async () => {
    const lenient = harness({ budget: true, minSpareFetches: 0 });
    lenient.service.start({ searchId: "a", league: "L", label: "a" }, lenient.handlers);
    await flush();
    lenient.sockets[0]!.emit("open");
    lenient.setBudget({ fetchesSpare: 1 });
    lenient.sockets[0]!.emit("message", JSON.stringify({ new: ["x"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(lenient.fetchCalls.map((call) => call.ids)).toEqual([["x"]]);
    expect(lenient.service.list()[0]!.skippedResults).toBeUndefined();

    // No budget function wired at all (the default): nothing is ever skipped.
    const unlimited = harness();
    unlimited.service.start({ searchId: "a", league: "L", label: "a" }, unlimited.handlers);
    await flush();
    unlimited.sockets[0]!.emit("open");
    unlimited.sockets[0]!.emit("message", JSON.stringify({ new: ["x"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(unlimited.fetchCalls.map((call) => call.ids)).toEqual([["x"]]);
    expect(unlimited.service.list()[0]!.skippedResults).toBeUndefined();
  });

  it("stops every live search on a trade2 rate-limit error and does not reconnect", async () => {
    const h = harness({ budget: true });
    h.service.start({ searchId: "a", league: "L", label: "a" }, h.handlers);
    h.service.start({ searchId: "b", league: "L", label: "b" }, h.handlers);
    await flush();
    h.sockets[0]!.emit("open");
    h.sockets[1]!.emit("open");
    h.setFailWith(
      new TradeRateLimitedError("trade2 rate limit hit — wait a minute and try again.", "2026-09-11T12:10:00.000Z"),
    );
    h.sockets[0]!.emit("message", JSON.stringify({ new: ["x", "y"] }));
    h.sockets[1]!.emit("message", JSON.stringify({ new: ["z"] }));
    await vi.advanceTimersByTimeAsync(100);
    await flush();

    // One batch went out; the penalty stopped everything before the rest.
    expect(h.fetchCalls).toHaveLength(1);
    const penalty = new Date("2026-09-11T12:10:00.000Z").toLocaleTimeString();
    for (const handle of h.service.list()) {
      expect(handle.state).toBe("error");
      expect(handle.error).toBe(`trade2 rate limited until ${penalty} — live searches stopped`);
    }
    expect(h.sockets.map((socket) => socket.closed.length)).toEqual([1, 1]);
    // No reconnect storm, and no further fetching whatever the sockets say.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.fetchCalls).toHaveLength(1);
    // The handles stay listed so the user sees why and can restart them.
    expect(h.service.list().map((handle) => handle.id)).toEqual(["ls-1", "ls-2"]);
    h.service.stop("ls-1");
    expect(h.service.capacity()).toEqual({ open: 1, max: 20 });
  });

  it("parses the wire message shape defensively", () => {
    expect(newIdsOf(JSON.stringify({ new: ["a", "", 3, "b"] }))).toEqual(["a", "b"]);
    expect(newIdsOf(Buffer.from('{"new":["c"]}'))).toEqual(["c"]);
    expect(newIdsOf("{")).toEqual([]);
    expect(newIdsOf("null")).toEqual([]);
    expect(newIdsOf(undefined)).toEqual([]);
  });
});

describe("live-search settings", () => {
  it("sanitizes maxOpen into 1–20 and sound into a boolean", () => {
    expect(normalizeLiveSearchSettings(undefined)).toEqual({ value: { maxOpen: 20, sound: true }, issues: [] });
    expect(normalizeLiveSearchSettings({ maxOpen: 50, sound: "yes" })).toEqual({
      value: { maxOpen: 20, sound: true },
      issues: ["maxOpen clamped to 20", "sound is not a boolean; default kept"],
    });
    expect(normalizeLiveSearchSettings({ maxOpen: 0, sound: false }).value).toEqual({ maxOpen: 1, sound: false });
    expect(normalizeLiveSearchSettings({ maxOpen: "7.9" }).value.maxOpen).toBe(7);
    expect(normalizeLiveSearchSettings({ maxOpen: "abc" }).issues).toEqual(["maxOpen is not a number; default kept"]);
  });
});

describe("liveSearch feature module", () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    };
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    };
    return { ipc, invoke };
  }

  it("registers the channels, publishes the service, honours the settings cap, and emits state", async () => {
    const { ipc, invoke } = fakeIpc();
    const files = new Map<string, string>();
    const settings = new SettingsStore({
      file: "s.json",
      fs: { read: (file) => files.get(file), write: (file, text) => void files.set(file, text) },
    });
    const sent: Array<[string, unknown]> = [];
    const main = {
      isDestroyed: () => false,
      once: () => undefined,
      webContents: { send: (channel: string, payload: unknown) => void sent.push([channel, payload]) },
    };
    const sockets: FakeSocket[] = [];
    const feed: LiveSearchFeed = {
      hasSession: () => true,
      tradeHeaders: () => ({ "User-Agent": "ua", Cookie: "POESESSID=x" }),
      tradeFetch: async (ids) => ids.map(listing),
    };
    const rt = createFeatureRuntime({
      ipcMain: ipc,
      configDir: "C:/cfg",
      userDataDir: "C:/user",
      repoRoot: "C:/repo",
      buildMode: "public-companion",
      core: { priceFeed: feed } as never,
      settings,
      mainWindow: () => main as never,
      poeWindows: async () => [],
      killSwitchLatched: () => false,
      notify: () => undefined,
      clipboard: { readText: () => "", writeText: () => undefined },
      openExternal: async () => undefined,
      log: () => undefined,
    });
    const result = await rt.register([
      createLiveSearchModule({
        createSocket: (url, opts) => {
          const socket = new FakeSocket(url, opts.headers);
          sockets.push(socket);
          return socket;
        },
      }),
    ]);
    expect(result.failed).toEqual([]);
    expect(rt.ctx.channels()).toEqual(expect.arrayContaining(["live-search:list", "live-search:stop", "live-search:capacity"]));
    expect(await invoke("live-search:capacity")).toEqual({ open: 0, max: 20 });
    expect(await invoke("settings:get")).toEqual({ "live-search": { maxOpen: 20, sound: true } });

    await invoke("settings:set", "live-search", { maxOpen: 1 });
    const service = rt.ctx.require("liveSearch");
    const handlers = { onListing: () => undefined, onState: () => undefined };
    service.start({ searchId: "abc", league: "Standard", label: "one" }, handlers);
    expect(() => service.start({ searchId: "def", league: "Standard", label: "two" }, handlers)).toThrow(/capacity/);
    expect(await invoke("live-search:list")).toEqual([
      { id: "ls-1", searchId: "abc", league: "Standard", label: "one", state: "connecting", resultsSeen: 0 },
    ]);
    expect(sent.some(([channel, payload]) => channel === "live-search:state" && Array.isArray(payload))).toBe(true);
    await flush();
    expect(sockets).toHaveLength(1);
    expect(await invoke("live-search:stop", "ls-1")).toEqual([]);
    expect(sockets[0]!.closed).toHaveLength(1);

    service.start({ searchId: "ghi", league: "Standard", label: "three" }, handlers);
    await flush();
    await rt.dispose();
    expect(sockets[1]!.closed).toHaveLength(1);
    expect(service.list()).toEqual([]);
  });
});
