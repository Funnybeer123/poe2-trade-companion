// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUICK_WHISPERS, type TradeOffer, type TradePanelPayload } from "../../src/shared/trade.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

const sound = vi.hoisted(() => ({ play: vi.fn() }));

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
  getAppFeatureApi: () => null,
}));

vi.mock("../../src/renderer/features/trade/api/useTradeSound", () => ({
  playOfferSound: () => sound.play(),
  isOverlayWindow: () => true,
}));

import TradePanel from "../../src/renderer/features/trade/panels/TradePanel.vue";

function offer(overrides: Partial<TradeOffer> = {}): TradeOffer {
  return {
    id: "offer_1",
    direction: "incoming",
    kind: "item",
    player: "Buyerino",
    at: "2026-09-05T16:37:47.000Z",
    updatedAt: "2026-09-05T16:37:47.000Z",
    repeats: 1,
    item: { name: "Ghoul Lash", baseType: "Long Belt", display: "Ghoul Lash, Long Belt" },
    price: { amount: 1, currency: "exalted", exalted: 1, text: "1 exalted" },
    league: "Forbidden Rites",
    secure: "no",
    language: "en",
    templateTested: true,
    raw: "raw",
    state: "new",
    stateAt: "2026-09-05T16:37:47.000Z",
    transitions: [],
    notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
    ...overrides,
  };
}

function payload(offers: TradeOffer[]): TradePanelPayload {
  return {
    offers,
    status: {
      enabled: true,
      clientLog: { watching: true },
      divineRate: 500,
      divineRateSource: "price-table",
      activeOffers: offers.length,
      dryRun: false,
      poeRunning: true,
      panelVisible: true,
      panelPinned: false,
      panelFocused: false,
      chat: { enabled: true, hostRunning: true, sentThisMinute: 0, maxPerMinute: 30, dryRun: false },
    },
    settings: {
      compact: false,
      autoExpandInTown: true,
      invertedOrder: false,
      quickWhispers: [...DEFAULT_QUICK_WHISPERS],
    },
  };
}

function mountPanel(offers: TradeOffer[] = [offer()], seed: TradePanelPayload = payload(offers)) {
  return mount(TradePanel, {
    props: { panelId: "trade", payload: seed, visible: true },
  });
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe("TradePanel", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.listeners.clear();
    sound.play.mockReset();
    bridge.invoke.mockReset().mockImplementation((channel: string) => {
      if (channel === "trade:offers") return Promise.resolve([offer()]);
      if (channel === "trade:offer-action") return Promise.resolve({ ok: true, offer: offer() });
      if (channel === "trade:panel-focus") return Promise.resolve(payload([]).status);
      return Promise.resolve(undefined);
    });
  });

  it("renders the seeded active offers and never opens a panel itself", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Buyerino");
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("says so when there is nothing to answer", () => {
    const wrapper = mountPanel([offer({ state: "dismissed", stateAt: "2020-01-01T00:00:00.000Z" })]);
    expect(wrapper.text()).toContain("No active offers");
    wrapper.unmount();
  });

  it("forces compact cards above three offers", () => {
    const many = [1, 2, 3, 4].map((index) => offer({ id: `offer_${index}`, player: `Buyer${index}` }));
    const wrapper = mountPanel(many);
    expect(wrapper.findAll(".trade-offer.compact")).toHaveLength(4);
    wrapper.unmount();
  });

  it("sends actions with the overlay origin", async () => {
    const wrapper = mountPanel();
    await buttonByText(wrapper, "Invite").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:offer-action", "offer_1", { kind: "invite" }, "overlay");
    wrapper.unmount();
  });

  it("says why a line was refused instead of going silent", async () => {
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "trade:offers") return Promise.resolve([offer()]);
      if (channel === "trade:offer-action") {
        return Promise.resolve({
          ok: false,
          offer: offer(),
          chat: { ok: false, dryRun: false, blockedBy: "not-foreground", at: "x" },
        });
      }
      return Promise.resolve(undefined);
    });
    const wrapper = mountPanel();
    await buttonByText(wrapper, "Invite").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("click the game first");
    wrapper.unmount();
  });

  it("reports a dry-run preview as status, not as an alert", async () => {
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "trade:offers") return Promise.resolve([offer()]);
      if (channel === "trade:offer-action") {
        return Promise.resolve({
          ok: true,
          offer: offer(),
          chat: { ok: true, dryRun: true, sent: "/invite Buyerino", at: "x" },
        });
      }
      return Promise.resolve(undefined);
    });
    const wrapper = mountPanel();
    await buttonByText(wrapper, "Invite").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[role="status"]').text()).toContain("would type /invite Buyerino");
    wrapper.unmount();
  });

  it("re-reads the status when the chat service announces one", async () => {
    const disabled = payload([offer()]).status;
    disabled.chat = { enabled: false, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false };
    bridge.invoke.mockImplementation((channel: string) => {
      if (channel === "trade:status") return Promise.resolve(disabled);
      return Promise.resolve(undefined);
    });
    const wrapper = mountPanel();
    expect(buttonByText(wrapper, "Invite").attributes("disabled")).toBeUndefined();
    bridge.listeners.get("chat:status")?.(disabled.chat);
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:status");
    expect(buttonByText(wrapper, "Invite").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("explains a disabled chat service on the in-game buttons", () => {
    const seed = payload([offer()]);
    seed.status = {
      ...seed.status,
      chat: { enabled: false, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false },
    };
    const wrapper = mountPanel([offer()], seed);
    const invite = buttonByText(wrapper, "Invite");
    expect(invite.attributes("disabled")).toBeDefined();
    expect(invite.attributes("title")).toContain("Chat commands are disabled");
    wrapper.unmount();
  });

  it("takes and releases keyboard focus around the custom whisper", async () => {
    const wrapper = mountPanel();
    await buttonByText(wrapper, "Custom…").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:panel-focus", true);
    await wrapper.find(".custom-whisper input").trigger("keydown.esc");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:panel-focus", false);
    wrapper.unmount();
  });

  it("follows trade:changed and beeps only for its own window", async () => {
    const wrapper = mountPanel();
    bridge.listeners.get("trade:changed")?.([offer({ id: "offer_2", player: "Otherguy" })]);
    await flushPromises();
    expect(wrapper.text()).toContain("Otherguy");

    bridge.listeners.get("trade:offer")?.({ offer: offer(), reason: "new", playSoundIn: "main" });
    expect(sound.play).not.toHaveBeenCalled();
    bridge.listeners.get("trade:offer")?.({ offer: offer(), reason: "new", playSoundIn: "overlay" });
    expect(sound.play).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("invokes nothing without the bridge", () => {
    bridge.available = false;
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("needs the desktop app");
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
