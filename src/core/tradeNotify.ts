/**
 * Pure notification text and webhook request shapes for the trade package.
 *
 * The only outbound network traffic this app makes for trade is to endpoints
 * the USER created (their own Discord webhook, their own Telegram bot), so the
 * validators are strict about the host, the bodies carry no mentions, and
 * every string that could contain a token goes through `redactSecrets` before
 * it reaches a log or an error message.
 */
import type { TradeOffer } from "../shared/trade.js";

export const NOTIFY_USER_AGENT = "poe2-trade-companion/0.1 (local desktop tool)";
export const WEBHOOK_TEXT_MAX = 300;
export const DISCORD_CONTENT_MAX = 2_000;
export const TELEGRAM_TEXT_MAX = 4_096;
export const WEBHOOK_MAX_PER_MINUTE = 10;

export interface WebhookTextOptions {
  includePlayerName: boolean;
}

export function notificationTitle(offer: TradeOffer): string {
  return offer.direction === "incoming"
    ? `Trade offer from ${offer.player}`
    : `You whispered ${offer.player}`;
}

function stashPart(offer: TradeOffer): string {
  if (!offer.stash) return "";
  return ` · stash "${offer.stash.tab}" left ${offer.stash.left}, top ${offer.stash.top}`;
}

export function notificationBody(offer: TradeOffer): string {
  return `${offer.item.display} · ${offer.price.text} · ${offer.league}${stashPart(offer)}`;
}

/** One line, ≤ 300 chars, never a guaranteed price — always "≈" on the estimate. */
export function webhookText(offer: TradeOffer, opts: WebhookTextOptions): string {
  const who = opts.includePlayerName
    ? offer.direction === "incoming"
      ? `Trade offer from ${offer.player}`
      : `You whispered ${offer.player}`
    : offer.direction === "incoming"
      ? "Trade offer"
      : "Outgoing offer";
  const estimate =
    offer.price.split?.text ??
    (offer.price.exalted !== undefined ? `${offer.price.exalted} ex` : undefined);
  const price = estimate ? `${offer.price.text} (≈ ${estimate})` : offer.price.text;
  const line = `[PoE2] ${who} — ${offer.item.display} for ${price} in ${offer.league}${stashPart(offer)}`;
  return line.length > WEBHOOK_TEXT_MAX ? `${line.slice(0, WEBHOOK_TEXT_MAX - 1)}…` : line;
}

export function discordMessage(
  offer: TradeOffer,
  opts: WebhookTextOptions,
): { content: string; username: "PoE2 Trade Companion"; allowed_mentions: { parse: [] } } {
  return {
    content: webhookText(offer, opts).slice(0, DISCORD_CONTENT_MAX),
    username: "PoE2 Trade Companion",
    allowed_mentions: { parse: [] },
  };
}

export function telegramMessage(
  offer: TradeOffer,
  chatId: string,
  opts: WebhookTextOptions,
): { chat_id: string; text: string; disable_web_page_preview: true } {
  return {
    chat_id: chatId,
    text: webhookText(offer, opts).slice(0, TELEGRAM_TEXT_MAX),
    disable_web_page_preview: true,
  };
}

const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
  "www.discord.com",
]);

export function isDiscordWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  return /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]{16,}$/.test(parsed.pathname);
}

export function isTelegramBotToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

export function isTelegramChatId(id: string): boolean {
  const value = id.trim();
  return /^-?\d+$/.test(value) || /^@[A-Za-z0-9_]{5,}$/.test(value);
}

export function telegramSendUrl(token: string): string {
  return `https://api.telegram.org/bot${token.trim()}/sendMessage`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /https:\/\/[\w.-]*discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/gi,
  /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/gi,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
];

/** Masks a webhook URL or bot token anywhere inside a string. */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** The same masking for anything handed to `ctx.log` as `detail`. */
export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) return redactSecrets(value.message);
  if (Array.isArray(value)) return value.map((entry) => redactSecretsDeep(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(entry, depth + 1);
    }
    return out;
  }
  return "[unprintable]";
}

/**
 * A sliding one-minute window per target. Overflow is DROPPED, never queued:
 * a buyer spamming whispers must not turn into a burst against someone else's
 * server.
 */
export class WebhookRateWindow {
  private readonly stamps: number[] = [];

  constructor(
    private readonly maxPerMinute: number = WEBHOOK_MAX_PER_MINUTE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private trim(): void {
    const cutoff = this.now() - 60_000;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  allow(): boolean {
    this.trim();
    if (this.stamps.length >= this.maxPerMinute) return false;
    this.stamps.push(this.now());
    return true;
  }

  sentThisMinute(): number {
    this.trim();
    return this.stamps.length;
  }
}
