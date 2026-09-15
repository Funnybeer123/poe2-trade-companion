/**
 * Trade offers, notifications and history (feature package "trade", channels
 * `trade:*`, settings namespace "trade", overlay panel "trade").
 *
 * Renderer-safe types plus the two sanitizers the settings namespace and the
 * quick-whisper editor share. No Electron, no DOM, no Node: the desktop view,
 * the overlay panel and the main-process module all import this file.
 *
 * WHY the sanitizers live here: the renderer validates a quick-whisper
 * template while the user types (so the card can explain the refusal before a
 * line is ever typed into the game), and main re-validates everything it
 * reads from disk. One implementation, two callers.
 */
import { CHAT_PLACEHOLDERS, untypableChars, unresolvedPlaceholders } from "../core/chatCommands.js";
import type { FeatureCall } from "./features.js";
import type { ChatCommandOutcome, ChatCommandStatus } from "./chatCommands.js";
import type { FractionalPriceSplit } from "../core/tradeListings.js";

/** incoming = they buy from me (a sale); outgoing = I am buying (a purchase). */
export type TradeOfferDirection = "incoming" | "outgoing";
export type TradeOfferState =
  | "new"
  | "invited"
  | "joined"
  | "trading"
  | "completed"
  | "cancelled"
  | "dismissed";
export const ACTIVE_OFFER_STATES: readonly TradeOfferState[] = ["new", "invited", "joined", "trading"];
export type TradeSecure = "yes" | "maybe" | "no";
export type TradeTransitionVia =
  | "whisper"
  | "chat:invite"
  | "chat:trade"
  | "chat:hideout"
  | "chat:kick"
  | "area-join"
  | "area-leave"
  | "party"
  | "trade-accepted"
  | "trade-cancelled"
  | "user"
  | "timeout"
  | "restore";

export interface TradeOfferPrice {
  /** Exactly as whispered ("1", "exalted"; "20", "Exalted Orb"). */
  amount: number;
  currency: string;
  /** normalizeTradeCurrency result ("exalted", "divine", …) when known. */
  currencyId?: string;
  /** priceInExalted, 2 dp; undefined when the currency or rate is unknown. */
  exalted?: number;
  /** splitFractionalPrice; only for fractional amounts of a non-exalted currency. */
  split?: FractionalPriceSplit;
  /** "1 exalted" / "1.5 divine" / "20 Exalted Orb". */
  text: string;
}

export interface TradeOfferItem {
  name: string;
  baseType?: string;
  quantity?: number;
  /** UI form only ("2× Preserved Cranium"); the {item} placeholder is ASCII. */
  display: string;
}

export interface TradeOfferTransition {
  at: string;
  state: TradeOfferState;
  via: TradeTransitionVia;
  detail?: string;
}

export interface TradeOffer {
  /** "offer_" + fnv1a64Hex(direction|player|raw|minute) — stable across restarts. */
  id: string;
  direction: TradeOfferDirection;
  kind: "item" | "bulk";
  player: string;
  guildTag?: string;
  /** First whisper (ISO, from the client-log service). */
  at: string;
  updatedAt: string;
  /** Identical whisper repeated inside REPEAT_WINDOW_MS. */
  repeats: number;
  item: TradeOfferItem;
  price: TradeOfferPrice;
  league: string;
  /** false when the whisper's league differs from the resolved pricing league. */
  leagueMatches?: boolean;
  stash?: { tab: string; left: number; top: number };
  secure: TradeSecure;
  secureReason?: string;
  language: string;
  /** The matched TRADE_WHISPER_TEMPLATES entry's `tested` flag. */
  templateTested: boolean;
  raw: string;
  state: TradeOfferState;
  stateAt: string;
  /** Newest last, capped at MAX_TRANSITIONS. */
  transitions: TradeOfferTransition[];
  lastMessage?: { at: string; direction: "in" | "out"; text: string };
  notified: { windows: boolean; toast: boolean; sound: boolean; discord: boolean; telegram: boolean };
  historyId?: string;
}

export type TradeHistoryKind = "sale" | "purchase" | "unknown";
export type TradeHistoryMatched = "offer" | "manual" | "unmatched" | "shop-ledger";

/**
 * FROZEN for the session/home package (it reads trade-history.json read-only):
 * `at`, `kind` and `price.exalted` keep these names and meanings.
 */
export interface TradeHistoryEntry {
  id: string;
  at: string;
  kind: TradeHistoryKind;
  /** "" for shop-ledger rows (the Earnings tab does not name the buyer). */
  player: string;
  item: { name: string; baseType?: string; quantity?: number; itemClass?: string };
  price: { amount: number; currency: string; currencyId?: string; exalted?: number };
  league?: string;
  offerId?: string;
  secure: TradeSecure;
  matched: TradeHistoryMatched;
  note?: string;
  editedAt?: string;
}

export interface TradeHistoryTotals {
  count: number;
  sales: number;
  purchases: number;
  unknown: number;
  earningsExalted: number;
  spendingsExalted: number;
  profitExalted: number;
  byCurrency: Record<string, { sales: number; purchases: number }>;
  divineRate: number;
  divineRateSource: "price-table" | "fallback";
  unpriced: number;
}

export interface TradeHistoryView {
  /** Newest first. */
  entries: TradeHistoryEntry[];
  totals: TradeHistoryTotals;
  retentionDays: number;
  file: string;
  shopLedger: { file: string; imported: number; lastError?: string };
  lastError?: string;
}

export interface TradeQuickWhisper {
  id: string;
  label: string;
  template: string;
  show: "incoming" | "outgoing" | "both";
}

export interface TradeSettings {
  /** false = trade whispers are ignored entirely. */
  enabled: boolean;
  compact: boolean;
  /** false = newest on top. */
  invertedOrder: boolean;
  autoExpandInTown: boolean;
  showPanelOnOffer: "always" | "town" | "never";
  /** Never hides a pinned or explicitly shown panel. */
  hidePanelWhenIdle: boolean;
  panelAnchor: "top-right" | "right" | "left" | "bottom-right" | "bottom-left";
  /** Active offers time out to "dismissed" after this long. */
  offerTtlMinutes: number;
  /** Finished cards stay listed this long. */
  completedLingerMinutes: number;
  quickWhispers: TradeQuickWhisper[];
  notifications: { windows: boolean; toast: boolean; sound: boolean; outgoing: boolean };
  /** URLs and tokens live in trade-webhooks.secret.json, NEVER here. */
  webhooks: { discord: boolean; telegram: boolean; includePlayerName: boolean };
  historyRetentionDays: number;
  /** An unmatched "Trade accepted" lands in history as kind "unknown". */
  recordUnmatched: boolean;
  /** Merge verified sales from artifacts/tab-admin/listings.jsonl. */
  importShopSales: boolean;
}

export type TradeOfferAction =
  | { kind: "invite" }
  | { kind: "trade" }
  | { kind: "kick" }
  | { kind: "hideout" }
  | { kind: "leave" }
  | { kind: "highlight" }
  | { kind: "quick-whisper"; id: string }
  | { kind: "custom-whisper"; text: string }
  /** Clipboard only, no game input. */
  | { kind: "copy-whisper"; id?: string; text?: string }
  | { kind: "dismiss" }
  | { kind: "complete" }
  | { kind: "reopen" };

export type TradeActionOrigin = "desktop" | "overlay" | "hotkey";

export interface TradeActionOutcome {
  ok: boolean;
  offer?: TradeOffer;
  chat?: ChatCommandOutcome;
  copied?: string;
  error?: string;
}

export interface TradeStatus {
  enabled: boolean;
  clientLog: { watching: boolean; file?: string; error?: string };
  area?: { id: string; name: string; category: string; inTown: boolean };
  character?: string;
  /** Resolved pricing league. */
  league?: string;
  divineRate: number;
  divineRateSource: "price-table" | "fallback";
  feedAgeHours?: number;
  activeOffers: number;
  chat?: ChatCommandStatus;
  dryRun: boolean;
  poeRunning: boolean;
  panelVisible: boolean;
  panelPinned: boolean;
  /** The trade panel holds keyboard focus (its custom-whisper input is open). */
  panelFocused: boolean;
  lastError?: string;
}

export interface TradeWebhookTargetStatus {
  enabled: boolean;
  configured: boolean;
  lastAt?: string;
  lastOk?: boolean;
  lastError?: string;
  sentThisMinute: number;
}

export interface TradeWebhookStatus {
  discord: TradeWebhookTargetStatus;
  telegram: TradeWebhookTargetStatus;
  includePlayerName: boolean;
  file: string;
}

export interface TradeWebhookSecretsPatch {
  discordWebhookUrl?: string | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}

export interface TradeHistoryEdit {
  /** Absent = add a manual entry. */
  id?: string;
  at?: string;
  kind?: TradeHistoryKind;
  player?: string;
  item?: { name: string; baseType?: string; quantity?: number };
  price?: { amount: number; currency: string };
  league?: string;
  note?: string;
  secure?: TradeSecure;
}

export interface TradeCsvExportResult {
  ok: boolean;
  rows: number;
  path?: string;
  copied?: boolean;
  reason?: "canceled" | "empty" | "write-failed";
  error?: string;
}

/** Overlay panel "trade" payload (a seed; the panel then follows the events). */
export interface TradePanelPayload {
  offers: TradeOffer[];
  status: TradeStatus;
  settings: Pick<TradeSettings, "compact" | "autoExpandInTown" | "invertedOrder" | "quickWhispers">;
}

export interface TradeContract {
  "trade:offers": FeatureCall<[], TradeOffer[]>;
  "trade:offer-action": FeatureCall<
    [offerId: string, action: TradeOfferAction, origin?: TradeActionOrigin],
    TradeActionOutcome
  >;
  "trade:dismiss-all": FeatureCall<[], TradeOffer[]>;
  "trade:status": FeatureCall<[], TradeStatus>;
  "trade:panel": FeatureCall<[action: "show" | "hide" | "toggle"], TradeStatus>;
  /** The panel asks for / releases keyboard focus for its custom-whisper input. */
  "trade:panel-focus": FeatureCall<[focus: boolean], TradeStatus>;
  "trade:history": FeatureCall<[], TradeHistoryView>;
  "trade:history-save": FeatureCall<[edit: TradeHistoryEdit], TradeHistoryView>;
  "trade:history-delete": FeatureCall<[id: string], TradeHistoryView>;
  "trade:history-export": FeatureCall<[target: "file" | "clipboard"], TradeCsvExportResult>;
  "trade:webhooks": FeatureCall<[], TradeWebhookStatus>;
  "trade:webhooks-set": FeatureCall<[patch: TradeWebhookSecretsPatch], TradeWebhookStatus>;
  "trade:webhooks-test": FeatureCall<[target: "discord" | "telegram"], TradeWebhookTargetStatus>;
}

export interface TradeEvents {
  "trade:changed": TradeOffer[];
  "trade:offer": {
    offer: TradeOffer;
    reason: "new" | "repeat" | "state" | "message";
    /** Exactly one window plays the beep for a new offer. */
    playSoundIn?: "overlay" | "main";
  };
  "trade:status": TradeStatus;
  "trade:history-changed": TradeHistoryView;
  "trade:webhooks": TradeWebhookStatus;
}

export const DEFAULT_QUICK_WHISPERS: readonly TradeQuickWhisper[] = [
  {
    id: "wait",
    label: "Wait",
    show: "incoming",
    template: "@{player} One moment please, I will invite you for {item} shortly",
  },
  { id: "thanks", label: "Thanks", show: "both", template: "@{player} Thank you, have a good one" },
  { id: "sold", label: "Sold", show: "incoming", template: "@{player} Sorry, {item} is already sold" },
  { id: "ready", label: "Ready", show: "outgoing", template: "@{player} Ready when you are for {item}" },
];

export const DEFAULT_TRADE_SETTINGS: TradeSettings = {
  enabled: true,
  compact: false,
  invertedOrder: false,
  autoExpandInTown: true,
  showPanelOnOffer: "always",
  hidePanelWhenIdle: true,
  panelAnchor: "top-right",
  offerTtlMinutes: 60,
  completedLingerMinutes: 5,
  quickWhispers: DEFAULT_QUICK_WHISPERS.map((entry) => ({ ...entry })),
  notifications: { windows: true, toast: true, sound: true, outgoing: false },
  webhooks: { discord: false, telegram: false, includePlayerName: true },
  historyRetentionDays: 14,
  recordUnmatched: true,
  importShopSales: true,
};

/**
 * Keys a stray write (an older build, a hand-edited file) could put under
 * `webhooks`. The sanitizer drops them: a bot token must never live in the
 * shared companion-settings.json that every renderer window can read.
 */
export const TRADE_WEBHOOK_SECRET_KEYS = [
  "discordUrl",
  "discordWebhookUrl",
  "telegramBotToken",
  "telegramChatId",
  "url",
  "token",
  "chatId",
] as const;

export const MAX_QUICK_WHISPERS = 8;
export const QUICK_WHISPER_LABEL_MAX = 24;
export const QUICK_WHISPER_TEMPLATE_MAX = 240;

export function isActiveOffer(offer: Pick<TradeOffer, "state">): boolean {
  return ACTIVE_OFFER_STATES.includes(offer.state);
}

export function isTownLike(category: string | undefined): boolean {
  return category === "town" || category === "hideout" || category === "endgame-town";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function slugId(raw: string, index: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || `quick-${index + 1}`;
}

/**
 * One quick-whisper row. A template must start with `@{player}` (a whisper) or
 * `/` (a command); anything else would land in local chat where everyone
 * standing in town reads it.
 */
export function validateQuickWhisper(
  input: unknown,
  index = 0,
): { value?: TradeQuickWhisper; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input)) return { issues: ["quick whisper must be an object"] };
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const template = typeof input.template === "string" ? input.template.trim() : "";
  const showRaw = input.show;
  const show: TradeQuickWhisper["show"] =
    showRaw === "incoming" || showRaw === "outgoing" || showRaw === "both" ? showRaw : "both";
  if (!label || label.length > QUICK_WHISPER_LABEL_MAX) {
    issues.push(`quick whisper label must be 1–${QUICK_WHISPER_LABEL_MAX} characters`);
  }
  if (!template || template.length > QUICK_WHISPER_TEMPLATE_MAX) {
    issues.push(`quick whisper template must be 1–${QUICK_WHISPER_TEMPLATE_MAX} characters`);
  }
  if (template && !template.startsWith("@{player}") && !template.startsWith("/")) {
    issues.push("quick whispers must start with @{player} or /");
  }
  const untypable = untypableChars(template.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""));
  if (untypable.length > 0) {
    issues.push(`the input host cannot type: ${untypable.join(" ")}`);
  }
  const unknown = unresolvedPlaceholders(template).filter(
    (name) => !(CHAT_PLACEHOLDERS as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    issues.push(`unknown placeholder(s): ${unknown.map((name) => `{${name}}`).join(", ")}`);
  }
  if (issues.length > 0) return { issues };
  const id =
    typeof input.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(input.id.trim())
      ? input.id.trim()
      : slugId(label, index);
  return { value: { id, label, template, show }, issues };
}

/**
 * Settings namespace "trade". Never throws: a hand-edited or stale document
 * falls back field by field and reports what it dropped.
 */
export function normalizeTradeSettings(raw: unknown): { value: TradeSettings; issues: string[] } {
  const issues: string[] = [];
  const source = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) issues.push("settings must be an object; defaults used");

  const defaults = DEFAULT_TRADE_SETTINGS;
  const showPanelRaw = source.showPanelOnOffer;
  const showPanelOnOffer: TradeSettings["showPanelOnOffer"] =
    showPanelRaw === "always" || showPanelRaw === "town" || showPanelRaw === "never"
      ? showPanelRaw
      : defaults.showPanelOnOffer;
  if (showPanelRaw !== undefined && showPanelRaw !== showPanelOnOffer) {
    issues.push('showPanelOnOffer must be "always", "town" or "never"');
  }

  const anchors: ReadonlyArray<TradeSettings["panelAnchor"]> = [
    "top-right",
    "right",
    "left",
    "bottom-right",
    "bottom-left",
  ];
  const anchorRaw = source.panelAnchor;
  const panelAnchor = anchors.find((anchor) => anchor === anchorRaw) ?? defaults.panelAnchor;
  if (anchorRaw !== undefined && anchorRaw !== panelAnchor) issues.push("panelAnchor is not a known anchor");

  let quickWhispers: TradeQuickWhisper[];
  if (Array.isArray(source.quickWhispers)) {
    quickWhispers = [];
    const seen = new Set<string>();
    source.quickWhispers.forEach((entry, index) => {
      if (quickWhispers.length >= MAX_QUICK_WHISPERS) return;
      const checked = validateQuickWhisper(entry, index);
      if (!checked.value) {
        issues.push(...checked.issues);
        return;
      }
      if (seen.has(checked.value.id)) {
        issues.push(`duplicate quick whisper id "${checked.value.id}" dropped`);
        return;
      }
      seen.add(checked.value.id);
      quickWhispers.push(checked.value);
    });
    if (source.quickWhispers.length > MAX_QUICK_WHISPERS) {
      issues.push(`at most ${MAX_QUICK_WHISPERS} quick whispers are kept`);
    }
  } else {
    if (source.quickWhispers !== undefined) issues.push("quickWhispers must be an array");
    quickWhispers = defaults.quickWhispers.map((entry) => ({ ...entry }));
  }

  const notificationsRaw = isRecord(source.notifications) ? source.notifications : {};
  const webhooksRaw = isRecord(source.webhooks) ? source.webhooks : {};
  const droppedSecrets = Object.keys(webhooksRaw).filter(
    (key) =>
      (TRADE_WEBHOOK_SECRET_KEYS as readonly string[]).includes(key) ||
      typeof webhooksRaw[key] === "string",
  );
  if (droppedSecrets.length > 0) {
    issues.push(
      `webhook secrets are never stored in companion-settings.json — dropped ${droppedSecrets.join(", ")}`,
    );
  }

  const value: TradeSettings = {
    enabled: boolOr(source.enabled, defaults.enabled),
    compact: boolOr(source.compact, defaults.compact),
    invertedOrder: boolOr(source.invertedOrder, defaults.invertedOrder),
    autoExpandInTown: boolOr(source.autoExpandInTown, defaults.autoExpandInTown),
    showPanelOnOffer,
    hidePanelWhenIdle: boolOr(source.hidePanelWhenIdle, defaults.hidePanelWhenIdle),
    panelAnchor,
    offerTtlMinutes: clampInt(source.offerTtlMinutes, 5, 720, defaults.offerTtlMinutes),
    completedLingerMinutes: clampInt(source.completedLingerMinutes, 1, 60, defaults.completedLingerMinutes),
    quickWhispers,
    notifications: {
      windows: boolOr(notificationsRaw.windows, defaults.notifications.windows),
      toast: boolOr(notificationsRaw.toast, defaults.notifications.toast),
      sound: boolOr(notificationsRaw.sound, defaults.notifications.sound),
      outgoing: boolOr(notificationsRaw.outgoing, defaults.notifications.outgoing),
    },
    webhooks: {
      discord: boolOr(webhooksRaw.discord, defaults.webhooks.discord),
      telegram: boolOr(webhooksRaw.telegram, defaults.webhooks.telegram),
      includePlayerName: boolOr(webhooksRaw.includePlayerName, defaults.webhooks.includePlayerName),
    },
    historyRetentionDays: clampInt(source.historyRetentionDays, 1, 90, defaults.historyRetentionDays),
    recordUnmatched: boolOr(source.recordUnmatched, defaults.recordUnmatched),
    importShopSales: boolOr(source.importShopSales, defaults.importShopSales),
  };
  return { value, issues };
}
