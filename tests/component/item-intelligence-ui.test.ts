// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildProfile } from "../../src/core/buildProfiles.js";
import { validateRuleRegex } from "../../src/core/scanRules.js";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "../../src/core/types.js";
import type {
  ImportBuildTargetsResult,
  ItemEvaluation,
  RuleSetView,
} from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  evaluation: undefined as unknown,
  catalog: [] as unknown[],
  ruleSets: [] as unknown[],
  buildProfiles: [] as unknown[],
  importResult: undefined as unknown,
  generateSearch: vi.fn(),
  saveRuleSet: vi.fn(),
  importTargets: vi.fn(),
  validateRule: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: {
    isNative: true,
    mode: vi.fn(async () => "public-companion"),
    windows: vi.fn(async () => []),
    killLatched: vi.fn(async () => false),
    rearm: vi.fn(async () => false),
    evaluateText: vi.fn(async () => bridge.evaluation),
    fromClipboard: vi.fn(async () => bridge.evaluation),
    onItem: vi.fn(() => () => undefined),
    scanner: {
      status: vi.fn(async () => ({
        schemaVersion: 1 as const,
        running: false,
        mode: "public-companion" as const,
        qaOptIn: false,
        killLatched: false,
      })),
      start: vi.fn(),
      stop: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    },
    generateFilter: vi.fn(async () => ""),
    intelligence: {
      catalog: {
        list: vi.fn(async () => bridge.catalog),
        remove: vi.fn(async () => true),
        onChanged: vi.fn(() => () => undefined),
      },
      rules: {
        list: vi.fn(async () => bridge.ruleSets),
        save: bridge.saveRuleSet,
        remove: vi.fn(async () => true),
        validate: bridge.validateRule,
        generateSearch: bridge.generateSearch,
        onChanged: vi.fn(() => () => undefined),
      },
      builds: {
        list: vi.fn(async () => bridge.buildProfiles),
        save: vi.fn(async ({ profile }) => profile),
        remove: vi.fn(async () => true),
        activate: vi.fn(async () => bridge.buildProfiles),
        importTargets: bridge.importTargets,
        onChanged: vi.fn(() => () => undefined),
      },
      imports: {
        legacy: vi.fn(),
      },
      scans: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
      },
    },
  },
}));

import ItemDetail from "../../src/renderer/components/ItemDetail.vue";
import BuildsView from "../../src/renderer/views/BuildsView.vue";
import FinderView from "../../src/renderer/views/FinderView.vue";
import RulesView from "../../src/renderer/views/RulesView.vue";
import ScansView from "../../src/renderer/views/ScansView.vue";
import {
  disposeIntelligenceStore,
  useIntelligenceStore,
} from "../../src/renderer/composables/useIntelligenceStore.js";

const item: NormalizedItem = {
  itemClass: "Rings",
  rarity: "Rare",
  name: "Doom Turn",
  baseType: "Ruby Ring",
  itemLevel: 75,
  quality: 20,
  sockets: "",
  requirements: { Level: 50 },
  identified: true,
  corrupted: false,
  fingerprint: "ui-ring",
  rawText: "Item Class: Rings\nRarity: Rare\nDoom Turn\nRuby Ring",
  properties: [
    {
      name: "Item Level",
      value: "75",
      text: "Item Level: 75",
      rawText: "Item Level: 75",
      block: 1,
      order: 0,
      line: 4,
      values: [75],
      rolls: [],
    },
  ],
  mods: [
    {
      text: "+35% to Cold Resistance",
      kind: "explicit",
      block: 4,
      order: 1,
      line: 10,
      values: [35],
      rolls: [
        {
          index: 0,
          value: 35,
          raw: "35",
          unit: "%",
          start: 1,
          end: 3,
        },
      ],
    },
    {
      text: "+100 to maximum Life",
      kind: "explicit",
      block: 4,
      order: 0,
      line: 9,
      values: [100],
      rolls: [
        {
          index: 0,
          value: 100,
          raw: "100",
          start: 1,
          end: 4,
        },
      ],
    },
  ],
};

const valuation: ValuationResult = {
  itemIdentifier: item.name,
  itemType: item.baseType,
  normalizedKeyStats: {},
  currency: "exalted",
  low: 8,
  fair: 10,
  high: 12,
  recommendedListing: 11,
  confidence: "medium",
  comparablesUsed: 4,
  candidateCount: 7,
  providerName: "fixture",
  marketTimestamp: "2026-08-27T12:00:00.000Z",
};

const desirability: DesirabilityResult = {
  score: 72,
  category: "sell",
  reasons: ["Strong life roll", "Useful resistance"],
};

const evaluation: ItemEvaluation = {
  schemaVersion: 1,
  parsed: true,
  raw: item.rawText ?? "",
  item,
  valuation,
  desirability,
};

beforeEach(() => {
  disposeIntelligenceStore();
  bridge.evaluation = evaluation;
  bridge.catalog = [];
  bridge.ruleSets = [];
  bridge.buildProfiles = [];
  bridge.importResult = undefined;
  bridge.generateSearch.mockReset();
  bridge.saveRuleSet.mockReset();
  bridge.importTargets.mockReset();
  bridge.validateRule.mockReset();
  bridge.validateRule.mockImplementation(async (source: string) =>
    validateRuleRegex(source),
  );
});

describe("item intelligence renderer", () => {
  it("renders ordered details with transparent valuation evidence", () => {
    const wrapper = mount(ItemDetail, {
      props: { item, valuation, desirability },
    });

    expect(wrapper.get("h2").text()).toBe("Doom Turn");
    expect(wrapper.findAll(".affix-copy strong").map((entry) => entry.text())).toEqual([
      "+100 to maximum Life",
      "+35% to Cold Resistance",
    ]);
    expect(wrapper.text()).toContain("4 usable comparables from 7 candidates");
    expect(wrapper.text()).toContain("estimate, not a guaranteed sale price");
    expect(wrapper.get('[role="meter"]').attributes("aria-valuenow")).toBe("72");
    wrapper.unmount();
  });

  it("generates finder queries using clone-safe plain selections", async () => {
    bridge.generateSearch.mockResolvedValue({
      queries: [
        {
          label: "Ruby Ring search",
          query: "Ruby Ring",
          regex: "Ruby Ring",
          stashQuery: '"Ruby Ring"',
          flags: "i",
          length: 11,
          selectionIds: ["item-base"],
          representativeLines: ["Ruby Ring"],
        },
      ],
      warnings: [],
      conflicts: [],
      maxLength: 50,
    });
    await useIntelligenceStore().evaluateText(evaluation.raw);
    const wrapper = mount(FinderView, {
      global: {
        stubs: {
          RouterLink: { template: "<a><slot /></a>" },
        },
      },
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Generate validated queries"))!
      .trigger("click");
    await nextTick();

    expect(bridge.generateSearch).toHaveBeenCalledOnce();
    const request = bridge.generateSearch.mock.calls[0]![0] as {
      selections: Array<Record<string, unknown>>;
    };
    expect(request.selections.some((selection) => "mod" in selection)).toBe(false);
    expect(wrapper.get(".query-card code").text()).toBe('"Ruby Ring"');
    wrapper.unmount();
  });

  it("validates and persists an edited rule set", async () => {
    const saved: RuleSetView = {
      id: "rules-ui",
      kind: "stash-scan",
      name: "UI resistance rules",
      schemaVersion: 1,
      rules: [
        {
          id: "rule-ui",
          name: "Cold resistance",
          regex: '"cold resistance"',
          schemaVersion: 1,
        },
      ],
      active: true,
      createdAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:01.000Z",
    };
    bridge.saveRuleSet.mockImplementation(async () => {
      bridge.ruleSets = [saved];
      return saved;
    });
    const wrapper = mount(RulesView);

    await wrapper.get('input[autocomplete="off"]').setValue("UI resistance rules");
    await wrapper.find("textarea").setValue('"cold resistance"');
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save rule set"))!
      .trigger("click");
    await nextTick();

    expect(bridge.saveRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "UI resistance rules",
        rules: [
          expect.objectContaining({
            regex: '"cold resistance"',
          }),
        ],
      }),
    );
    expect(wrapper.text()).toContain("Saved");
    wrapper.unmount();
  });

  it("keeps scanner controls available for live use", async () => {
    const wrapper = mount(ScansView);
    await flushPromises();

    expect(wrapper.get(".scanner-controls summary").text()).toBe("Stash scanner");
    const liveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Run live scan"));
    expect(liveButton).toBeDefined();
    expect(liveButton?.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("guides a local build query import and reports target coverage", async () => {
    const profile: BuildProfile = {
      schemaVersion: 1,
      id: "profile-ui",
      name: "UI ring build",
      tags: [],
      active: false,
      preferences: {
        exactMatchBoost: 20,
        nearMatchBoost: 8,
        preferredSlots: [],
        preferredItemClasses: [],
        preferredTags: [],
      },
      gearTargets: [
        {
          id: "target-ui",
          searchKey: "query-ui",
          name: "Ruby Ring target",
          slot: "ring",
          itemClass: "Rings",
          statRules: [],
          tags: [],
          createdAt: "2026-08-27T12:00:00.000Z",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
      ],
      createdAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:00.000Z",
    };
    const result: ImportBuildTargetsResult = {
      profile,
      tradeImport: {
        queries: [],
        warnings: [],
        errors: [],
      },
      addedTargetIds: ["target-ui"],
      updatedTargetIds: [],
      warnings: [],
    };
    bridge.buildProfiles = [profile];
    bridge.importResult = result;
    bridge.importTargets.mockResolvedValue(result);
    const wrapper = mount(BuildsView);

    await wrapper.get('textarea[placeholder*="pathofexile.com"]').setValue(
      JSON.stringify({ query: { type: "Ruby Ring", stats: [] } }),
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Import as new profile"))!
      .trigger("click");
    await flushPromises();
    await nextTick();

    expect(bridge.importTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText: expect.stringContaining("Ruby Ring"),
      }),
    );
    expect(wrapper.text()).toContain("1 added");
    expect(wrapper.text()).toContain("Ruby Ring target");
    wrapper.unmount();
  });
});
