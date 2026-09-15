import { describe, expect, it } from "vitest";
import {
  MAX_MARKET_TABS,
  MAX_SEARCH_RESULT_IDS,
  appendPage,
  applyExchange,
  applySearch,
  closeTab,
  collapseAccount,
  isSearchResult,
  markError,
  markSearching,
  nextPageIds,
  normalizePersistedTabs,
  openTab,
  persistedTabs,
  renameTab,
  tabsFromPersisted,
  touchTab,
  updateDraft,
  type MarketTab,
} from "../src/core/marketTabs.js";
import { draftFingerprint, type MarketDraft } from "../src/core/marketQuery.js";
import type { TradeListing } from "../src/core/tradeListings.js";

const ring: MarketDraft = { kind: "search", query: { stats: [], type: "Ruby Ring" } };
const other: MarketDraft = { kind: "search", query: { stats: [], type: "Sapphire Ring" } };

function at(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 10, 12, minutes)).toISOString();
}

function listing(id: string, account = "Seller"): TradeListing {
  return {
    id,
    league: "Runes of Aldur",
    seller: { account },
    listingType: "whisper",
    item: {
      typeLine: "Ruby Ring",
      rarity: "Rare",
      identified: true,
      properties: [],
      requirements: [],
      implicitMods: [],
      explicitMods: [],
      enchantMods: [],
      runeMods: [],
      desecratedMods: [],
      fracturedMods: [],
    },
  };
}

function fill(count: number, mutate?: (tab: MarketTab, index: number) => void): MarketTab[] {
  let tabs: MarketTab[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = openTab(tabs, { draft: ring, label: `Tab ${index}` }, at(index));
    tabs = result.tabs;
    mutate?.(tabs[tabs.length - 1]!, index);
  }
  return tabs;
}

describe("openTab", () => {
  it("appends below the cap", () => {
    const tabs = fill(3);
    expect(tabs).toHaveLength(3);
    expect(tabs[0]!.state).toBe("idle");
    expect(tabs[0]!.temporary).toBe(false);
  });

  it("evicts the least-recently-used temporary tab at the cap", () => {
    const tabs = fill(MAX_MARKET_TABS, (tab, index) => {
      if (index === 2) tab.temporary = true;
    });
    const result = openTab(tabs, { draft: other, label: "New" }, at(99));
    expect(result.refused).toBeUndefined();
    expect(result.closed?.label).toBe("Tab 2");
    expect(result.tabs).toHaveLength(MAX_MARKET_TABS);
  });

  it("evicts the least-recently-used clean tab when none is temporary", () => {
    const tabs = fill(MAX_MARKET_TABS);
    const result = openTab(tabs, { draft: other, label: "New" }, at(99));
    expect(result.closed?.label).toBe("Tab 0");
  });

  it("refuses when every tab is dirty", () => {
    const tabs = fill(MAX_MARKET_TABS, (tab) => {
      tab.dirty = true;
    });
    const result = openTab(tabs, { draft: other, label: "New" }, at(99));
    expect(result.refused).toBe("tab-limit");
    expect(result.tabs).toHaveLength(MAX_MARKET_TABS);
  });

  it("selects an existing clean tab for the same favourite instead of opening one", () => {
    const first = openTab([], { draft: ring, favoriteId: "fav_1", temporary: true }, at(1));
    const again = openTab(first.tabs, { draft: ring, favoriteId: "fav_1", temporary: true }, at(5));
    expect(again.tabs).toHaveLength(1);
    expect(again.tab.id).toBe(first.tab.id);
    expect(again.tab.lastUsedAt).toBe(at(5));
  });
});

describe("updateDraft", () => {
  it("makes a temporary tab permanent and marks it dirty against its favourite", () => {
    const opened = openTab([], { draft: ring, favoriteId: "fav_1", temporary: true }, at(1));
    const same = updateDraft(opened.tabs, opened.tab.id, ring, draftFingerprint(ring));
    expect(same[0]!.temporary).toBe(false);
    expect(same[0]!.dirty).toBe(false);
    const changed = updateDraft(same, opened.tab.id, other, draftFingerprint(ring));
    expect(changed[0]!.dirty).toBe(true);
  });

  it("marks a tab with no favourite dirty on any edit", () => {
    const opened = openTab([], { draft: ring }, at(1));
    expect(updateDraft(opened.tabs, opened.tab.id, other)[0]!.dirty).toBe(true);
  });

  it("drops the share-link marker once the user edits the query", () => {
    const opened = openTab([], { draft: ring, idOnly: { searchId: "AbCdEfGh", league: "Runes of Aldur" } }, at(1));
    expect(opened.tab.idOnly).toEqual({ searchId: "AbCdEfGh", league: "Runes of Aldur" });
    const edited = updateDraft(opened.tabs, opened.tab.id, other);
    expect(edited[0]!.idOnly).toBeUndefined();
  });
});

describe("search results", () => {
  function ready(): { tabs: MarketTab[]; id: string } {
    const opened = openTab([], { draft: ring, label: "Rings" }, at(1));
    const tabs = applySearch(
      markSearching(opened.tabs, opened.tab.id),
      opened.tab.id,
      {
        searchId: "SID",
        league: "Runes of Aldur",
        url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/SID",
        total: 250,
        resultIds: Array.from({ length: 140 }, (_row, index) => `id-${index}`),
        fetchedAt: at(2),
        cached: false,
      },
      Array.from({ length: 10 }, (_row, index) => listing(`id-${index}`)),
      at(2),
      10,
    );
    return { tabs, id: opened.tab.id };
  }

  it("caps the kept ids and sets the page offset", () => {
    const { tabs } = ready();
    const result = tabs[0]!.result;
    if (!isSearchResult(result)) throw new Error("expected a search result");
    expect(result.resultIds).toHaveLength(MAX_SEARCH_RESULT_IDS);
    expect(result.listings).toHaveLength(10);
    expect(result.nextOffset).toBe(10);
    expect(tabs[0]!.state).toBe("ready");
  });

  it("pages ten ids at a time until the ids run out", () => {
    const { tabs, id } = ready();
    expect(nextPageIds(tabs[0]!)).toEqual(Array.from({ length: 10 }, (_row, index) => `id-${index + 10}`));
    let next = tabs;
    for (let page = 1; page < 10; page += 1) {
      const ids = nextPageIds(next[0]!);
      next = appendPage(next, id, ids.map((entry) => listing(entry)), ids.length);
    }
    expect(nextPageIds(next[0]!)).toEqual([]);
    const result = next[0]!.result;
    if (!isSearchResult(result)) throw new Error("expected a search result");
    expect(result.listings).toHaveLength(MAX_SEARCH_RESULT_IDS);
  });

  it("advances the page offset by the ids asked for, not the rows that came back", () => {
    const { tabs, id } = ready();
    // Two of the ten ids sold between the search and the fetch.
    const ids = nextPageIds(tabs[0]!);
    expect(ids).toHaveLength(10);
    const next = appendPage(tabs, id, ids.slice(0, 8).map((entry) => listing(entry)), ids.length);
    const result = next[0]!.result;
    if (!isSearchResult(result)) throw new Error("expected a search result");
    expect(result.nextOffset).toBe(20);
    expect(nextPageIds(next[0]!)).toEqual(Array.from({ length: 10 }, (_row, index) => `id-${index + 20}`));
  });

  it("still moves on when a whole page of ids is gone", () => {
    const { tabs, id } = ready();
    const first = appendPage(tabs, id, [], nextPageIds(tabs[0]!).length);
    const result = first[0]!.result;
    if (!isSearchResult(result)) throw new Error("expected a search result");
    expect(result.nextOffset).toBe(20);
    // Paging to the end terminates instead of re-requesting dead ids forever.
    let cursor = first;
    for (let page = 0; page < 20 && nextPageIds(cursor[0]!).length > 0; page += 1) {
      cursor = appendPage(cursor, id, [], nextPageIds(cursor[0]!).length);
    }
    expect(nextPageIds(cursor[0]!)).toEqual([]);
  });

  it("collapses and expands one seller", () => {
    const { tabs, id } = ready();
    const collapsed = collapseAccount(tabs, id, "Seller", true);
    const result = collapsed[0]!.result;
    if (!isSearchResult(result)) throw new Error("expected a search result");
    expect(result.collapsedAccounts).toEqual(["Seller"]);
    const expanded = collapseAccount(collapsed, id, "Seller", false);
    const back = expanded[0]!.result;
    if (!isSearchResult(back)) throw new Error("expected a search result");
    expect(back.collapsedAccounts).toEqual([]);
  });

  it("clears the error when a search succeeds", () => {
    const { tabs, id } = ready();
    const failed = markError(tabs, id, "nope");
    expect(failed[0]!.state).toBe("error");
    expect(markSearching(failed, id)[0]!.error).toBeUndefined();
  });

  it("stores an exchange result under the same tab shape", () => {
    const opened = openTab([], { draft: { kind: "exchange", query: { have: [], want: [] } } }, at(1));
    const tabs = applyExchange(
      opened.tabs,
      opened.tab.id,
      { searchId: "X", league: "L", url: "u", total: 3, offers: [], fetchedAt: at(2) },
      at(2),
    );
    expect(isSearchResult(tabs[0]!.result)).toBe(false);
    expect(tabs[0]!.state).toBe("ready");
  });
});

describe("persistence", () => {
  it("keeps drafts and labels but never results", () => {
    const opened = openTab([], { draft: ring, label: "Rings", colour: "gold", favoriteId: "fav_1" }, at(1));
    const tabs = applySearch(
      opened.tabs,
      opened.tab.id,
      { searchId: "SID", league: "L", url: "u", total: 1, resultIds: ["a"], fetchedAt: at(2), cached: false },
      [listing("a")],
      at(2),
      1,
    );
    const persisted = persistedTabs(tabs, opened.tab.id);
    expect(persisted.activeTabId).toBe(opened.tab.id);
    expect(JSON.stringify(persisted)).not.toContain("listings");
    expect(persisted.tabs[0]).toMatchObject({ label: "Rings", colour: "gold", favoriteId: "fav_1" });
  });

  it("survives the sanitizer and rehydrates without results", () => {
    const persisted = persistedTabs(fill(3), "nope");
    const { value, issues } = normalizePersistedTabs(JSON.parse(JSON.stringify(persisted)));
    expect(issues).toEqual([]);
    expect(value.activeTabId).toBeUndefined();
    const tabs = tabsFromPersisted(value, at(0));
    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => tab.result === undefined && tab.state === "idle")).toBe(true);
  });

  it("keeps a share-link tab's search id across a restart", () => {
    const opened = openTab(
      [],
      { draft: ring, label: "AbCdEfGh (id only)", idOnly: { searchId: "AbCdEfGh", league: "Runes of Aldur" } },
      at(1),
    );
    const persisted = persistedTabs(opened.tabs, opened.tab.id);
    expect(persisted.tabs[0]!.idOnly).toEqual({ searchId: "AbCdEfGh", league: "Runes of Aldur" });
    const { value, issues } = normalizePersistedTabs(JSON.parse(JSON.stringify(persisted)));
    expect(issues).toEqual([]);
    expect(tabsFromPersisted(value, at(2))[0]!.idOnly).toEqual({ searchId: "AbCdEfGh", league: "Runes of Aldur" });
  });

  it("drops a share-link id that is not one of the site's tokens, and says so", () => {
    const { value, issues } = normalizePersistedTabs({
      tabs: [
        {
          id: "a",
          label: "hand edited",
          draft: { kind: "search", query: { stats: [] } },
          idOnly: { searchId: "https://evil/../x", league: "L" },
        },
      ],
    });
    expect(value.tabs[0]!.idOnly).toBeUndefined();
    expect(issues.some((issue) => issue.includes("share-link id"))).toBe(true);
  });

  it("drops junk tabs and caps the list", () => {
    const { value, issues } = normalizePersistedTabs({
      tabs: [
        { id: "a", label: "ok", draft: { kind: "search", query: { stats: [] } } },
        { id: "b", label: "broken", draft: { kind: "search" } },
        ...Array.from({ length: 15 }, (_row, index) => ({
          id: `x${index}`,
          label: `x${index}`,
          draft: { kind: "search", query: { stats: [] } },
        })),
      ],
    });
    expect(value.tabs).toHaveLength(MAX_MARKET_TABS);
    expect(issues.some((issue) => issue.includes("no usable query"))).toBe(true);
    expect(issues.some((issue) => issue.includes(`more than ${MAX_MARKET_TABS}`))).toBe(true);
  });
});

describe("tab chrome", () => {
  it("renames without touching the draft", () => {
    const opened = openTab([], { draft: ring, label: "Rings" }, at(1));
    const renamed = renameTab(opened.tabs, opened.tab.id, "  My rings  ", "blue");
    expect(renamed[0]!.label).toBe("My rings");
    expect(renamed[0]!.colour).toBe("blue");
    expect(renamed[0]!.draft).toEqual(ring);
  });

  it("ignores a colour that is not one of ours", () => {
    const opened = openTab([], { draft: ring, colour: "hotpink" }, at(1));
    expect(opened.tab.colour).toBe("grey");
  });

  it("closes and touches", () => {
    const tabs = fill(2);
    expect(closeTab(tabs, tabs[0]!.id)).toHaveLength(1);
    expect(touchTab(tabs, tabs[0]!.id, at(50))[0]!.lastUsedAt).toBe(at(50));
  });
});
