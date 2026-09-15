// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { indexStatOptions, statOptionsFromPayload } from "../../src/core/marketStatSearch.js";
import type { TradeQuery } from "../../src/core/tradeQuery.js";
import type { WeightTemplateView } from "../../src/shared/market.js";
import QueryBuilder from "../../src/renderer/features/market/components/QueryBuilder.vue";

const index = indexStatOptions(
  statOptionsFromPayload(
    JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8")),
  ),
);

const TEMPLATES: WeightTemplateView[] = [
  {
    id: "total-elemental-res",
    label: "Total elemental resistance",
    type: "weight",
    min: 80,
    resolved: true,
    filters: [
      { text: "+#% to Fire Resistance", type: "explicit", weight: 1, id: "explicit.stat_3372524247" },
      { text: "+#% to Cold Resistance", type: "explicit", weight: 1, id: "explicit.stat_4220027924" },
    ],
  },
  {
    id: "unresolved",
    label: "Not in this catalogue",
    type: "weight",
    resolved: false,
    filters: [{ text: "+# to Nothing", type: "explicit", weight: 1, id: "" }],
  },
];

function builder(query: Partial<TradeQuery> = {}) {
  return mount(QueryBuilder, {
    props: {
      query: { stats: [], ...query } as TradeQuery,
      statIndex: index,
      templates: TEMPLATES,
      hasSession: true,
    },
  });
}

describe("QueryBuilder", () => {
  it("searches on Enter in a query field", async () => {
    const wrapper = builder();
    await wrapper.find("input[placeholder='Ruby Ring']").trigger("keydown.enter");
    expect(wrapper.emitted("search")).toHaveLength(1);
  });

  it("does not search on Enter while the search button is disabled", async () => {
    const wrapper = mount(QueryBuilder, {
      props: {
        query: { stats: [] } as TradeQuery,
        statIndex: index,
        templates: TEMPLATES,
        hasSession: true,
        searchDisabled: true,
        searchDisabledReason: "no budget",
      },
    });
    await wrapper.find("input[placeholder='Ruby Ring']").trigger("keydown.enter");
    expect(wrapper.emitted("search")).toBeUndefined();
  });

  it("updates the draft when a field changes", async () => {
    const wrapper = builder();
    const input = wrapper.find("input[placeholder='Ruby Ring']");
    await input.setValue("Sapphire Ring");
    await input.trigger("change");
    const emitted = wrapper.emitted("update:query");
    expect((emitted?.at(-1)?.[0] as TradeQuery).type).toBe("Sapphire Ring");
  });

  it("adds a modifier through the autocomplete", async () => {
    const wrapper = builder({ stats: [{ type: "and", filters: [{ id: "" }] }] });
    const input = wrapper.find(".stat-input");
    await input.trigger("focus");
    await input.setValue("max life");
    await input.trigger("input");
    await flushPromises();
    const options = wrapper.findAll(".stat-list li");
    expect(options.length).toBeGreaterThan(0);
    await options[0]!.trigger("mousedown");
    const emitted = wrapper.emitted("update:query");
    const query = emitted?.at(-1)?.[0] as TradeQuery;
    expect(query.stats[0]!.filters[0]!.id).toBe("explicit.stat_3299347043");
  });

  it("appends a weighted template and greys an unresolved one", async () => {
    const wrapper = builder();
    await wrapper.findAll("button").find((button) => button.text() === "Templates")!.trigger("click");
    const buttons = wrapper.findAll(".template-list button");
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.attributes("disabled")).toBeDefined();
    await buttons[0]!.trigger("click");
    const query = wrapper.emitted("update:query")?.at(-1)?.[0] as TradeQuery;
    expect(query.stats[0]).toMatchObject({ type: "weight", value: { min: 80 } });
    expect(query.stats[0]!.filters).toHaveLength(2);
  });

  it("warns that a weighted group needs a session cookie", () => {
    const wrapper = mount(QueryBuilder, {
      props: {
        query: { stats: [{ type: "weight", filters: [] }] } as TradeQuery,
        statIndex: index,
        templates: TEMPLATES,
        hasSession: false,
      },
    });
    expect(wrapper.text()).toMatch(/needs a POESESSID/);
  });

  it("resets only on the second click", async () => {
    const wrapper = builder({ type: "Ruby Ring" });
    const reset = wrapper.findAll("button").find((button) => button.text() === "Reset")!;
    await reset.trigger("click");
    expect(wrapper.emitted("update:query")).toBeUndefined();
    expect(wrapper.text()).toContain("Confirm reset");
    await wrapper.findAll("button").find((button) => button.text() === "Confirm reset")!.trigger("click");
    const query = wrapper.emitted("update:query")?.at(-1)?.[0] as TradeQuery;
    expect(query.type).toBeUndefined();
    expect(query.stats).toEqual([]);
  });

  it("keeps corrupted and twice-corrupted exclusive", async () => {
    const wrapper = builder({ misc: { twice_corrupted: true, corrupted: true } });
    const selects = wrapper.findAll("select");
    const corrupted = selects.find((select) => select.attributes("title")?.includes("already implies corrupted"));
    expect(corrupted?.attributes("disabled")).toBeDefined();
  });

  it("flags the unverified instant-buyout option", () => {
    expect(builder().text()).toMatch(/unverified/);
  });

  it("offers every sort key", () => {
    const wrapper = builder();
    const sort = wrapper.findAll("select").find((select) => select.text().includes("Physical DPS"));
    expect(sort).toBeDefined();
  });
});
