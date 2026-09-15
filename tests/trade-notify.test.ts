import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookRateWindow,
  discordMessage,
  isDiscordWebhookUrl,
  isTelegramBotToken,
  isTelegramChatId,
  notificationBody,
  notificationTitle,
  redactSecrets,
  redactSecretsDeep,
  telegramMessage,
  telegramSendUrl,
  webhookText,
} from "../src/core/tradeNotify.js";
import { memoryTradeFs } from "../src/main/features/trade/fs.js";
import { TradeNotifier } from "../src/main/features/trade/notifier.js";
import { DEFAULT_TRADE_SETTINGS, type TradeOffer, type TradeSettings } from "../src/shared/trade.js";

const URL_OK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";
const TOKEN_OK = "1234567:abcdefghijklmnopqrstuvwxyz0123456789";

const OFFER: TradeOffer = {
  id: "offer_1",
  direction: "incoming",
  kind: "item",
  player: "Buyerino",
  at: "2026-09-05T16:37:47.000Z",
  updatedAt: "2026-09-05T16:37:47.000Z",
  repeats: 1,
  item: { name: "Ghoul Lash", baseType: "Long Belt", display: "Ghoul Lash, Long Belt" },
  price: { amount: 1, currency: "exalted", currencyId: "exalted", exalted: 1, text: "1 exalted" },
  league: "Forbidden Rites",
  stash: { tab: "~price 1 exalted", left: 10, top: 10 },
  secure: "no",
  language: "en",
  templateTested: true,
  raw: "raw whisper",
  state: "new",
  stateAt: "2026-09-05T16:37:47.000Z",
  transitions: [],
  notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
};

function settingsWith(overrides: Partial<TradeSettings> = {}): TradeSettings {
  return { ...DEFAULT_TRADE_SETTINGS, ...overrides };
}

describe("notification text", () => {
  it("names the counterpart and the item", () => {
    expect(notificationTitle(OFFER)).toBe("Trade offer from Buyerino");
    expect(notificationTitle({ ...OFFER, direction: "outgoing" })).toBe("You whispered Buyerino");
    expect(notificationBody(OFFER)).toContain("Ghoul Lash, Long Belt · 1 exalted · Forbidden Rites");
  });

  it("keeps the webhook line inside the limits and marks the estimate", () => {
    const text = webhookText(
      {
        ...OFFER,
        price: {
          amount: 1.5,
          currency: "divine",
          currencyId: "divine",
          exalted: 750,
          text: "1.5 divine",
          split: { parts: [], rate: 500, rateSource: "price-table", text: "1 div + 250 ex" },
        },
      },
      { includePlayerName: true },
    );
    expect(text).toContain("≈ 1 div + 250 ex");
    expect(text.length).toBeLessThanOrEqual(300);
    const discord = discordMessage(OFFER, { includePlayerName: true });
    expect(discord.allowed_mentions.parse).toEqual([]);
    expect(discord.content.length).toBeLessThanOrEqual(2_000);
    const telegram = telegramMessage(OFFER, "-100123", { includePlayerName: true });
    expect(telegram.chat_id).toBe("-100123");
    expect(telegram.disable_web_page_preview).toBe(true);
  });

  it("strips the counterpart's name when asked", () => {
    const text = webhookText(OFFER, { includePlayerName: false });
    expect(text).not.toContain("Buyerino");
    expect(discordMessage(OFFER, { includePlayerName: false }).content).not.toContain("Buyerino");
    expect(telegramMessage(OFFER, "1", { includePlayerName: false }).text).not.toContain("Buyerino");
  });
});

describe("validators and redaction", () => {
  it("accepts only the real endpoints", () => {
    expect(isDiscordWebhookUrl(URL_OK)).toBe(true);
    expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/abcdefghijklmnopqrst")).toBe(false);
    expect(isDiscordWebhookUrl("http://discord.com/api/webhooks/1/abcdefghijklmnopqrst")).toBe(false);
    expect(isTelegramBotToken(TOKEN_OK)).toBe(true);
    expect(isTelegramBotToken("123:short")).toBe(false);
    expect(isTelegramChatId("-1001234567890")).toBe(true);
    expect(isTelegramChatId("@mychannel")).toBe(true);
    expect(isTelegramChatId("nope")).toBe(false);
    expect(telegramSendUrl(TOKEN_OK)).toBe(`https://api.telegram.org/bot${TOKEN_OK}/sendMessage`);
  });

  it("masks a webhook url or bot token anywhere", () => {
    expect(redactSecrets(`POST ${URL_OK} failed`)).not.toContain("abcdefghij");
    expect(redactSecrets(`bot${TOKEN_OK} refused`)).not.toContain(TOKEN_OK);
    const deep = redactSecretsDeep({
      url: URL_OK,
      list: [new Error(`sending to ${URL_OK}`)],
      count: 3,
      ok: true,
    }) as { url: string; list: string[]; count: number; ok: boolean };
    expect(deep.url).toBe("[redacted]");
    expect(deep.list[0]).not.toContain("abcdefghij");
    expect(deep.count).toBe(3);
    expect(deep.ok).toBe(true);
  });

  it("drops the eleventh post in a minute", () => {
    let clock = 0;
    const window = new WebhookRateWindow(10, () => clock);
    for (let index = 0; index < 10; index += 1) expect(window.allow()).toBe(true);
    expect(window.allow()).toBe(false);
    expect(window.sentThisMinute()).toBe(10);
    clock += 61_000;
    expect(window.allow()).toBe(true);
  });
});

describe("TradeNotifier", () => {
  const secretFile = "C:/user/trade-webhooks.secret.json";
  let fetchImpl: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.fn>;

  function notifier(settings: TradeSettings, files: Record<string, string> = {}) {
    const fs = memoryTradeFs(files);
    const instance = new TradeNotifier({
      secretFile,
      settings: () => settings,
      notify,
      toast,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
      fs,
      log: vi.fn(),
    });
    return { instance, fs };
  }

  beforeEach(() => {
    fetchImpl = vi.fn(async () => new Response("{\"ok\":true}", { status: 200 }));
    notify = vi.fn();
    toast = vi.fn(async () => undefined);
  });

  it("fires each enabled channel once and reports what went out", async () => {
    const settings = settingsWith({ webhooks: { discord: true, telegram: true, includePlayerName: true } });
    const { instance } = notifier(settings, {
      [secretFile]: JSON.stringify({ discordWebhookUrl: URL_OK, telegramBotToken: TOKEN_OK, telegramChatId: "-100" }),
    });
    const fired = await instance.announce(OFFER, { panelShown: false });
    expect(fired).toEqual({ windows: true, toast: true, sound: true, discord: true, telegram: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].redirect).toBe("error");
      expect(call[1].signal).toBeDefined();
    }
    const already = { ...OFFER, notified: { windows: true, toast: true, sound: true, discord: true, telegram: true } };
    await instance.announce(already, { panelShown: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips the toast when the panel was shown and posts nothing when unconfigured", async () => {
    const settings = settingsWith({ webhooks: { discord: true, telegram: true, includePlayerName: true } });
    const { instance } = notifier(settings);
    const fired = await instance.announce(OFFER, { panelShown: true });
    expect(fired.toast).toBeUndefined();
    expect(toast).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failure without ever printing the endpoint", async () => {
    fetchImpl.mockResolvedValue(new Response("nope", { status: 404 }));
    const settings = settingsWith({ webhooks: { discord: true, telegram: false, includePlayerName: true } });
    const { instance } = notifier(settings, { [secretFile]: JSON.stringify({ discordWebhookUrl: URL_OK }) });
    await instance.announce(OFFER, { panelShown: true });
    const status = instance.status();
    expect(status.discord.lastOk).toBe(false);
    expect(status.discord.lastError).toBe("HTTP 404");
    expect(JSON.stringify(status)).not.toContain("abcdefghij");
  });

  it("turns a refused redirect into a plain error", async () => {
    fetchImpl.mockRejectedValue(new TypeError("redirect count exceeded"));
    const settings = settingsWith({ webhooks: { discord: true, telegram: false, includePlayerName: true } });
    const { instance } = notifier(settings, { [secretFile]: JSON.stringify({ discordWebhookUrl: URL_OK }) });
    await instance.announce(OFFER, { panelShown: true });
    expect(instance.status().discord.lastError).toContain("redirect refused");
  });

  it("drops the eleventh offer of a minute instead of queueing it", async () => {
    const settings = settingsWith({ webhooks: { discord: true, telegram: false, includePlayerName: true } });
    const { instance } = notifier(settings, { [secretFile]: JSON.stringify({ discordWebhookUrl: URL_OK }) });
    for (let index = 0; index < 11; index += 1) {
      await instance.announce({ ...OFFER, id: `offer_${index}` }, { panelShown: true });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(instance.status().discord.lastError).toContain("rate limit");
  });

  it("writes, validates and removes the secret file", () => {
    const settings = settingsWith();
    const { instance, fs } = notifier(settings);
    expect(() => instance.setSecrets({ discordWebhookUrl: "https://evil.example/hook" })).toThrow(
      "trade-webhook-invalid:discordWebhookUrl",
    );
    expect(fs.files.has(secretFile)).toBe(false);
    const status = instance.setSecrets({ discordWebhookUrl: URL_OK });
    expect(status.discord.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("abcdefghij");
    expect(fs.files.get(secretFile)).toContain("discordWebhookUrl");
    instance.setSecrets({ discordWebhookUrl: null });
    expect(fs.files.has(secretFile)).toBe(false);
  });

  it("sends exactly one test message", async () => {
    const settings = settingsWith({ webhooks: { discord: true, telegram: false, includePlayerName: true } });
    const { instance } = notifier(settings, { [secretFile]: JSON.stringify({ discordWebhookUrl: URL_OK }) });
    const result = await instance.test("discord");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain("webhook test");
    expect(result.lastOk).toBe(true);
    const unconfigured = await instance.test("telegram");
    expect(unconfigured.lastError).toBe("not configured");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
