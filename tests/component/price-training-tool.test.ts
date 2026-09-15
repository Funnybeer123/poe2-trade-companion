// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTrainingPrice } from "../../src/core/priceTraining.js";
import type { PriceLesson, PriceLessonInput, PriceTrainingOverview, PriceTrainingPreview, TrainingMarketResult } from "../../src/shared/priceTraining.js";

const bridge = vi.hoisted(() => ({ available: true, invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>() }));
vi.mock("../../src/renderer/features/priceTraining/api", () => ({ getPriceTrainingApi: () => bridge.available ? { invoke: bridge.invoke } : null }));
import PriceTrainingTool from "../../src/renderer/features/priceTraining/PriceTrainingTool.vue";

const RAW = readFileSync(path.resolve("fixtures/evaluate/rare-ring-resists.txt"), "utf8");
const NOW = "2026-09-14T12:00:00.000Z";
const INPUT: PriceLessonInput = { itemText: RAW, league: "Forbidden Rites", amount: 1, currency: "divine", evidence: "estimate", scope: "exact" };
const LESSON: PriceLesson = { ...INPUT, id: "lesson-1", createdAt: NOW, updatedAt: NOW };
const MARKET: TrainingMarketResult = {
  ok: true, cached: false, league: INPUT.league, fetchedAt: NOW, expiresAt: "2026-09-14T13:00:00Z",
  summary: { sampleSize: 3, candidateCount: 5, lowest: 50, median: 80, currency: "exalted", basis: "stat-filtered", comps: [
    { price: 50, similarity: 1, name: "A", baseType: "Ruby Ring" },
    { price: 80, similarity: 1, name: "B", baseType: "Ruby Ring" },
    { price: 100, similarity: 1, name: "C", baseType: "Ruby Ring" },
  ] },
};
let view: PriceTrainingOverview;
const wrappers: VueWrapper[] = [];

function preview(raw = RAW, league = INPUT.league): PriceTrainingPreview {
  return { estimate: estimateTrainingPrice(raw, league, view.lessons, new Date(NOW)), budget: view.budget };
}
function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
async function render(props: { initialItemText?: string } = {}) {
  const wrapper = mount(PriceTrainingTool, { props, attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
async function paste(wrapper: VueWrapper, raw = RAW) {
  await wrapper.get('[name="itemText"]').setValue(raw);
  await vi.advanceTimersByTimeAsync(251);
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.available = true;
  view = {
    lessons: [], review: [], league: INPUT.league,
    budget: { league: INPUT.league, leagueAmbiguous: false, lookups: 3, busy: false },
  };
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    switch (channel) {
      case "price-training:overview": return structuredClone(view);
      case "price-training:preview": {
        const input = args[0] as { itemText: string; league: string };
        return preview(input.itemText, input.league);
      }
      case "price-training:save": {
        const input = args[0] as PriceLessonInput;
        const lesson = { ...input, id: args[1] as string | undefined ?? "saved-1", createdAt: NOW, updatedAt: NOW };
        view.lessons = [...view.lessons.filter((item) => item.id !== lesson.id), lesson];
        return lesson;
      }
      case "price-training:remove": view.lessons = view.lessons.filter((lesson) => lesson.id !== args[0]); return;
      case "price-training:dismiss-review": view.review = view.review.filter((item) => item.id !== args[0]); return;
      case "price-training:check-market": return { market: MARKET, budget: view.budget };
      default: throw new Error(`Unexpected channel ${channel}`);
    }
  });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Price training tool", () => {
  it("loads and previews locally, then saves explicit estimate/exact defaults", async () => {
    const wrapper = await render();
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("price-training:overview");
    await paste(wrapper);
    expect(wrapper.get<HTMLSelectElement>('[name="evidence"]').element.value).toBe("estimate");
    expect(wrapper.get<HTMLSelectElement>('[name="scope"]').element.value).toBe("exact");
    await wrapper.get('[name="amount"]').setValue("1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("price-training:save", INPUT, undefined);
    expect(wrapper.text()).toContain("Example saved");
    expect(wrapper.text()).toContain("Evidence strength 40/100");
    expect(wrapper.text()).toContain("Your estimate");
    expect(bridge.invoke.mock.calls.every(([channel]) => channel !== "price-training:check-market" && !channel.startsWith("evaluate:"))).toBe(true);
  });

  it("rejects empty, negative and zero prices without saving", async () => {
    const wrapper = await render();
    await paste(wrapper);
    for (const amount of ["", "-1", "0"]) {
      await wrapper.get('[name="amount"]').setValue(amount);
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain("greater than zero");
    }
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "price-training:save")).toBe(false);
  });

  it("loads a review into an unsaved exact estimate and resolves it only after save", async () => {
    view.review = [{ id: "r-1", itemText: RAW, league: INPUT.league, fingerprint: "f", groupKey: "g", reason: "Unknown price", firstSeen: NOW, lastSeen: NOW, seenCount: 2 }];
    const wrapper = await render();
    await button(wrapper, "Review item").trigger("click");
    await vi.advanceTimersByTimeAsync(251);
    expect(wrapper.get<HTMLTextAreaElement>('[name="itemText"]').element.value).toBe(RAW);
    expect(wrapper.get<HTMLSelectElement>('[name="evidence"]').element.value).toBe("estimate");
    expect(wrapper.get<HTMLInputElement>('[name="amount"]').element.value).toBe("");
    expect(bridge.invoke.mock.calls.some(([channel]) => /save|dismiss|check-market/.test(channel))).toBe(false);
    await wrapper.get('[name="amount"]').setValue("1");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("price-training:dismiss-review", "r-1");
    expect(wrapper.text()).toContain("No items waiting for review");
  });

  it("requires an explicit league for an unassigned review", async () => {
    view.review = [{ id: "r-1", itemText: RAW, league: "Unassigned", fingerprint: "f", groupKey: "g", reason: "Unknown league", firstSeen: NOW, lastSeen: NOW, seenCount: 1 }];
    const wrapper = await render();
    await button(wrapper, "Review item").trigger("click");
    expect(wrapper.get<HTMLInputElement>('[name="league"]').element.value).toBe("");
    expect(button(wrapper, "Save example").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "Check market").attributes("disabled")).toBeDefined();
  });

  it("edits and removes examples without checking market", async () => {
    view.lessons = [LESSON];
    const wrapper = await render();
    await button(wrapper, "Edit").trigger("click");
    await wrapper.get('[name="amount"]').setValue("2");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("price-training:save", { ...INPUT, amount: 2 }, LESSON.id);
    await button(wrapper, "Remove").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("price-training:remove", LESSON.id);
    expect(wrapper.text()).toContain("Save your first correction");
    expect(wrapper.text()).toContain("No reliable price yet");
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "price-training:check-market")).toBe(false);
  });

  it("checks one item only on click; using asking price never saves or claims a sale", async () => {
    const wrapper = await render();
    await paste(wrapper);
    await button(wrapper, "Check market").trigger("click");
    await flushPromises();
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "price-training:check-market")).toHaveLength(1);
    expect(wrapper.text()).toContain("3 comparable listings of 5 candidates");
    expect(wrapper.text()).toContain("Shown asking range: 50–100 exalted");
    expect(wrapper.text()).toContain("Checked listings");
    expect(wrapper.text()).toContain("Expires");
    await button(wrapper, "Use checked asking price").trigger("click");
    expect(wrapper.get<HTMLInputElement>('[name="amount"]').element.value).toBe("80");
    expect(wrapper.get<HTMLSelectElement>('[name="currency"]').element.value).toBe("exalted");
    expect(wrapper.get<HTMLSelectElement>('[name="evidence"]').element.value).toBe("listing");
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "price-training:save")).toBe(false);
  });

  it("disables market requests for budget or league mismatch without disabling local save", async () => {
    view.budget.lookups = 0;
    view.budget.blockedReason = "No market lookup is available right now.";
    const wrapper = await render();
    await paste(wrapper);
    expect(button(wrapper, "Check market").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "Save example").attributes("disabled")).toBeUndefined();
    await wrapper.get('[name="league"]').setValue("Standard");
    expect(button(wrapper, "Check market").attributes("disabled")).toBeDefined();
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "price-training:check-market")).toBe(false);
  });

  it("ignores a late preview after the user changes item text", async () => {
    let resolve!: (value: PriceTrainingPreview) => void;
    const original = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === "price-training:preview") return await new Promise<PriceTrainingPreview>((done) => { resolve = done; });
      return await original(channel, ...args);
    });
    const wrapper = await render();
    await wrapper.get('[name="itemText"]').setValue(RAW);
    await vi.advanceTimersByTimeAsync(251);
    await wrapper.get('[name="itemText"]').setValue("");
    view.lessons = [LESSON];
    resolve(preview());
    await flushPromises();
    expect(wrapper.text()).not.toContain("Evidence strength 40/100");
    expect(wrapper.text()).toContain("Paste an item and enter its league");
  });

  it("accepts the item-log handoff without opening Evaluate or checking market", async () => {
    const wrapper = await render({ initialItemText: RAW });
    await vi.advanceTimersByTimeAsync(251);
    expect(wrapper.get<HTMLTextAreaElement>('[name="itemText"]').element.value).toBe(RAW);
    expect(bridge.invoke.mock.calls.every(([channel]) => ["price-training:overview", "price-training:preview"].includes(channel))).toBe(true);
  });
});
