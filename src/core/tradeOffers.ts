/**
 * Pure offer logic for the trade package: turn Client.txt events into offer
 * cards, advance their state, and turn a button press into exactly ONE chat
 * line. No I/O, no clock, no Electron — main feeds events in, the renderer
 * imports the same module for formatting, and every test runs offline.
 *
 * WHY a reducer instead of a service: the state machine (whisper → invited →
 * joined → trading → completed) is the part that must be provable from log
 * fixtures, so it is a pure function over `(offers, event, ctx)` and the
 * module around it only does timers, files and IPC.
 */
import { TRADE_WHISPER_TEMPLATES, type ClientLogEvent, type TradeWhisper } from "./clientLog.js";
import type { PriceTable } from "./priceTable.js";
import { lookupPrice } from "./priceTable.js";
import { normalizeTradeCurrency, priceInExalted, splitFractionalPrice } from "./tradeListings.js";
import { resolvePlaceholders } from "./chatCommands.js";
import type { PlaceholderContext } from "../shared/chatCommands.js";
import type {
  TradeHistoryEntry,
  TradeOffer,
  TradeOfferAction,
  TradeOfferItem,
  TradeOfferPrice,
  TradeOfferState,
  TradeSecure,
  TradeSettings,
  TradeTransitionVia,
} from "../shared/trade.js";
import { ACTIVE_OFFER_STATES } from "../shared/trade.js";

/** A repeated identical whisper inside this window updates the card instead of making a new one. */
export const REPEAT_WINDOW_MS = 10 * 60_000;
export const MAX_OFFERS = 100;
export const MAX_TRANSITIONS = 20;
/** A "Trade accepted" is not matched to a card that has been silent longer than this (unless it is mid-trade). */
export const ACCEPT_MATCH_WINDOW_MS = 30 * 60_000;
const CUSTOM_WHISPER_MAX = 200;
/** Field separator inside the id hash: a NUL can never appear in a chat line. */
const ID_SEPARATOR = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Pricing (composition over src/core/tradeListings.ts — never re-implemented)
// ---------------------------------------------------------------------------

export function describeWhisperPrice(whisper: TradeWhisper, table?: PriceTable): TradeOfferPrice {
  const { amount, currency } = whisper.price;
  const price: TradeOfferPrice = { amount, currency, text: `${amount} ${currency}`.trim() };
  const currencyId = normalizeTradeCurrency(currency);
  if (currencyId) price.currencyId = currencyId;
  const exalted = priceInExalted(amount, currency, table);
  if (exalted !== undefined) price.exalted = exalted;
  const split = splitFractionalPrice(amount, currency, table);
  if (split) price.split = split;
  return price;
}

/** Where the divine rate behind a conversion came from (tooltip copy). */
export function divineRateSourceOf(table?: PriceTable): "price-table" | "fallback" {
  if (!table) return "fallback";
  const hit = lookupPrice(table, { name: "Divine Orb" });
  return hit && hit.value > 0 ? "price-table" : "fallback";
}

/** The matched trade-site template's `tested` flag ("en" today; the rest are transcribed). */
export function templateTested(language: string, kind: "item" | "bulk"): boolean {
  return (
    TRADE_WHISPER_TEMPLATES.find((entry) => entry.language === language && entry.kind === kind)?.tested ??
    false
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Two seeded 32-bit FNV-1a passes concatenated: 16 stable hex chars, no node:crypto. */
export function fnv1a64Hex(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= code + index;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function offerIdFor(
  direction: TradeOffer["direction"],
  player: string,
  raw: string,
  at: string,
): string {
  return `offer_${fnv1a64Hex([direction, player, raw, at.slice(0, 16)].join(ID_SEPARATOR))}`;
}

/**
 * A NEW card must never reuse an id that is already in the list. `offerIdFor`
 * hashes the whisper to the MINUTE, so the same buyer re-whispering the same
 * line inside that minute — after the first card was dismissed, so the repeat
 * branch no longer matches it — would otherwise mint a duplicate id. Duplicate
 * ids make `get(id)` ambiguous, make `applyOfferTransition` rewrite BOTH rows
 * at once, and give the renderer two entries under one `:key`.
 */
export function uniqueOfferId(taken: ReadonlySet<string>, offer: TradeOffer): string {
  if (!taken.has(offer.id)) return offer.id;
  const base = [offer.direction, offer.player, offer.raw, offer.at.slice(0, 16)].join(ID_SEPARATOR);
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    const candidate = `offer_${fnv1a64Hex([base, String(attempt)].join(ID_SEPARATOR))}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 64 hash collisions in a row is not reachable in practice; salt with the
  // list size so even then the caller still gets a distinct id.
  return `offer_${fnv1a64Hex([base, offer.updatedAt, String(taken.size)].join(ID_SEPARATOR))}`;
}

// ---------------------------------------------------------------------------
// Offers from whispers
// ---------------------------------------------------------------------------

/** Untested: no Secure Item whisper has been captured in a real log yet. */
export const TRADE_SECURE_MARKERS: readonly RegExp[] = [
  /\bsecure item\b/i,
  /\bvia (?:the )?merchant\b/i,
  /\bange\b/i,
];

export function detectSecureListing(whisper: TradeWhisper): { secure: TradeSecure; reason?: string } {
  for (const marker of TRADE_SECURE_MARKERS) {
    if (marker.test(whisper.raw)) return { secure: "yes", reason: "the whisper mentions a secure listing" };
  }
  if (whisper.kind === "item" && !whisper.stashTab && !whisper.position) {
    return { secure: "maybe", reason: "no stash tab or position in the whisper" };
  }
  return { secure: "no" };
}

/** UI form: "2× Preserved Cranium" / "Ghoul Lash, Long Belt". */
export function itemDisplay(whisper: TradeWhisper): string {
  const name = whisper.itemName ?? whisper.baseType ?? "?";
  if (whisper.kind === "bulk") return `${whisper.quantity ?? 1}× ${name}`;
  const base = whisper.baseType;
  return base && base !== name ? `${name}, ${base}` : name;
}

/**
 * ASCII form for the `{item}` chat placeholder. `×` is not host-typable, so the
 * display form would make the chat service refuse the whole line.
 */
export function itemPlaceholder(item: TradeOfferItem, kind: "item" | "bulk"): string {
  if (kind === "bulk") return `${item.quantity ?? 1} ${item.name}`;
  return item.baseType && item.baseType !== item.name ? `${item.name}, ${item.baseType}` : item.name;
}

export interface TradeReduceContext {
  now: string;
  settings: TradeSettings;
  priceTable?: PriceTable;
  resolvedLeague?: string;
  character?: string;
  inTown: boolean;
}

type WhisperEvent = Extract<ClientLogEvent, { kind: "whisper" }>;

export function offerFromWhisper(
  event: WhisperEvent & { trade: TradeWhisper },
  ctx: TradeReduceContext,
): TradeOffer {
  const trade = event.trade;
  const direction: TradeOffer["direction"] = event.direction === "in" ? "incoming" : "outgoing";
  const name = trade.itemName ?? trade.baseType ?? "?";
  const item: TradeOfferItem = { name, display: itemDisplay(trade) };
  if (trade.baseType) item.baseType = trade.baseType;
  if (trade.quantity !== undefined) item.quantity = trade.quantity;
  const secure = detectSecureListing(trade);
  const offer: TradeOffer = {
    id: offerIdFor(direction, event.player, trade.raw, event.at),
    direction,
    kind: trade.kind,
    player: event.player,
    at: event.at,
    updatedAt: event.at,
    repeats: 1,
    item,
    price: describeWhisperPrice(trade, ctx.priceTable),
    league: trade.league,
    secure: secure.secure,
    language: trade.language,
    templateTested: templateTested(trade.language, trade.kind),
    raw: trade.raw,
    state: "new",
    stateAt: event.at,
    transitions: [{ at: event.at, state: "new", via: "whisper" }],
    notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
  };
  if (event.guildTag) offer.guildTag = event.guildTag;
  if (secure.reason) offer.secureReason = secure.reason;
  if (ctx.resolvedLeague) {
    offer.leagueMatches = trade.league.toLowerCase() === ctx.resolvedLeague.toLowerCase();
  }
  if (trade.stashTab && trade.position) {
    offer.stash = { tab: trade.stashTab, left: trade.position.left, top: trade.position.top };
  }
  return offer;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export type TradeReduceEffect =
  | { kind: "offer-new"; offer: TradeOffer }
  | { kind: "offer-repeat"; offer: TradeOffer }
  | { kind: "offer-state"; offer: TradeOffer; previous: TradeOfferState }
  | { kind: "offer-message"; offer: TradeOffer }
  | { kind: "history-add"; entry: TradeHistoryEntry }
  | { kind: "offer-timeout"; offer: TradeOffer };

export interface TradeReduceResult {
  offers: TradeOffer[];
  effects: TradeReduceEffect[];
}

export function isActive(offer: TradeOffer): boolean {
  return ACTIVE_OFFER_STATES.includes(offer.state);
}

function withTransition(
  offer: TradeOffer,
  state: TradeOfferState,
  via: TradeTransitionVia,
  now: string,
  detail?: string,
): TradeOffer {
  const transition = detail ? { at: now, state, via, detail } : { at: now, state, via };
  const transitions = [...offer.transitions, transition].slice(-MAX_TRANSITIONS);
  return { ...offer, state, stateAt: now, updatedAt: now, transitions };
}

/**
 * One row per id (the freshest `updatedAt` wins) and at most MAX_OFFERS rows.
 * The dedupe also repairs a hand-edited or half-written `trade-offers.json`,
 * which is the other way two rows can end up sharing an id.
 */
function capOffers(offers: TradeOffer[]): TradeOffer[] {
  const best = new Map<string, TradeOffer>();
  for (const offer of offers) {
    const seen = best.get(offer.id);
    if (!seen || offer.updatedAt > seen.updatedAt) best.set(offer.id, offer);
  }
  const unique: TradeOffer[] = [];
  const used = new Set<string>();
  for (const offer of offers) {
    if (used.has(offer.id)) continue;
    used.add(offer.id);
    unique.push(best.get(offer.id) ?? offer);
  }
  if (unique.length <= MAX_OFFERS) return unique;
  return [...unique].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, MAX_OFFERS);
}

function msBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return b - a;
}

export function offerAgeMs(offer: TradeOffer, now: string): number {
  return msBetween(offer.updatedAt, now);
}

export function historyEntryFromOffer(
  offer: TradeOffer,
  at: string,
  rand?: () => string,
): TradeHistoryEntry {
  const entry: TradeHistoryEntry = {
    id: `th_${at.replace(/[:.]/g, "-")}_${(rand?.() ?? Math.random().toString(36).slice(2)).slice(0, 4)}`,
    at,
    kind: offer.direction === "incoming" ? "sale" : "purchase",
    player: offer.player,
    item: { name: offer.item.name },
    price: { amount: offer.price.amount, currency: offer.price.currency },
    secure: offer.secure,
    matched: "offer",
    offerId: offer.id,
    league: offer.league,
  };
  if (offer.item.baseType) entry.item.baseType = offer.item.baseType;
  if (offer.item.quantity !== undefined) entry.item.quantity = offer.item.quantity;
  if (offer.price.currencyId) entry.price.currencyId = offer.price.currencyId;
  if (offer.price.exalted !== undefined) entry.price.exalted = offer.price.exalted;
  return entry;
}

/**
 * Which active offer a bare "Trade accepted." belongs to. The game never names
 * the counterpart on that line, so the card furthest along the flow wins, then
 * the freshest one.
 */
export function matchAcceptedTrade(offers: readonly TradeOffer[], now: string): TradeOffer | undefined {
  const score = (offer: TradeOffer): number => {
    switch (offer.state) {
      case "trading":
        return 3;
      case "joined":
        return 2;
      case "invited":
        return 1;
      default:
        return offer.direction === "outgoing" ? 1 : 0;
    }
  };
  let best: TradeOffer | undefined;
  for (const offer of offers) {
    if (!isActive(offer)) continue;
    const stale = msBetween(offer.updatedAt, now) > ACCEPT_MATCH_WINDOW_MS;
    if (stale && offer.state !== "trading" && offer.state !== "joined") continue;
    if (!best) {
      best = offer;
      continue;
    }
    const delta = score(offer) - score(best);
    if (delta > 0) best = offer;
    else if (delta === 0 && offer.stateAt > best.stateAt) best = offer;
    else if (delta === 0 && offer.stateAt === best.stateAt && offer.updatedAt > best.updatedAt) best = offer;
  }
  return best;
}

function unmatchedHistoryEntry(at: string, rand?: () => string): TradeHistoryEntry {
  return {
    id: `th_${at.replace(/[:.]/g, "-")}_${(rand?.() ?? Math.random().toString(36).slice(2)).slice(0, 4)}`,
    at,
    kind: "unknown",
    player: "",
    item: { name: "Unknown trade" },
    price: { amount: 0, currency: "" },
    secure: "no",
    matched: "unmatched",
  };
}

/** One Client.txt event → the next offer list plus what the module must announce. */
export function applyClientLogEvent(
  offers: readonly TradeOffer[],
  event: ClientLogEvent,
  ctx: TradeReduceContext,
  rand?: () => string,
): TradeReduceResult {
  const none: TradeReduceResult = { offers: [...offers], effects: [] };
  if (!ctx.settings.enabled) return none;

  if (event.kind === "whisper") {
    if (!event.trade) {
      // A plain whisper only annotates cards that already exist.
      let touched: TradeOffer | undefined;
      const next = offers.map((offer) => {
        if (!isActive(offer) || offer.player !== event.player) return offer;
        touched = {
          ...offer,
          updatedAt: event.at,
          lastMessage: { at: event.at, direction: event.direction, text: event.text },
        };
        return touched;
      });
      return touched ? { offers: next, effects: [{ kind: "offer-message", offer: touched }] } : none;
    }
    const created = offerFromWhisper(event as WhisperEvent & { trade: TradeWhisper }, ctx);
    const repeatIndex = offers.findIndex(
      (offer) =>
        isActive(offer) &&
        offer.direction === created.direction &&
        offer.player === created.player &&
        offer.raw === created.raw &&
        msBetween(offer.updatedAt, event.at) <= REPEAT_WINDOW_MS,
    );
    if (repeatIndex >= 0) {
      const updated: TradeOffer = {
        ...offers[repeatIndex],
        repeats: offers[repeatIndex].repeats + 1,
        updatedAt: event.at,
      };
      const next = [...offers];
      next[repeatIndex] = updated;
      return { offers: next, effects: [{ kind: "offer-repeat", offer: updated }] };
    }
    const id = uniqueOfferId(new Set(offers.map((offer) => offer.id)), created);
    const fresh = id === created.id ? created : { ...created, id };
    return { offers: capOffers([fresh, ...offers]), effects: [{ kind: "offer-new", offer: fresh }] };
  }

  if (event.kind === "area-join") {
    let changed: { offer: TradeOffer; previous: TradeOfferState } | undefined;
    const next = offers.map((offer) => {
      if (changed || offer.direction !== "incoming" || offer.player !== event.player) return offer;
      if (event.joined && (offer.state === "new" || offer.state === "invited")) {
        const updated = withTransition(offer, "joined", "area-join", event.at, "joined the area");
        changed = { offer: updated, previous: offer.state };
        return updated;
      }
      if (!event.joined && (offer.state === "joined" || offer.state === "trading")) {
        const updated = withTransition(offer, "invited", "area-leave", event.at, "left the area");
        changed = { offer: updated, previous: offer.state };
        return updated;
      }
      return offer;
    });
    return changed
      ? { offers: next, effects: [{ kind: "offer-state", offer: changed.offer, previous: changed.previous }] }
      : none;
  }

  if (event.kind === "party") {
    if (event.action !== "joined") return none;
    let changed: { offer: TradeOffer; previous: TradeOfferState } | undefined;
    const next = offers.map((offer) => {
      if (changed || offer.direction !== "outgoing" || offer.player !== event.player) return offer;
      if (offer.state !== "new" && offer.state !== "invited") return offer;
      const updated = withTransition(offer, "joined", "party", event.at, "joined the party");
      changed = { offer: updated, previous: offer.state };
      return updated;
    });
    return changed
      ? { offers: next, effects: [{ kind: "offer-state", offer: changed.offer, previous: changed.previous }] }
      : none;
  }

  if (event.kind === "trade" && event.result === "accepted") {
    const match = matchAcceptedTrade(offers, event.at);
    if (!match) {
      if (!ctx.settings.recordUnmatched) return none;
      return { offers: [...offers], effects: [{ kind: "history-add", entry: unmatchedHistoryEntry(event.at, rand) }] };
    }
    const entry = historyEntryFromOffer(match, event.at, rand);
    const completed = { ...withTransition(match, "completed", "trade-accepted", event.at), historyId: entry.id };
    const next = offers.map((offer) => (offer.id === match.id ? completed : offer));
    return {
      offers: next,
      effects: [
        { kind: "offer-state", offer: completed, previous: match.state },
        { kind: "history-add", entry },
      ],
    };
  }

  if (event.kind === "trade" && event.result === "cancelled") {
    const trading = offers
      .filter((offer) => offer.state === "trading")
      .sort((a, b) => (a.stateAt < b.stateAt ? 1 : -1))[0];
    if (!trading) return none;
    const updated = withTransition(trading, "joined", "trade-cancelled", event.at, "trade cancelled");
    return {
      offers: offers.map((offer) => (offer.id === trading.id ? updated : offer)),
      effects: [{ kind: "offer-state", offer: updated, previous: trading.state }],
    };
  }

  return none;
}

export function applyOfferTransition(
  offers: readonly TradeOffer[],
  offerId: string,
  state: TradeOfferState,
  via: TradeTransitionVia,
  now: string,
  detail?: string,
): TradeReduceResult {
  const current = offers.find((offer) => offer.id === offerId);
  if (!current) return { offers: [...offers], effects: [] };
  const updated = withTransition(current, state, via, now, detail);
  return {
    offers: offers.map((offer) => (offer.id === offerId ? updated : offer)),
    effects: [{ kind: "offer-state", offer: updated, previous: current.state }],
  };
}

/** TTL for active cards; finished cards are dropped a while after their linger window. */
export function expireOffers(offers: readonly TradeOffer[], ctx: TradeReduceContext): TradeReduceResult {
  const ttlMs = ctx.settings.offerTtlMinutes * 60_000;
  const dropAfterMs = ctx.settings.completedLingerMinutes * 60_000 + 2 * 60 * 60_000;
  const effects: TradeReduceEffect[] = [];
  const next: TradeOffer[] = [];
  for (const offer of offers) {
    const age = msBetween(offer.updatedAt, ctx.now);
    if (isActive(offer)) {
      if (age > ttlMs) {
        const updated = withTransition(offer, "dismissed", "timeout", ctx.now, "timed out");
        effects.push({ kind: "offer-timeout", offer: updated });
        next.push(updated);
      } else {
        next.push(offer);
      }
      continue;
    }
    if (msBetween(offer.stateAt, ctx.now) > dropAfterMs) continue;
    next.push(offer);
  }
  return { offers: next, effects };
}

/**
 * Active cards first, then finished ones. Inside each group the default is
 * NEWEST first (the freshest whisper is at the top of the panel); `inverted`
 * is the "Newest at bottom" setting, which reads the queue oldest-first.
 */
export function sortOffers(offers: readonly TradeOffer[], inverted: boolean): TradeOffer[] {
  const rank = (offer: TradeOffer): number => (isActive(offer) ? 0 : 1);
  return [...offers].sort((a, b) => {
    const byGroup = rank(a) - rank(b);
    if (byGroup !== 0) return byGroup;
    const byTime = a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    return inverted ? byTime : -byTime;
  });
}

export function latestActiveOffer(
  offers: readonly TradeOffer[],
  direction: TradeOffer["direction"],
  states: readonly TradeOfferState[],
): TradeOffer | undefined {
  return [...offers]
    .filter((offer) => offer.direction === direction && states.includes(offer.state))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

// ---------------------------------------------------------------------------
// Persistence helpers (the store does the I/O)
// ---------------------------------------------------------------------------

const OFFER_STATES: readonly TradeOfferState[] = [
  "new",
  "invited",
  "joined",
  "trading",
  "completed",
  "cancelled",
  "dismissed",
];

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One persisted offer; anything unrecognisable is dropped rather than repaired. */
export function sanitizeOffer(raw: unknown): TradeOffer | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const id = str(source.id, 80);
  const player = str(source.player, 200);
  const at = str(source.at, 40);
  const rawText = str(source.raw, 600);
  const direction = source.direction === "outgoing" ? "outgoing" : source.direction === "incoming" ? "incoming" : undefined;
  const state = OFFER_STATES.find((entry) => entry === source.state);
  const itemSource = typeof source.item === "object" && source.item !== null ? (source.item as Record<string, unknown>) : {};
  const priceSource = typeof source.price === "object" && source.price !== null ? (source.price as Record<string, unknown>) : {};
  const name = str(itemSource.name, 200);
  if (!id || !player || !at || !rawText || !direction || !state || !name) return undefined;
  const item: TradeOfferItem = { name, display: str(itemSource.display, 220) ?? name };
  const baseType = str(itemSource.baseType, 200);
  if (baseType) item.baseType = baseType;
  const quantity = num(itemSource.quantity);
  if (quantity !== undefined) item.quantity = quantity;
  const amount = num(priceSource.amount) ?? 0;
  const currency = str(priceSource.currency, 40) ?? "";
  const price: TradeOfferPrice = {
    amount,
    currency,
    text: str(priceSource.text, 80) ?? `${amount} ${currency}`.trim(),
  };
  const currencyId = str(priceSource.currencyId, 40);
  if (currencyId) price.currencyId = currencyId;
  const exalted = num(priceSource.exalted);
  if (exalted !== undefined) price.exalted = exalted;
  const notifiedSource =
    typeof source.notified === "object" && source.notified !== null
      ? (source.notified as Record<string, unknown>)
      : {};
  const transitions = Array.isArray(source.transitions)
    ? source.transitions
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          at: str(entry.at, 40) ?? at,
          state: OFFER_STATES.find((value) => value === entry.state) ?? state,
          via: (str(entry.via, 24) ?? "restore") as TradeTransitionVia,
          detail: str(entry.detail, 120),
        }))
        .map((entry) => (entry.detail ? entry : { at: entry.at, state: entry.state, via: entry.via }))
        .slice(-MAX_TRANSITIONS)
    : [];
  const offer: TradeOffer = {
    id,
    direction,
    kind: source.kind === "bulk" ? "bulk" : "item",
    player,
    at,
    updatedAt: str(source.updatedAt, 40) ?? at,
    repeats: Math.max(1, Math.round(num(source.repeats) ?? 1)),
    item,
    price,
    league: str(source.league, 60) ?? "",
    secure: source.secure === "yes" ? "yes" : source.secure === "maybe" ? "maybe" : "no",
    language: str(source.language, 16) ?? "en",
    templateTested: source.templateTested === true,
    raw: rawText,
    state,
    stateAt: str(source.stateAt, 40) ?? at,
    transitions,
    notified: {
      windows: notifiedSource.windows === true,
      toast: notifiedSource.toast === true,
      sound: notifiedSource.sound === true,
      discord: notifiedSource.discord === true,
      telegram: notifiedSource.telegram === true,
    },
  };
  const guildTag = str(source.guildTag, 40);
  if (guildTag) offer.guildTag = guildTag;
  const secureReason = str(source.secureReason, 120);
  if (secureReason) offer.secureReason = secureReason;
  if (typeof source.leagueMatches === "boolean") offer.leagueMatches = source.leagueMatches;
  const historyId = str(source.historyId, 80);
  if (historyId) offer.historyId = historyId;
  const stashSource = typeof source.stash === "object" && source.stash !== null ? (source.stash as Record<string, unknown>) : undefined;
  if (stashSource) {
    const tab = str(stashSource.tab, 80);
    const left = num(stashSource.left);
    const top = num(stashSource.top);
    if (tab && left !== undefined && top !== undefined) offer.stash = { tab, left, top };
  }
  const messageSource =
    typeof source.lastMessage === "object" && source.lastMessage !== null
      ? (source.lastMessage as Record<string, unknown>)
      : undefined;
  if (messageSource) {
    const text = str(messageSource.text, 300);
    const messageAt = str(messageSource.at, 40);
    if (text && messageAt) {
      offer.lastMessage = {
        at: messageAt,
        direction: messageSource.direction === "out" ? "out" : "in",
        text,
      };
    }
  }
  return offer;
}

export function parseOffersFile(
  text: string | undefined,
  now: string,
  settings: TradeSettings,
): TradeOffer[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as { offers?: unknown }).offers;
  if (!Array.isArray(list)) return [];
  const restored: TradeOffer[] = [];
  for (const raw of list) {
    const offer = sanitizeOffer(raw);
    if (!offer) continue;
    restored.push({
      ...offer,
      transitions: [...offer.transitions, { at: now, state: offer.state, via: "restore" as const }].slice(
        -MAX_TRANSITIONS,
      ),
    });
  }
  const expired = expireOffers(restored, { now, settings, inTown: false });
  return capOffers(expired.offers);
}

export function serializeOffersFile(offers: readonly TradeOffer[], now: string): string {
  return `${JSON.stringify({ version: 1, savedAt: now, offers }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Actions → one chat line
// ---------------------------------------------------------------------------

export interface OfferChatLine {
  text: string;
  reason: string;
  source: "trade";
  nextState?: TradeOfferState;
  via?: TradeTransitionVia;
  detail?: string;
  /** Highlight fills the stash search box instead of sending a chat line. */
  stashSearch?: boolean;
}

export function offerPlaceholderContext(
  offer: TradeOffer,
  extra: { char?: string; area?: string },
): PlaceholderContext {
  const context: PlaceholderContext = {
    player: offer.player,
    item: itemPlaceholder(offer.item, offer.kind),
    price: offer.price.text,
    league: offer.league,
  };
  if (offer.stash) {
    context.tab = offer.stash.tab;
    context.left = offer.stash.left;
    context.top = offer.stash.top;
  }
  if (extra.char) context.char = extra.char;
  if (extra.area) context.area = extra.area;
  if (offer.lastMessage) context.latestWhisper = offer.lastMessage.text;
  return context;
}

/** The exact line a button press would type — or why it cannot be built. */
export function chatLineForAction(
  offer: TradeOffer,
  action: TradeOfferAction,
  settings: TradeSettings,
  extra: { char?: string; area?: string },
): OfferChatLine | { error: string } {
  const reason = `${action.kind} for offer ${offer.id}`;
  switch (action.kind) {
    case "invite":
      if (offer.direction !== "incoming") return { error: "Invite is for buyers; use Hideout" };
      return {
        text: `/invite ${offer.player}`,
        reason,
        source: "trade",
        nextState: "invited",
        via: "chat:invite",
      };
    case "trade":
      return {
        text: `/tradewith ${offer.player}`,
        reason,
        source: "trade",
        nextState: "trading",
        via: "chat:trade",
      };
    case "kick":
      return { text: `/kick ${offer.player}`, reason, source: "trade", via: "chat:kick" };
    case "hideout":
      if (offer.direction !== "outgoing") return { error: "Hideout is for sellers; use Invite" };
      return {
        text: `/hideout ${offer.player}`,
        reason,
        source: "trade",
        nextState: "invited",
        via: "chat:hideout",
        detail: "went to the seller's hideout",
      };
    case "leave": {
      if (!extra.char) return { error: "Your character name is unknown yet (no level-up line seen)" };
      return { text: `/kick ${extra.char}`, reason, source: "trade", via: "chat:kick" };
    }
    case "highlight":
      return { text: offer.item.name, reason, source: "trade", stashSearch: true };
    case "quick-whisper": {
      const template = settings.quickWhispers.find((entry) => entry.id === action.id);
      if (!template) return { error: "That quick whisper no longer exists" };
      const shown =
        template.show === "both" ||
        (template.show === "incoming" && offer.direction === "incoming") ||
        (template.show === "outgoing" && offer.direction === "outgoing");
      if (!shown) return { error: "That quick whisper is not meant for this offer" };
      return {
        text: resolvePlaceholders(template.template, offerPlaceholderContext(offer, extra)),
        reason,
        source: "trade",
      };
    }
    case "custom-whisper": {
      const text = String(action.text ?? "").trim().slice(0, CUSTOM_WHISPER_MAX);
      if (!text) return { error: "Type something to whisper first" };
      return { text: `@${offer.player} ${text}`, reason, source: "trade" };
    }
    default:
      return { error: `"${action.kind}" does not type anything` };
  }
}
