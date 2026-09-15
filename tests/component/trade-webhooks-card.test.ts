// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRADE_SETTINGS, type TradeWebhookStatus } from "../../src/shared/trade.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  appInvoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
  getAppFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.appInvoke(channel, ...args),
          on: () => () => undefined,
        }
      : null,
}));

import TradeWebhooksCard from "../../src/renderer/features/trade/components/TradeWebhooksCard.vue";

const URL_OK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345";

function webhookStatus(overrides: Partial<TradeWebhookStatus> = {}): TradeWebhookStatus {
  return {
    discord: { enabled: false, configured: false, sentThisMinute: 0 },
    telegram: { enabled: false, configured: false, sentThisMinute: 0, lastOk: false, lastError: "HTTP 404" },
    includePlayerName: true,
    file: "C:/user/trade-webhooks.secret.json",
    ...overrides,
  };
}

async function mountCard() {
  const wrapper = mount(TradeWebhooksCard);
  await flushPromises();
  return wrapper;
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe("TradeWebhooksCard", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.listeners.clear();
    bridge.invoke.mockReset().mockImplementation((channel: string) => {
      if (channel === "trade:webhooks" || channel === "trade:webhooks-set") {
        return Promise.resolve(webhookStatus());
      }
      if (channel === "trade:webhooks-test") {
        return Promise.resolve({ enabled: true, configured: true, sentThisMinute: 1, lastOk: true });
      }
      if (channel === "trade:offers") return Promise.resolve([]);
      if (channel === "trade:status") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    bridge.appInvoke.mockReset().mockImplementation((channel: string) => {
      if (channel === "settings:get") return Promise.resolve({ trade: DEFAULT_TRADE_SETTINGS });
      return Promise.resolve(DEFAULT_TRADE_SETTINGS);
    });
  });

  it("is a desktop-only notice without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain("need the desktop app");
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("hides what the user types and explains where it is stored", async () => {
    const wrapper = await mountCard();
    const secrets = wrapper.findAll('input[type="password"]');
    expect(secrets.length).toBe(3);
    for (const input of secrets) expect(input.attributes("autocomplete")).toBe("off");
    expect(wrapper.text()).toContain("trade-webhooks.secret.json");
    expect(wrapper.text()).toContain("character name");
    wrapper.unmount();
  });

  it("saves the URL and clears the field afterwards", async () => {
    const wrapper = await mountCard();
    const input = wrapper.findAll('input[type="password"]')[0];
    await input.setValue(URL_OK);
    await buttonByText(wrapper, "Save webhooks").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:webhooks-set", { discordWebhookUrl: URL_OK });
    expect((input.element as HTMLInputElement).value).toBe("");
    wrapper.unmount();
  });

  it("writes the player-name choice into the trade settings", async () => {
    const wrapper = await mountCard();
    const checkboxes = wrapper.findAll('input[type="checkbox"]');
    await checkboxes[2].setValue(false);
    await flushPromises();
    expect(bridge.appInvoke).toHaveBeenCalledWith("settings:set", "trade", {
      webhooks: { discord: false, telegram: false, includePlayerName: false },
    });
    wrapper.unmount();
  });

  it("sends one test message and shows what came back", async () => {
    const wrapper = await mountCard();
    await buttonByText(wrapper, "Test Discord").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:webhooks-test", "discord");
    expect(wrapper.find('[role="status"]').text()).toContain("accepted the test message");
    wrapper.unmount();
  });

  it("shows a failure without ever printing the endpoint", async () => {
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain("HTTP 404");
    expect(wrapper.text()).not.toContain("abcdefghij");
    wrapper.unmount();
  });
});
