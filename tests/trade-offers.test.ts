import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent, type TradeWhisper } from "../src/core/clientLog.js";
import { untypableChars } from "../src/core/chatCommands.js";
import type { PriceTable } from "../src/core/priceTable.js";
import {
  applyClientLogEvent,
  chatLineForAction,
  describeWhisperPrice,
  detectSecureListing,
  expireOffers,
  fnv1a64Hex,
  itemPlaceholder,
  latestActiveOffer,
  matchAcceptedTrade,
  offerFromWhisper,
  offerIdFor,
  offerPlaceholderContext,
  parseOffersFile,
  serializeOffersFile,
  sortOffers,
  templateTested,
  type TradeReduceContext,
} from "../src/core/tradeOffers.js";
import {
  DEFAULT_TRADE_SETTINGS,
  normalizeTradeSettings,
  validateQuickWhisper,
  type TradeOffer,
  type TradeSettings,
} from "../src/shared/trade.js";

const FIXTURE = readFileSync(path.join(process.cwd(), "fixtures", "trade", "session-en.txt"), "utf8");

const TABLE: PriceTable = {
  schemaVersion: 1,
  currency: "exalted",
  entries: [
    { id: "divine", match: { name: "Divine Orb" }, value: 500 },
    { id: "chaos", match: { name: "Chaos Orb" }, value: 0.5 },
  ],
};

function events(): ClientLogEvent[] {
  return FIXTURE.split(/\r?\n/)
    .map((line) => parseClientLogLine(line, areaInfo))
    .filter((event): event is ClientLogEvent => Boolean(event));
}

/** The first trade whisper the fixture has from (or to) this player. */
function whisperFor(player: string): Extract<ClientLogEvent, { kind: "whisper" }> & { trade: TradeWhisper } {
  const match = events().find(
    (event): event is Extract<ClientLogEvent, { kind: "whisper" }> =>
      event.kind === "whisper" && event.player === player && Boolean(event.trade),
  );
  if (!match?.trade) throw new Error(`no trade whisper for ${player} in the fixture`);
  return match as Extract<ClientLogEvent, { kind: "whisper" }> & { trade: TradeWhisper };
}

function context(overrides: Partial<TradeReduceContext> = {}): TradeReduceContext {
  return {
    now: "2026-09-05T16:50:00.000Z",
    settings: { ...DEFAULT_TRADE_SETTINGS },
    priceTable: TABLE,
    inTown: true,
    ...overrides,
  };
}

describe("trade offer pricing", () => {
  it("composes currency id, exalted value and the fractional split", () => {
    const price = describeWhisperPrice(
      { kind: "item", language: "en", price: { amount: 1.5, currency: "divine" }, league: "L", raw: "" },
      TABLE,
    );
    expect(price.currencyId).toBe("divine");
    expect(price.exalted).toBe(750);
    expect(price.split?.text).toBe("1 div + 250 ex");
    expect(price.text).toBe("1.5 divine");
  });

  it("leaves whole prices alone and reports unknown currencies", () => {
    const whole = describeWhisperPrice(
      { kind: "item", language: "en", price: { amount: 20, currency: "Exalted Orb" }, league: "L", raw: "" },
      TABLE,
    );
    expect(whole.exalted).toBe(20);
    expect(whole.split).toBeUndefined();
    const unknown = describeWhisperPrice(
      { kind: "item", language: "en", price: { amount: 3, currency: "gold" }, league: "L", raw: "" },
      TABLE,
    );
    expect(unknown.currencyId).toBeUndefined();
    expect(unknown.exalted).toBeUndefined();
  });

  it("marks every non-English whisper as an untested template", () => {
    const multilang = readFileSync(
      path.join(process.cwd(), "fixtures", "trade", "whispers-multilang.txt"),
      "utf8",
    )
      .split(/\r?\n/)
      .map((line) => parseClientLogLine(line, areaInfo))
      .filter(
        (event): event is Extract<ClientLogEvent, { kind: "whisper" }> =>
          Boolean(event) && event?.kind === "whisper" && Boolean(event.trade),
      );
    expect(multilang.length).toBeGreaterThan(4);
    for (const event of multilang) {
      const offer = offerFromWhisper(
        event as Extract<ClientLogEvent, { kind: "whisper" }> & { trade: TradeWhisper },
        context(),
      );
      expect(offer.templateTested).toBe(offer.language === "en");
      expect(offer.price.amount).toBeGreaterThan(0);
    }
  });

  it("reads the tested flag from the whisper templates", () => {
    expect(templateTested("en", "item")).toBe(true);
    expect(templateTested("ru", "item")).toBe(false);
    expect(templateTested("xx", "bulk")).toBe(false);
  });
});

describe("offers from whispers", () => {
  it("builds an incoming item offer from the fixture", () => {
    const offer = offerFromWhisper(whisperFor("Buyerino"), context({ resolvedLeague: "Forbidden Rites" }));
    expect(offer.direction).toBe("incoming");
    expect(offer.player).toBe("Buyerino");
    expect(offer.item.display).toBe("Ghoul Lash, Long Belt");
    expect(offer.stash).toEqual({ tab: "~price 1 exalted", left: 10, top: 10 });
    expect(offer.price.exalted).toBe(1);
    expect(offer.secure).toBe("no");
    expect(offer.templateTested).toBe(true);
    expect(offer.leagueMatches).toBe(true);
  });

  it("builds a bulk offer and an outgoing offer, and flags a league mismatch", () => {
    const bulk = offerFromWhisper(whisperFor("Bulkbuyer"), context());
    expect(bulk.kind).toBe("bulk");
    expect(bulk.item.display).toBe("2× Preserved Cranium");
    expect(bulk.price.exalted).toBe(20);

    const outgoing = offerFromWhisper(whisperFor("Sellerino"), context({ resolvedLeague: "Runes of Aldur" }));
    expect(outgoing.direction).toBe("outgoing");
    expect(outgoing.player).toBe("Sellerino");
    expect(outgoing.leagueMatches).toBe(false);
  });

  it("hashes ids stably and per minute", () => {
    expect(fnv1a64Hex("abc")).toBe(fnv1a64Hex("abc"));
    expect(fnv1a64Hex("abc")).not.toBe(fnv1a64Hex("abd"));
    const a = offerIdFor("incoming", "Buyerino", "raw", "2026-09-05T16:37:47.000Z");
    const b = offerIdFor("incoming", "Buyerino", "raw", "2026-09-05T16:37:59.000Z");
    const c = offerIdFor("incoming", "Buyerino", "raw", "2026-09-05T16:38:01.000Z");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("keeps the {item} placeholder ASCII so the host can type it", () => {
    const item = offerFromWhisper(whisperFor("Buyerino"), context());
    expect(itemPlaceholder(item.item, item.kind)).toBe("Ghoul Lash, Long Belt");
    const bulk = offerFromWhisper(whisperFor("Bulkbuyer"), context());
    expect(itemPlaceholder(bulk.item, bulk.kind)).toBe("2 Preserved Cranium");
    expect(untypableChars(String(offerPlaceholderContext(bulk, {}).item))).toEqual([]);
    expect(itemPlaceholder({ name: "Long Belt", baseType: "Long Belt", display: "Long Belt" }, "item")).toBe(
      "Long Belt",
    );
  });

  it("flags a possible secure listing without inventing one", () => {
    expect(
      detectSecureListing({ kind: "item", language: "en", price: { amount: 1, currency: "exalted" }, league: "L", raw: "x" })
        .secure,
    ).toBe("maybe");
    expect(
      detectSecureListing({
        kind: "item",
        language: "en",
        price: { amount: 1, currency: "exalted" },
        league: "L",
        stashTab: "t",
        position: { left: 1, top: 1 },
        raw: "Secure Item purchase",
      }).secure,
    ).toBe("yes");
    expect(
      detectSecureListing({ kind: "bulk", language: "en", price: { amount: 1, currency: "exalted" }, league: "L", raw: "x" })
        .secure,
    ).toBe("no");
  });
});

describe("applyClientLogEvent", () => {
  function play(settings: Partial<TradeSettings> = {}): { offers: TradeOffer[]; history: number; effects: string[] } {
    let offers: TradeOffer[] = [];
    const effects: string[] = [];
    let history = 0;
    const merged = { ...DEFAULT_TRADE_SETTINGS, ...settings };
    for (const event of events()) {
      const ctx = context({ now: event.at, settings: merged, resolvedLeague: "Forbidden Rites" });
      const result = applyClientLogEvent(offers, event, ctx, () => "fixd");
      offers = result.offers;
      for (const effect of result.effects) {
        effects.push(effect.kind);
        if (effect.kind === "history-add") history += 1;
      }
    }
    return { offers, history, effects };
  }

  it("coalesces a repeated whisper instead of making a second card", () => {
    const { offers, effects } = play();
    const buyer = offers.find((offer) => offer.player === "Buyerino");
    expect(buyer?.repeats).toBe(2);
    expect(effects.filter((kind) => kind === "offer-repeat")).toHaveLength(1);
    expect(offers.filter((offer) => offer.player === "Buyerino")).toHaveLength(1);
  });

  it("records the last plain whisper on the card", () => {
    const { offers } = play();
    const buyer = offers.find((offer) => offer.player === "Buyerino");
    expect(buyer?.lastMessage?.text).toBe("ty");
    expect(buyer?.lastMessage?.direction).toBe("in");
  });

  it("completes the incoming trade and the outgoing one, and records both", () => {
    const { offers, history } = play();
    const buyer = offers.find((offer) => offer.player === "Buyerino");
    const seller = offers.find((offer) => offer.player === "Sellerino");
    expect(buyer?.state).toBe("completed");
    expect(seller?.state).toBe("completed");
    expect(history).toBe(2);
  });

  it("never turns global, trade, guild or party chat into an offer", () => {
    const { offers } = play();
    expect(offers.map((offer) => offer.player).sort()).toEqual([
      "Buyerino",
      "Bulkbuyer",
      "Otherguy",
      "Sellerino",
    ].sort());
  });

  it("does nothing at all when the feature is disabled", () => {
    const { offers, effects } = play({ enabled: false });
    expect(offers).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });

  it("records an unmatched Trade accepted for the user to edit", () => {
    const result = applyClientLogEvent(
      [],
      { kind: "trade", at: "2026-09-05T17:00:00.000Z", result: "accepted" },
      context(),
      () => "fixd",
    );
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0];
    expect(effect.kind).toBe("history-add");
    if (effect.kind === "history-add") {
      expect(effect.entry.kind).toBe("unknown");
      expect(effect.entry.item).toEqual({ name: "Unknown trade" });
      expect("display" in effect.entry.item).toBe(false);
    }
  });

  it("leaves history alone when recordUnmatched is off", () => {
    const result = applyClientLogEvent(
      [],
      { kind: "trade", at: "2026-09-05T17:00:00.000Z", result: "accepted" },
      context({ settings: { ...DEFAULT_TRADE_SETTINGS, recordUnmatched: false } }),
    );
    expect(result.effects).toHaveLength(0);
  });

  it("never mints a second card with the id of a card already in the list", () => {
    const whisper = whisperFor("Buyerino");
    const first = applyClientLogEvent([], whisper, context({ now: whisper.at }));
    expect(first.offers).toHaveLength(1);
    // Dismissed, so the repeat branch (active cards only) cannot match it…
    const dismissed = first.offers.map((offer) => ({ ...offer, state: "dismissed" as const }));
    // …and the identical whisper lands in the SAME minute, so the raw hash of
    // the new card is byte-for-byte the id of the dismissed one.
    const repeat = { ...whisper, at: `${whisper.at.slice(0, 17)}59.000Z` };
    const second = applyClientLogEvent(dismissed, repeat, context({ now: repeat.at }));
    expect(second.offers).toHaveLength(2);
    expect(new Set(second.offers.map((offer) => offer.id)).size).toBe(2);
    const created = second.effects[0];
    expect(created.kind).toBe("offer-new");
    if (created.kind === "offer-new") expect(created.offer.id).toBe(second.offers[0].id);
  });

  it("moves a joined buyer back to invited when they leave the area", () => {
    const offer = offerFromWhisper(whisperFor("Buyerino"), context());
    const joined: TradeOffer = { ...offer, state: "joined", stateAt: offer.at };
    const result = applyClientLogEvent(
      [joined],
      { kind: "area-join", at: "2026-09-05T16:45:00.000Z", player: "Buyerino", joined: false },
      context(),
    );
    expect(result.offers[0].state).toBe("invited");
    expect(result.offers[0].transitions.at(-1)).toMatchObject({ via: "area-leave" });
    const effect = result.effects[0];
    expect(effect.kind).toBe("offer-state");
    if (effect.kind === "offer-state") expect(effect.previous).toBe("joined");
  });

  it("marks an outgoing card joined when the seller's party line arrives", () => {
    const offer = offerFromWhisper(whisperFor("Sellerino"), context());
    expect(offer.direction).toBe("outgoing");
    const invited: TradeOffer = { ...offer, state: "invited", stateAt: offer.at };
    const result = applyClientLogEvent(
      [invited],
      { kind: "party", at: "2026-09-05T16:45:00.000Z", player: "Sellerino", action: "joined" },
      context(),
    );
    expect(result.offers[0].state).toBe("joined");
    expect(result.offers[0].transitions.at(-1)).toMatchObject({ via: "party" });
    // A "left" line is not a state change of its own.
    const left = applyClientLogEvent(
      result.offers,
      { kind: "party", at: "2026-09-05T16:46:00.000Z", player: "Sellerino", action: "left" },
      context(),
    );
    expect(left.effects).toHaveLength(0);
  });

  it("walks a trading card back to joined when the trade is cancelled", () => {
    const offer = offerFromWhisper(whisperFor("Buyerino"), context());
    const trading: TradeOffer = { ...offer, state: "trading", stateAt: offer.at };
    const result = applyClientLogEvent(
      [trading],
      { kind: "trade", at: "2026-09-05T16:45:00.000Z", result: "cancelled" },
      context(),
    );
    expect(result.offers[0].state).toBe("joined");
  });
});

describe("matchAcceptedTrade", () => {
  const base = offerFromWhisper(whisperFor("Buyerino"), context());
  const offer = (overrides: Partial<TradeOffer>): TradeOffer => ({ ...base, ...overrides });

  it("prefers the card furthest along the flow", () => {
    const a = offer({ id: "a", state: "joined", stateAt: "2026-09-05T20:51:30.000Z", updatedAt: "2026-09-05T20:51:30.000Z" });
    const b = offer({ id: "b", state: "new", stateAt: "2026-09-05T20:40:00.000Z", updatedAt: "2026-09-05T20:40:00.000Z" });
    const c = offer({
      id: "c",
      direction: "outgoing",
      state: "new",
      stateAt: "2026-09-05T20:52:10.000Z",
      updatedAt: "2026-09-05T20:52:10.000Z",
    });
    expect(matchAcceptedTrade([a, b, c], "2026-09-05T20:52:51.000Z")?.id).toBe("a");
    expect(matchAcceptedTrade([b, c], "2026-09-05T20:52:51.000Z")?.id).toBe("c");
  });

  it("rejects a stale incoming card that never progressed", () => {
    const stale = offer({ id: "s", state: "new", stateAt: "2026-09-05T19:00:00.000Z", updatedAt: "2026-09-05T19:00:00.000Z" });
    expect(matchAcceptedTrade([stale], "2026-09-05T20:52:51.000Z")).toBeUndefined();
  });
});

describe("chatLineForAction", () => {
  const incoming = offerFromWhisper(whisperFor("Buyerino"), context());
  const bulk = offerFromWhisper(whisperFor("Bulkbuyer"), context());
  const outgoing = offerFromWhisper(whisperFor("Sellerino"), context());
  const settings = { ...DEFAULT_TRADE_SETTINGS };

  it("builds exactly one line per action", () => {
    expect(chatLineForAction(incoming, { kind: "invite" }, settings, {})).toMatchObject({
      text: "/invite Buyerino",
      nextState: "invited",
    });
    expect(chatLineForAction(incoming, { kind: "trade" }, settings, {})).toMatchObject({
      text: "/tradewith Buyerino",
      nextState: "trading",
    });
    expect(chatLineForAction(incoming, { kind: "kick" }, settings, {})).toMatchObject({ text: "/kick Buyerino" });
    expect(chatLineForAction(outgoing, { kind: "hideout" }, settings, {})).toMatchObject({
      text: "/hideout Sellerino",
    });
    expect(chatLineForAction(incoming, { kind: "leave" }, settings, { char: "MyChar" })).toMatchObject({
      text: "/kick MyChar",
    });
    expect(chatLineForAction(incoming, { kind: "highlight" }, settings, {})).toMatchObject({
      text: "Ghoul Lash",
      stashSearch: true,
    });
  });

  it("resolves quick whispers with the ASCII item form", () => {
    const line = chatLineForAction(incoming, { kind: "quick-whisper", id: "sold" }, settings, {});
    expect(line).toMatchObject({ text: "@Buyerino Sorry, Ghoul Lash, Long Belt is already sold" });
    const bulkLine = chatLineForAction(bulk, { kind: "quick-whisper", id: "sold" }, settings, {});
    expect(bulkLine).toMatchObject({ text: "@Bulkbuyer Sorry, 2 Preserved Cranium is already sold" });
  });

  it("refuses what it cannot build", () => {
    expect(chatLineForAction(incoming, { kind: "quick-whisper", id: "nope" }, settings, {})).toEqual({
      error: "That quick whisper no longer exists",
    });
    expect(chatLineForAction(outgoing, { kind: "invite" }, settings, {})).toEqual({
      error: "Invite is for buyers; use Hideout",
    });
    expect(chatLineForAction(incoming, { kind: "leave" }, settings, {})).toEqual({
      error: "Your character name is unknown yet (no level-up line seen)",
    });
    expect(chatLineForAction(incoming, { kind: "custom-whisper", text: "   " }, settings, {})).toEqual({
      error: "Type something to whisper first",
    });
  });

  it("trims and caps a custom whisper", () => {
    const line = chatLineForAction(incoming, { kind: "custom-whisper", text: `  ${"a".repeat(300)}  ` }, settings, {});
    expect("text" in line && line.text.length).toBe("@Buyerino ".length + 200);
  });

  it("only offers a quick whisper to the direction it is meant for", () => {
    expect(chatLineForAction(outgoing, { kind: "quick-whisper", id: "sold" }, settings, {})).toEqual({
      error: "That quick whisper is not meant for this offer",
    });
  });
});

describe("quick whisper and settings sanitizers", () => {
  it("refuses templates that would leak into local chat or cannot be typed", () => {
    expect(validateQuickWhisper({ label: "x", template: "hello there" }).issues).toContain(
      "quick whispers must start with @{player} or /",
    );
    expect(validateQuickWhisper({ label: "x", template: "@{player} café" }).issues.join(" ")).toContain(
      "cannot type",
    );
    expect(validateQuickWhisper({ label: "x", template: `@{player} ${"a".repeat(300)}` }).issues.join(" ")).toContain(
      "1–240",
    );
    expect(validateQuickWhisper({ label: "", template: "@{player} hi" }).issues.join(" ")).toContain("label");
    expect(validateQuickWhisper({ label: "x", template: "@{player} {nope}" }).issues.join(" ")).toContain(
      "unknown placeholder",
    );
    expect(validateQuickWhisper({ label: "Hi", template: "/invite {player}" }).value).toMatchObject({
      id: "hi",
      show: "both",
    });
  });

  it("falls back, clamps and dedupes", () => {
    expect(normalizeTradeSettings(42).value).toEqual(DEFAULT_TRADE_SETTINGS);
    expect(normalizeTradeSettings(42).issues.length).toBeGreaterThan(0);
    const clamped = normalizeTradeSettings({
      offerTtlMinutes: 5_000,
      completedLingerMinutes: 0,
      historyRetentionDays: 900,
      showPanelOnOffer: "sometimes",
      panelAnchor: "middle",
    }).value;
    expect(clamped.offerTtlMinutes).toBe(720);
    expect(clamped.completedLingerMinutes).toBe(1);
    expect(clamped.historyRetentionDays).toBe(90);
    expect(clamped.showPanelOnOffer).toBe("always");
    expect(clamped.panelAnchor).toBe("top-right");

    const quick = normalizeTradeSettings({
      quickWhispers: [
        { id: "a", label: "A", template: "@{player} hi" },
        { id: "a", label: "A again", template: "@{player} hi" },
        { label: "bad", template: "no prefix" },
      ],
    });
    expect(quick.value.quickWhispers).toHaveLength(1);
    expect(quick.issues.join(" ")).toContain("duplicate");
    expect(normalizeTradeSettings({ quickWhispers: [] }).value.quickWhispers).toEqual([]);
    expect(normalizeTradeSettings({ notifications: { sound: false } }).value.notifications).toEqual({
      windows: true,
      toast: true,
      sound: false,
      outgoing: false,
    });
  });

  it("never lets a webhook secret into companion-settings.json", () => {
    const result = normalizeTradeSettings({
      webhooks: {
        discord: true,
        discordUrl: "https://discord.com/api/webhooks/1/abc",
        telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz0123456789",
      },
    });
    expect(result.value.webhooks).toEqual({ discord: true, telegram: false, includePlayerName: true });
    expect(result.issues.filter((issue) => issue.includes("never stored"))).toHaveLength(1);
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("webhooks/1/abc");
    expect(serialized).not.toContain("123456:");
  });
});

describe("expiry, ordering and persistence", () => {
  const base = offerFromWhisper(whisperFor("Buyerino"), context());

  it("times an active card out and drops a finished one after the linger window", () => {
    const active: TradeOffer = { ...base, id: "a", updatedAt: "2026-09-05T10:00:00.000Z" };
    const finished: TradeOffer = {
      ...base,
      id: "b",
      state: "completed",
      stateAt: "2026-09-05T05:00:00.000Z",
      updatedAt: "2026-09-05T05:00:00.000Z",
    };
    const result = expireOffers([active, finished], context({ now: "2026-09-05T16:00:00.000Z" }));
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].state).toBe("dismissed");
    expect(result.effects[0].kind).toBe("offer-timeout");
  });

  it("sorts active cards first and honours the inverted order", () => {
    const older: TradeOffer = { ...base, id: "old", at: "2026-09-05T10:00:00.000Z" };
    const newer: TradeOffer = { ...base, id: "new", at: "2026-09-05T12:00:00.000Z" };
    const done: TradeOffer = { ...base, id: "done", state: "completed", at: "2026-09-05T13:00:00.000Z" };
    expect(sortOffers([older, done, newer], false).map((offer) => offer.id)).toEqual(["new", "old", "done"]);
    expect(sortOffers([older, done, newer], true).map((offer) => offer.id)).toEqual(["old", "new", "done"]);
  });

  it("finds the newest active offer for a hotkey", () => {
    const older: TradeOffer = { ...base, id: "old", at: "2026-09-05T10:00:00.000Z" };
    const newer: TradeOffer = { ...base, id: "new", at: "2026-09-05T12:00:00.000Z" };
    expect(latestActiveOffer([older, newer], "incoming", ["new"])?.id).toBe("new");
    expect(latestActiveOffer([older, newer], "outgoing", ["new"])).toBeUndefined();
  });

  it("round-trips the file, drops junk and stamps a restore transition", () => {
    const text = serializeOffersFile([base, { junk: true } as unknown as TradeOffer], "2026-09-05T16:50:00.000Z");
    const restored = parseOffersFile(text, "2026-09-05T16:50:00.000Z", DEFAULT_TRADE_SETTINGS);
    expect(restored).toHaveLength(1);
    expect(restored[0].transitions.at(-1)?.via).toBe("restore");
    expect(parseOffersFile("not json", "2026-09-05T16:50:00.000Z", DEFAULT_TRADE_SETTINGS)).toEqual([]);
    expect(parseOffersFile(undefined, "2026-09-05T16:50:00.000Z", DEFAULT_TRADE_SETTINGS)).toEqual([]);
  });

  it("repairs a file that holds the same id twice, keeping the freshest row", () => {
    const stale: TradeOffer = { ...base, updatedAt: "2026-09-05T16:00:00.000Z", repeats: 1 };
    const fresh: TradeOffer = { ...base, updatedAt: "2026-09-05T16:40:00.000Z", repeats: 4 };
    const text = serializeOffersFile([stale, fresh], "2026-09-05T16:50:00.000Z");
    const restored = parseOffersFile(text, "2026-09-05T16:50:00.000Z", DEFAULT_TRADE_SETTINGS);
    expect(restored).toHaveLength(1);
    expect(restored[0].repeats).toBe(4);
  });

  it("keeps at most 100 cards", () => {
    const many = Array.from({ length: 140 }, (_, index) => ({
      ...base,
      id: `offer_${index}`,
      at: `2026-09-05T16:${String(index % 60).padStart(2, "0")}:00.000Z`,
      updatedAt: "2026-09-05T16:49:00.000Z",
    }));
    const text = serializeOffersFile(many, "2026-09-05T16:50:00.000Z");
    expect(parseOffersFile(text, "2026-09-05T16:50:00.000Z", DEFAULT_TRADE_SETTINGS)).toHaveLength(100);
  });
});
