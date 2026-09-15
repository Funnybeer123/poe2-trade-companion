// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TradeOfferCard from "../../src/renderer/features/trade/components/TradeOfferCard.vue";
import { DEFAULT_QUICK_WHISPERS, type TradeOffer } from "../../src/shared/trade.js";

const OFFER: TradeOffer = {
  id: "offer_1",
  direction: "incoming",
  kind: "item",
  player: "Buyerino",
  at: "2026-09-05T16:37:47.000Z",
  updatedAt: "2026-09-05T16:37:47.000Z",
  repeats: 2,
  item: { name: "Ghoul Lash", baseType: "Long Belt", display: "Ghoul Lash, Long Belt" },
  price: {
    amount: 1.5,
    currency: "divine",
    currencyId: "divine",
    exalted: 750,
    text: "1.5 divine",
    split: { parts: [], rate: 500, rateSource: "price-table", text: "1 div + 250 ex" },
  },
  league: "Forbidden Rites",
  leagueMatches: false,
  stash: { tab: "~price 1 exalted", left: 10, top: 10 },
  secure: "maybe",
  language: "ru",
  templateTested: false,
  raw: "raw",
  state: "new",
  stateAt: "2026-09-05T16:37:47.000Z",
  transitions: [],
  notified: { windows: false, toast: false, sound: false, discord: false, telegram: false },
};

function mountCard(props: Partial<Record<string, unknown>> = {}) {
  return mount(TradeOfferCard, {
    props: {
      offer: OFFER,
      compact: false,
      expanded: true,
      quickWhispers: [...DEFAULT_QUICK_WHISPERS],
      busy: false,
      dryRun: false,
      chatEnabled: true,
      origin: "desktop",
      divineRate: 500,
      divineRateSource: "price-table",
      now: Date.parse("2026-09-05T16:40:47.000Z"),
      ...props,
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe("TradeOfferCard", () => {
  it("shows who, what, how much and every warning chip", () => {
    const wrapper = mountCard();
    expect(wrapper.text()).toContain("Buyer");
    expect(wrapper.text()).toContain("Buyerino");
    expect(wrapper.text()).toContain("Ghoul Lash, Long Belt");
    expect(wrapper.text()).toContain("1.5 divine ≈ 1 div + 250 ex");
    expect(wrapper.text()).toContain("~price 1 exalted");
    expect(wrapper.text()).toContain("×2");
    expect(wrapper.text()).toContain("wrong league");
    expect(wrapper.text()).toContain("Secure?");
    expect(wrapper.text()).toContain("untested template");
    expect(wrapper.find(".trade-price").attributes("title")).toContain("estimate");
    wrapper.unmount();
  });

  it("hides the body until a compact card is expanded", async () => {
    const wrapper = mountCard({ compact: true, expanded: false });
    expect(wrapper.text()).not.toContain("Ghoul Lash, Long Belt");
    await wrapper.find(".trade-offer-head").trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
    await wrapper.find(".trade-offer").trigger("keydown.enter");
    expect(wrapper.emitted("toggle")).toHaveLength(2);
    wrapper.unmount();
  });

  it("emits one action per button", async () => {
    const wrapper = mountCard();
    await buttonByText(wrapper, "Invite").trigger("click");
    await buttonByText(wrapper, "Highlight").trigger("click");
    await buttonByText(wrapper, "Dismiss").trigger("click");
    expect(wrapper.emitted("action")).toEqual([
      [{ kind: "invite" }],
      [{ kind: "highlight" }],
      [{ kind: "dismiss" }],
    ]);
    wrapper.unmount();
  });

  it("disables the game buttons with a reason when chat is off", () => {
    const wrapper = mountCard({ chatEnabled: false, chatDisabledReason: "Chat commands are disabled" });
    const invite = buttonByText(wrapper, "Invite");
    expect(invite.attributes("disabled")).toBeDefined();
    expect(invite.attributes("title")).toBe("Chat commands are disabled");
    wrapper.unmount();
  });

  it("labels every typing button as a dry run", () => {
    const wrapper = mountCard({ dryRun: true });
    expect(wrapper.text()).toContain("Invite (dry-run)");
    wrapper.unmount();
  });

  it("only offers the quick whispers meant for this direction", () => {
    const wrapper = mountCard();
    const labels = wrapper.findAll(".whisper-list button").map((button) => button.text());
    expect(labels).toContain("Wait");
    expect(labels).toContain("Sold");
    expect(labels).not.toContain("Ready");
    wrapper.unmount();
  });

  it("sends a custom whisper with Ctrl+Enter and copies without touching the game", async () => {
    const wrapper = mountCard();
    await buttonByText(wrapper, "Custom…").trigger("click");
    await wrapper.find(".custom-whisper input").setValue("omw");
    await wrapper.find(".custom-whisper input").trigger("keydown.ctrl.enter");
    expect(wrapper.emitted("action")?.at(-1)).toEqual([{ kind: "custom-whisper", text: "omw" }]);
    await buttonByText(wrapper, "Copy whisper line").trigger("click");
    expect(wrapper.emitted("action")?.at(-1)).toEqual([{ kind: "copy-whisper" }]);
    wrapper.unmount();
  });

  it("asks the overlay for focus while the custom input is open", async () => {
    const wrapper = mountCard({ origin: "overlay" });
    await buttonByText(wrapper, "Custom…").trigger("click");
    expect(wrapper.emitted("focusRequest")).toEqual([[true]]);
    await wrapper.find(".custom-whisper input").trigger("keydown.esc");
    await flushPromises();
    expect(wrapper.emitted("focusRequest")).toEqual([[true], [false]]);
    wrapper.unmount();
  });

  it("offers Reopen instead of Invite once the card is finished", () => {
    const wrapper = mountCard({ offer: { ...OFFER, state: "completed" } });
    expect(wrapper.findAll("button").map((button) => button.text())).toContain("Reopen");
    expect(wrapper.findAll("button").map((button) => button.text())).not.toContain("Invite");
    wrapper.unmount();
  });
});
