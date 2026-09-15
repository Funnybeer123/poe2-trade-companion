// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemSummary } from "../../src/core/evaluateItem.js";
import { initialQueryState } from "../../src/core/evaluateQuery.js";
import { estimateFor, listingRow } from "../../src/core/evaluateResults.js";
import { MOD_FAMILIES } from "../../src/core/modKnowledge.js";
import { parseItemText } from "../../src/core/parseItem.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../../src/core/priceTable.js";
import { buildStatCatalogue } from "../../src/core/statIds.js";
import { parseTradeListings } from "../../src/core/tradeListings.js";
import {
  DEFAULT_EVALUATE_SETTINGS,
  type EvaluateQueryState,
  type EvaluateSession,
} from "../../src/shared/evaluate.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
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
  getAppFeatureApi: () => null,
}));

import EvaluateWorkbench from "../../src/renderer/features/evaluate/EvaluateWorkbench.vue";
import { disposeEvaluateSession } from "../../src/renderer/features/evaluate/useEvaluateSession";

const STATS = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8"),
) as unknown;

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "evaluate", name), "utf8");
}

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [{ id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 400 }],
};

const NOW = new Date("2026-09-07T12:00:00Z");

function session(overrides: Partial<EvaluateSession> = {}): EvaluateSession {
  const raw = fixture("rare-ring-resists.txt");
  const parsed = parseItemText(raw);
  const catalogue = buildStatCatalogue(STATS, MOD_FAMILIES, ["explicit", "pseudo"]);
  const item = itemSummary(parsed, { priceTable: TABLE });
  const query: EvaluateQueryState = initialQueryState({
    parsed,
    summary: item,
    catalogue,
    settings: DEFAULT_EVALUATE_SETTINGS,
  });
  const listings = parseTradeListings(
    JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "evaluate", "fetch-rare-ring.json"), "utf8")),
    "Runes of Aldur",
    { priceTable: TABLE },
  );
  return {
    id: "ev_test",
    source: "hotkey",
    openedAt: NOW.toISOString(),
    item,
    query,
    results: {
      searchId: "search-1",
      url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-1",
      queryUrl: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur?q=%7B%7D",
      league: "Runes of Aldur",
      total: 42,
      fetched: listings.length,
      remainingIds: 4,
      rows: listings.map((listing) => listingRow(listing, NOW.getTime(), TABLE)),
      estimate: estimateFor({ parsed, listings, basis: "stat-filtered", priceTable: TABLE, now: NOW }),
      cached: false,
      fetchedAt: NOW.toISOString(),
    },
    busy: "idle",
    catalogueReady: true,
    prefs: { groupBySeller: false },
    budget: {
      lookups: 3,
      searchesSpare: 3,
      fetchesSpare: 3,
      hasSession: false,
      league: "Runes of Aldur",
      leagueAmbiguous: false,
    },
    ...overrides,
  };
}

async function mountWorkbench(value = session(), props: Record<string, unknown> = {}) {
  const wrapper = mount(EvaluateWorkbench, {
    props: { session: value, ...props },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper
    .findAll("button")
    .filter((node) => !node.classes("sr-only"))
    .find((node) => node.text().startsWith(text));
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel: string) => {
    if (channel === "evaluate:budget") {
      return {
        lookups: 3,
        searchesSpare: 3,
        fetchesSpare: 3,
        hasSession: false,
        league: "Runes of Aldur",
        leagueAmbiguous: false,
      };
    }
    return session();
  });
  disposeEvaluateSession();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // happy-dom always has one; a blocked store is fine.
  }
});

afterEach(() => {
  disposeEvaluateSession();
  vi.useRealTimers();
});

describe("EvaluateWorkbench", () => {
  it("shows the item, its chips and the estimated band with its sample size", async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.text()).toContain("Woe Loop");
    expect(wrapper.text()).toContain("Ruby Ring");
    expect(wrapper.text()).toContain("iLvl 80");
    expect(wrapper.text()).toContain("Estimated price");
    expect(wrapper.text()).toContain("of 4 listings comparable");
    expect(wrapper.text()).toContain(
      "This is an estimate, not a guaranteed sale price. Confirm current listings before acting.",
    );
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("sends the edited query when Search is pressed", async () => {
    const wrapper = await mountWorkbench();
    const checkbox = wrapper.findAll('input[type="checkbox"]')[0]!;
    await checkbox.setValue(false);
    await button(wrapper, "Search")!.trigger("click");
    await flushPromises();
    const call = bridge.invoke.mock.calls.find(([channel]) => channel === "evaluate:search");
    expect(call).toBeDefined();
    const sent = call![2] as EvaluateQueryState;
    expect(sent.rows.filter((row) => row.enabled).length).toBeLessThan(
      session().query.rows.filter((row) => row.enabled).length,
    );
    wrapper.unmount();
  });

  it("switches profile through main rather than locally", async () => {
    const wrapper = await mountWorkbench();
    await wrapper.find("select").setValue("broad");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("evaluate:set-profile", "ev_test", "broad");
    wrapper.unmount();
  });

  it("copies a listing's stash note through main", async () => {
    const wrapper = await mountWorkbench();
    await button(wrapper, "Note")!.trigger("click");
    await flushPromises();
    const call = bridge.invoke.mock.calls.find(([channel]) => channel === "evaluate:copy");
    expect(call?.[2]).toMatchObject({ kind: "note", listingId: "row-a" });
    wrapper.unmount();
  });

  it("fades stale rows and filters by currency without another request", async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.findAll("tr.stale-stale").length).toBe(1);
    expect(wrapper.findAll("tr.stale-aging").length).toBe(1);
    const before = bridge.invoke.mock.calls.length;
    await button(wrapper, "divine")!.trigger("click");
    expect(wrapper.findAll("tbody tr").length).toBe(1);
    expect(bridge.invoke.mock.calls.length).toBe(before);
    wrapper.unmount();
  });

  it("opens the listing peek for one row", async () => {
    const wrapper = await mountWorkbench();
    await wrapper.find(".icon-button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("+70 to maximum Life");
    wrapper.unmount();
  });

  it("disables Search with a countdown inside a trade2 penalty window", async () => {
    const penalised = session();
    penalised.budget = {
      ...penalised.budget,
      restrictedUntilIso: new Date(Date.now() + 65_000).toISOString(),
    };
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "evaluate:budget") return penalised.budget;
      return penalised;
    });
    const wrapper = await mountWorkbench(penalised);
    expect(button(wrapper, "Search")!.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("trade2 penalty");
    wrapper.unmount();
  });

  it("says which setting fixes an ambiguous league", async () => {
    const ambiguous = session();
    ambiguous.budget = { ...ambiguous.budget, leagueAmbiguous: true };
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "evaluate:budget") return ambiguous.budget;
      return ambiguous;
    });
    const wrapper = await mountWorkbench(ambiguous);
    expect(wrapper.text()).toContain("Tools → Settings → Market data");
    wrapper.unmount();
  });

  it("surfaces a session error as an alert", async () => {
    const wrapper = await mountWorkbench(session({ error: "trade2 is rate limited until 12:10" }));
    expect(wrapper.find('[role="alert"]').text()).toContain("rate limited");
    wrapper.unmount();
  });

  it("explains a blocked capture and a dry-run capture", async () => {
    const blocked = await mountWorkbench(
      session({ capture: { status: "blocked", reason: "Path of Exile is not the foreground window" } }),
    );
    expect(blocked.text()).toContain("not the foreground window");
    blocked.unmount();

    const dry = await mountWorkbench(
      session({ capture: { status: "dry-run", reason: "Dry-run: no Ctrl+C was sent." } }),
    );
    expect(dry.text()).toContain("Dry-run · clipboard · lookups still run");
    dry.unmount();
  });

  it("shows the first-use hint once and remembers the dismissal", async () => {
    const first = await mountWorkbench();
    expect(first.text()).toContain("Tick the lines that define this item");
    await button(first, "Got it")!.trigger("click");
    expect(first.text()).not.toContain("Tick the lines that define this item");
    first.unmount();

    const second = await mountWorkbench();
    expect(second.text()).not.toContain("Tick the lines that define this item");
    second.unmount();
  });

  it("re-orders the table when a sort header is pressed, without a request", async () => {
    const wrapper = await mountWorkbench();
    const firstSeller = () => wrapper.find("tbody tr").findAll("td").at(-3)!.text();
    expect(firstSeller()).toContain("SellerA");
    const before = bridge.invoke.mock.calls.length;
    const age = wrapper.findAll("thead button").find((node) => node.text().startsWith("Age"))!;
    await age.trigger("click");
    // Oldest first, and nothing was asked of main.
    expect(firstSeller()).toContain("SellerC");
    expect(age.text()).toContain("▼");
    expect(bridge.invoke.mock.calls.length).toBe(before);
    wrapper.unmount();
  });

  it("starts grouped by seller when the setting says so", async () => {
    const plain = await mountWorkbench();
    const box = (wrapper: ReturnType<typeof mount>) =>
      wrapper
        .findAll("label")
        .find((node) => node.text().includes("Group by seller"))!
        .find("input").element as HTMLInputElement;
    expect(box(plain).checked).toBe(false);
    plain.unmount();

    const grouped = await mountWorkbench(session({ prefs: { groupBySeller: true } }));
    expect(box(grouped).checked).toBe(true);
    grouped.unmount();
  });

  it("re-searches when the listing currency changes — the one filter that does", async () => {
    const wrapper = await mountWorkbench();
    const select = wrapper
      .findAll("label")
      .find((node) => node.text().startsWith("Listed in"))!
      .find("select");
    await select.setValue("divine");
    await flushPromises();
    const call = bridge.invoke.mock.calls.find(([channel]) => channel === "evaluate:search");
    expect(call).toBeDefined();
    expect((call![2] as EvaluateQueryState).priceCurrency).toBe("divine");
    wrapper.unmount();
  });

  it("offers the bulk exchange only for a stackable", async () => {
    const ring = await mountWorkbench();
    expect(ring.text()).not.toContain("Bulk exchange");
    ring.unmount();

    const currency = session();
    const parsed = parseItemText(fixture("currency-divine.txt"));
    currency.item = itemSummary(parsed, { priceTable: TABLE });
    const wrapper = await mountWorkbench(currency);
    expect(wrapper.text()).toContain("Bulk exchange");
    wrapper.unmount();
  });

  it("prints an exchange/feed divergence as a note, never as an error alert", async () => {
    const currency = session();
    const parsed = parseItemText(fixture("currency-divine.txt"));
    currency.item = itemSummary(parsed, { priceTable: TABLE });
    currency.exchange = {
      offers: [
        { id: "offer-a", seller: "SellerZ", online: true, ratio: "900 exalted : 1 divine", stock: 3, perUnitQuoted: 900 },
      ],
      bestAskQuoted: 900,
      medianAskQuoted: 900,
      stockTotal: 3,
      quoteCurrency: "exalted",
      caution: "The exchange median (900 ex) and the feed price (400 ex) disagree by more than 25 % — both are estimates.",
      url: "https://www.pathofexile.com/trade2/exchange/poe2/Runes%20of%20Aldur/ex-1",
      fetchedAt: NOW.toISOString(),
    };
    const wrapper = await mountWorkbench(currency);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('.exchange [role="note"]').text()).toContain("disagree by more than 25 %");
    expect(wrapper.text()).toContain("900 exalted per unit");
    wrapper.unmount();
  });
});
