/**
 * Windows notification, overlay toast and the user's OWN Discord / Telegram
 * endpoints for a new offer.
 *
 * Safety shape (docs/GGG_COMPLIANCE.md): one POST per new offer per target,
 * ≤ 10 per minute, 10 s timeout, no retries, `redirect: "error"` so a
 * redirected webhook can never deliver the message — or the bot token in the
 * Telegram URL — to another host. The URL / token / chat id live only in
 * `trade-webhooks.secret.json`; `status()` reports booleans, never values,
 * and every error string is redacted.
 */
import {
  NOTIFY_USER_AGENT,
  WebhookRateWindow,
  discordMessage,
  isDiscordWebhookUrl,
  isTelegramBotToken,
  isTelegramChatId,
  notificationBody,
  notificationTitle,
  redactSecrets,
  telegramMessage,
  telegramSendUrl,
} from "../../../core/tradeNotify.js";
import type { NoticePayload } from "../../../shared/overlay.js";
import type {
  TradeOffer,
  TradeSettings,
  TradeWebhookSecretsPatch,
  TradeWebhookStatus,
  TradeWebhookTargetStatus,
} from "../../../shared/trade.js";
import { realTradeFs, type TradeFs } from "./fs.js";

export interface TradeWebhookSecrets {
  discordWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface TradeNotifierOptions {
  secretFile: string;
  settings: () => TradeSettings;
  notify: (title: string, body: string) => void;
  toast: (payload: NoticePayload) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  fs?: TradeFs;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
  onStatus?: (status: TradeWebhookStatus) => void;
}

interface TargetState {
  lastAt?: string;
  lastOk?: boolean;
  lastError?: string;
  window: WebhookRateWindow;
}

export class TradeNotifier {
  private readonly fs: TradeFs;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private secrets: TradeWebhookSecrets = {};
  private readonly discord: TargetState;
  private readonly telegram: TargetState;
  /** Posts per target are serialized so a burst stays in order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TradeNotifierOptions) {
    this.fs = options.fs ?? realTradeFs;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.discord = { window: new WebhookRateWindow(undefined, this.now) };
    this.telegram = { window: new WebhookRateWindow(undefined, this.now) };
    this.load();
  }

  private load(): void {
    let text: string | undefined;
    try {
      text = this.fs.read(this.options.secretFile);
    } catch {
      text = undefined;
    }
    if (!text) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      const source = parsed as Record<string, unknown>;
      const url = typeof source.discordWebhookUrl === "string" ? source.discordWebhookUrl.trim() : "";
      const token = typeof source.telegramBotToken === "string" ? source.telegramBotToken.trim() : "";
      const chatId = typeof source.telegramChatId === "string" ? source.telegramChatId.trim() : "";
      if (url && isDiscordWebhookUrl(url)) this.secrets.discordWebhookUrl = url;
      if (token && isTelegramBotToken(token)) this.secrets.telegramBotToken = token;
      if (chatId && isTelegramChatId(chatId)) this.secrets.telegramChatId = chatId;
    } catch {
      this.options.log?.("warn", "trade webhook secrets file is not readable JSON");
    }
  }

  private targetStatus(target: "discord" | "telegram"): TradeWebhookTargetStatus {
    const settings = this.options.settings().webhooks;
    const state = target === "discord" ? this.discord : this.telegram;
    const configured =
      target === "discord"
        ? Boolean(this.secrets.discordWebhookUrl)
        : Boolean(this.secrets.telegramBotToken && this.secrets.telegramChatId);
    const status: TradeWebhookTargetStatus = {
      enabled: target === "discord" ? settings.discord : settings.telegram,
      configured,
      sentThisMinute: state.window.sentThisMinute(),
    };
    if (state.lastAt) status.lastAt = state.lastAt;
    if (state.lastOk !== undefined) status.lastOk = state.lastOk;
    if (state.lastError) status.lastError = state.lastError;
    return status;
  }

  status(): TradeWebhookStatus {
    return {
      discord: this.targetStatus("discord"),
      telegram: this.targetStatus("telegram"),
      includePlayerName: this.options.settings().webhooks.includePlayerName,
      file: this.options.secretFile,
    };
  }

  /** `null` clears a field; an invalid value throws and nothing is written. */
  setSecrets(patch: TradeWebhookSecretsPatch): TradeWebhookStatus {
    const next: TradeWebhookSecrets = { ...this.secrets };
    if (patch.discordWebhookUrl !== undefined) {
      if (patch.discordWebhookUrl === null || patch.discordWebhookUrl.trim() === "") {
        delete next.discordWebhookUrl;
      } else if (isDiscordWebhookUrl(patch.discordWebhookUrl)) {
        next.discordWebhookUrl = patch.discordWebhookUrl.trim();
      } else {
        throw new Error("trade-webhook-invalid:discordWebhookUrl");
      }
    }
    if (patch.telegramBotToken !== undefined) {
      if (patch.telegramBotToken === null || patch.telegramBotToken.trim() === "") {
        delete next.telegramBotToken;
      } else if (isTelegramBotToken(patch.telegramBotToken)) {
        next.telegramBotToken = patch.telegramBotToken.trim();
      } else {
        throw new Error("trade-webhook-invalid:telegramBotToken");
      }
    }
    if (patch.telegramChatId !== undefined) {
      if (patch.telegramChatId === null || patch.telegramChatId.trim() === "") {
        delete next.telegramChatId;
      } else if (isTelegramChatId(patch.telegramChatId)) {
        next.telegramChatId = patch.telegramChatId.trim();
      } else {
        throw new Error("trade-webhook-invalid:telegramChatId");
      }
    }
    this.secrets = next;
    const empty = !next.discordWebhookUrl && !next.telegramBotToken && !next.telegramChatId;
    try {
      if (empty) this.fs.remove(this.options.secretFile);
      else this.fs.write(this.options.secretFile, JSON.stringify(next));
    } catch (error) {
      this.options.log?.("warn", "trade webhook secrets could not be saved", {
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
    const status = this.status();
    this.options.onStatus?.(status);
    return status;
  }

  private async post(
    target: "discord" | "telegram",
    url: string,
    body: unknown,
    expectTelegramOk: boolean,
  ): Promise<boolean> {
    const state = target === "discord" ? this.discord : this.telegram;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    state.lastAt = new Date(this.now()).toISOString();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": NOTIFY_USER_AGENT },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        state.lastOk = false;
        state.lastError = `HTTP ${response.status}`;
        return false;
      }
      if (expectTelegramOk) {
        const payload: unknown = await response.json().catch(() => undefined);
        const ok = typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === true;
        state.lastOk = ok;
        state.lastError = ok ? undefined : "Telegram refused the message";
        return ok;
      }
      state.lastOk = true;
      state.lastError = undefined;
      return true;
    } catch (error) {
      state.lastOk = false;
      const name = error instanceof Error ? error.name : "Error";
      state.lastError =
        name === "TimeoutError" || name === "AbortError"
          ? "timed out"
          : name === "TypeError"
            ? "redirect refused or endpoint unreachable"
            : redactSecrets(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async test(target: "discord" | "telegram"): Promise<TradeWebhookTargetStatus> {
    const content = "PoE2 Trade Companion: webhook test";
    await this.queue(async () => {
      if (target === "discord") {
        const url = this.secrets.discordWebhookUrl;
        if (!url) {
          this.discord.lastOk = false;
          this.discord.lastError = "not configured";
          return;
        }
        await this.post("discord", url, { content, username: "PoE2 Trade Companion", allowed_mentions: { parse: [] } }, false);
        return;
      }
      const token = this.secrets.telegramBotToken;
      const chatId = this.secrets.telegramChatId;
      if (!token || !chatId) {
        this.telegram.lastOk = false;
        this.telegram.lastError = "not configured";
        return;
      }
      await this.post("telegram", telegramSendUrl(token), { chat_id: chatId, text: content, disable_web_page_preview: true }, true);
    });
    const status = this.status();
    this.options.onStatus?.(status);
    return target === "discord" ? status.discord : status.telegram;
  }

  /**
   * Fires each enabled channel at most once for this offer and reports which
   * ones actually went out; the caller persists the flags on the offer so a
   * restart never re-notifies.
   */
  async announce(
    offer: TradeOffer,
    options: { panelShown: boolean },
  ): Promise<Partial<TradeOffer["notified"]>> {
    const settings = this.options.settings();
    const fired: Partial<TradeOffer["notified"]> = {};
    const opts = { includePlayerName: settings.webhooks.includePlayerName };

    if (settings.notifications.windows && !offer.notified.windows) {
      this.options.notify(notificationTitle(offer), notificationBody(offer));
      fired.windows = true;
    }
    if (settings.notifications.toast && !options.panelShown && !offer.notified.toast) {
      try {
        await this.options.toast({
          title: notificationTitle(offer),
          body: notificationBody(offer),
          tone: "info",
          ttlMs: 8_000,
        });
      } catch {
        // A toast that cannot be shown must not stop the rest of the announce.
      }
      fired.toast = true;
    }
    if (settings.notifications.sound && !offer.notified.sound) fired.sound = true;

    if (settings.webhooks.discord && this.secrets.discordWebhookUrl && !offer.notified.discord) {
      if (this.discord.window.allow()) {
        const url = this.secrets.discordWebhookUrl;
        await this.queue(() => this.post("discord", url, discordMessage(offer, opts), false));
        fired.discord = true;
      } else {
        this.discord.lastError = "rate limit: more than 10 messages a minute, dropped";
      }
    }
    if (
      settings.webhooks.telegram &&
      this.secrets.telegramBotToken &&
      this.secrets.telegramChatId &&
      !offer.notified.telegram
    ) {
      if (this.telegram.window.allow()) {
        const token = this.secrets.telegramBotToken;
        const chatId = this.secrets.telegramChatId;
        await this.queue(() =>
          this.post("telegram", telegramSendUrl(token), telegramMessage(offer, chatId, opts), true),
        );
        fired.telegram = true;
      } else {
        this.telegram.lastError = "rate limit: more than 10 messages a minute, dropped";
      }
    }
    if (fired.discord || fired.telegram) this.options.onStatus?.(this.status());
    return fired;
  }

  dispose(): void {
    this.chain = Promise.resolve();
  }
}
