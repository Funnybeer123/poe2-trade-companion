// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TradeHistoryView,
  TradeOffer,
  TradeSettings,
  TradeStatus,
} from "../../src/shared/trade.js";
import { DEFAULT_TRADE_SETTINGS } from "../../src/shared/trade.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
  appInvoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
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

vi.mock("vue-router", () => ({ useRoute: () => ({ hash: "" }) }));

import TradeView from "../../src/renderer/features/trade/views/TradeView.vue";

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
  secure: "no",
  language: "en",
  templateTested: true,
  raw: "raw",
  state: "new",
  stateAt: "2026-09-05T16:37:47.000Z",
  transitions: [],
  notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
};

function status(overrides: Partial<TradeStatus> = {}): TradeStatus {
  return {
    enabled: true,
    clientLog: { watching: true, file: "C:/logs/Client.txt" },
    divineRate: 500,
    divineRateSource: "price-table",
    feedAgeHours: 3.2,
    activeOffers: 1,
    dryRun: false,
    poeRunning: true,
    panelVisible: false,
    panelPinned: false,
    panelFocused: false,
    league: "Forbidden Rites",
    chat: { enabled: true, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false },
    ...overrides,
  };
}

function historyView(): TradeHistoryView {
  return {
    entries: [
      {
        id: "th_1",
        at: "2026-09-05T16:39:10.000Z",
        kind: "sale",
        player: "Buyerino",
        item: { name: "Ghoul Lash" },
        price: { amount: 1, currency: "exalted", exalted: 1 },
        secure: "no",
        matched: "offer",
      },
    ],
    totals: {
      count: 1,
      sales: 1,
      purchases: 0,
      unknown: 0,
      earningsExalted: 1,
      spendingsExalted: 0,
      profitExalted: 1,
      byCurrency: { exalted: { sales: 1, purchases: 0 } },
      divineRate: 500,
      divineRateSource: "price-table",
      unpriced: 0,
    },
    retentionDays: 14,
    file: "C:/user/trade-history.json",
    shopLedger: { file: "C:/cfg/listings.jsonl", imported: 0 },
  };
}

function settings(overrides: Partial<TradeSettings> = {}): TradeSettings {
  return { ...DEFAULT_TRADE_SETTINGS, ...overrides };
}

let currentStatus = status();
let currentSettings = settings();

function answer(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case "trade:offers":
      return Promise.resolve([OFFER]);
    case "trade:status":
      return Promise.resolve(currentStatus);
    case "trade:history":
    case "trade:history-save":
    case "trade:history-delete":
      return Promise.resolve(historyView());
    case "trade:history-export":
      return Promise.resolve({ ok: true, rows: 1, path: "C:/docs/out.csv" });
    case "trade:offer-action":
      return Promise.resolve({ ok: true, offer: OFFER, chat: { ok: true, dryRun: false, sent: String(args[1]), at: "x" } });
    case "trade:panel":
      return Promise.resolve(currentStatus);
    default:
      return Promise.resolve(undefined);
  }
}

async function mountView() {
  const wrapper = mount(TradeView);
  await flushPromises();
  return wrapper;
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe("TradeView", () => {
  beforeEach(() => {
    bridge.available = true;
    currentStatus = status();
    currentSettings = settings();
    bridge.listeners.clear();
    bridge.invoke.mockReset().mockImplementation(answer);
    bridge.appInvoke.mockReset().mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "settings:get") return Promise.resolve({ trade: currentSettings });
      if (channel === "settings:set") return Promise.resolve({ ...currentSettings, ...(args[1] as object) });
      return Promise.resolve(undefined);
    });
  });

  it("is a desktop-only notice without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("needs the desktop app");
    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads the offers, the status and the readiness list", async () => {
    const wrapper = await mountView();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:offers");
    expect(bridge.invoke).toHaveBeenCalledWith("trade:status");
    expect(wrapper.text()).toContain("Buyerino");
    expect(wrapper.text()).toContain("Client.txt");
    expect(wrapper.text()).toContain("Pricing league");
    expect(wrapper.text()).toContain("Divine rate");
    wrapper.unmount();
  });

  it("runs an action from the desktop and shows what was typed", async () => {
    const wrapper = await mountView();
    await buttonByText(wrapper, "Invite").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:offer-action", "offer_1", { kind: "invite" }, "desktop");
    expect(wrapper.find('[role="status"]').text()).toContain("Typed");
    wrapper.unmount();
  });

  it("explains a blocked line in the user's words", async () => {
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "trade:offer-action") {
        return Promise.resolve({
          ok: false,
          offer: OFFER,
          chat: { ok: false, dryRun: false, blockedBy: "not-foreground", at: "x" },
        });
      }
      return answer(channel, ...args);
    });
    const wrapper = await mountView();
    await buttonByText(wrapper, "Invite").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="status"]').text()).toContain("click the game first");
    wrapper.unmount();
  });

  it("shows the history totals, edits and exports", async () => {
    const wrapper = await mountView();
    await buttonByText(wrapper, "History").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:history");
    expect(wrapper.text()).toContain("Earnings");
    expect(wrapper.text()).toContain("≈ 1 ex");

    await buttonByText(wrapper, "Export CSV (includes player names)…").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:history-export", "file");

    await buttonByText(wrapper, "Edit").trigger("click");
    await wrapper.find("form.history-edit").trigger("submit");
    await flushPromises();
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "trade:history-save")).toBe(true);

    await buttonByText(wrapper, "Delete").trigger("click");
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "trade:history-delete")).toBe(false);
    await buttonByText(wrapper, "Confirm").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("trade:history-delete", "th_1");
    wrapper.unmount();
  });

  it("saves the everyday settings and never shows a secret input", async () => {
    const wrapper = await mountView();
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0);
    const compact = wrapper.findAll('input[type="checkbox"]')[0];
    await compact.setValue(true);
    await buttonByText(wrapper, "Save settings").trigger("click");
    await flushPromises();
    expect(bridge.appInvoke.mock.calls.some(([channel]) => channel === "settings:set")).toBe(true);
    wrapper.unmount();
  });

  it("warns about a template that cannot be typed or would hit local chat", async () => {
    currentSettings = settings({
      quickWhispers: [
        { id: "bad", label: "Bad", template: "hello there", show: "both" },
        { id: "accent", label: "Accent", template: "@{player} café", show: "both" },
      ],
    });
    const wrapper = await mountView();
    const text = wrapper.findAll('[role="alert"]').map((node) => node.text()).join(" ");
    expect(text).toContain("must start with @{player} or /");
    expect(text).toContain("cannot type");
    wrapper.unmount();
  });

  it("keeps working and shows a warning when Client.txt is not watched", async () => {
    currentStatus = status({ clientLog: { watching: false, error: "no file found" } });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Client.txt is not being watched");
    expect(wrapper.text()).toContain("Buyerino");
    wrapper.unmount();
  });

  it("reports a thrown bridge error instead of hanging on the spinner", async () => {
    bridge.invoke.mockRejectedValue(new Error("ipc down"));
    const wrapper = await mountView();
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBe("ipc down");
    wrapper.unmount();
  });

  it("re-reads the status when the chat service announces one", async () => {
    const wrapper = await mountView();
    expect(buttonByText(wrapper, "Invite").attributes("disabled")).toBeUndefined();

    // The user turns chat commands off in Tools → Settings while /trade is
    // open: the readiness row and the buttons must follow, not go stale.
    currentStatus = status({
      chat: { enabled: false, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false },
    });
    bridge.listeners.get("chat:status")?.(currentStatus.chat);
    await flushPromises();

    const invite = buttonByText(wrapper, "Invite");
    expect(invite.attributes("disabled")).toBeDefined();
    expect(invite.attributes("title")).toContain("Chat commands are disabled");
    expect(wrapper.text()).toContain("disabled in Tools → Settings");
    wrapper.unmount();
  });

  it("follows the trade:changed event", async () => {
    const wrapper = await mountView();
    bridge.listeners.get("trade:changed")?.([{ ...OFFER, id: "offer_2", player: "Otherguy" }]);
    await flushPromises();
    expect(wrapper.text()).toContain("Otherguy");
    wrapper.unmount();
  });
});
