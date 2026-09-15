// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { inspectItemText, type InspectOptions, type InspectReport } from "../../src/core/inspect.js";
import { MOD_FAMILIES } from "../../src/core/modKnowledge.js";
import { buildStatCatalogue } from "../../src/core/statIds.js";
import { parseLearnedTiers } from "../../src/core/tierLearning.js";
import InspectCard from "../../src/renderer/features/inspect/InspectCard.vue";

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "inspect", name), "utf8");
}

const LEARNED = parseLearnedTiers(
  JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "inspect", "learned-tiers-sample.json"), "utf8")),
);
const CATALOGUE = buildStatCatalogue(
  JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8")),
  MOD_FAMILIES,
);

function report(name: string, options: InspectOptions = {}): InspectReport {
  return inspectItemText(fixture(name), {
    learnedTiers: LEARNED,
    statIds: CATALOGUE,
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    ...options,
  })!;
}

describe("InspectCard", () => {
  it("shows the identity, the affix budget and the side/tier badges", () => {
    const wrapper = mount(InspectCard, { props: { report: report("advanced-rare-ring.txt") } });
    expect(wrapper.get("h2").text()).toBe("Storm Coil");
    expect(wrapper.text()).toContain("Sapphire Ring");
    expect(wrapper.text()).toContain("advanced text");
    expect(wrapper.text()).toContain("Prefixes 1/3 · Suffixes 2/3 · 3 open");
    expect(wrapper.findAll(".side-badge").map((badge) => badge.text())).toEqual(["I", "P", "S", "S"]);
    expect(wrapper.findAll(".mod-tier").map((badge) => badge.text())).toEqual(["low", "T3", "T2", "low"]);
    wrapper.unmount();
  });

  it("explains a tier badge in its tooltip and shows the roll percentage", () => {
    const wrapper = mount(InspectCard, { props: { report: report("advanced-rare-ring.txt") } });
    const life = wrapper.findAll(".inspect-mod")[1]!;
    expect(life.text()).toContain("+101 to maximum Life");
    expect(life.text()).toContain("40 %");
    expect(life.get(".mod-tier").attributes("title")).toContain("T3 of 3");
    expect(life.get(".mod-tier").attributes("title")).not.toContain("Tier T3");
    expect(life.get(".mod-tier").attributes("title")).toContain("needs item level 68");
    expect(life.get(".mod-tier").attributes("title")).toContain("learned from 5 listing(s)");
    expect(life.get("[role=meter]").attributes("aria-valuenow")).toBe("40");
    expect(life.text()).toContain("top tier for item level 73");
    // The whole point of the row: a better tier a higher-level base holds.
    expect(life.text()).toContain("T2 from item level 76");
    wrapper.unmount();
  });

  it("says the affix count is an estimate for a plain copy", () => {
    const wrapper = mount(InspectCard, { props: { report: report("plain-rare-ring.txt") } });
    expect(wrapper.text()).toContain("plain text");
    expect(wrapper.text()).toContain("no prefix/suffix information");
    expect(wrapper.findAll(".side-badge").map((badge) => badge.text())).toEqual(["?", "?", "?", "?"]);
    wrapper.unmount();
  });

  it("renders the damage table with the 20 % quality estimate", () => {
    const wrapper = mount(InspectCard, { props: { report: report("weapon-bow-elemental.txt") } });
    const rows = wrapper.findAll(".inspect-damage tbody tr").map((row) => row.text());
    expect(rows[0]).toContain("physical");
    expect(rows.join(" ")).toContain("126.7");
    expect(rows.join(" ")).toContain("at 20 % quality (estimate)");
    expect(wrapper.text()).toContain("Attacks per second");
    wrapper.unmount();
  });

  it("renders defences with their normalised estimate", () => {
    const wrapper = mount(InspectCard, { props: { report: report("armour-quality-12.txt") } });
    expect(wrapper.get(".inspect-defences").text()).toContain("Armour");
    expect(wrapper.get(".inspect-defences").text()).toContain("441.4");
    expect(wrapper.text()).toContain("Block chance 25 %");
    wrapper.unmount();
  });

  it("drops the 20 % quality column entirely when main stripped those numbers", () => {
    // Main removes `atQuality20` when the user turns the display off, so a
    // column of em dashes would make the setting look ignored.
    const stripped = report("armour-quality-12.txt");
    const without = {
      ...stripped,
      defences: {
        ...stripped.defences!,
        entries: stripped.defences!.entries.map(({ atQuality20: _dropped, ...entry }) => entry),
      },
    };
    const wrapper = mount(InspectCard, { props: { report: without } });
    const defences = wrapper.get(".inspect-defences");
    expect(defences.text()).toContain("Armour");
    expect(defences.text()).not.toContain("At 20 % quality");
    expect(defences.text()).not.toContain("Quality normalisation ignores");
    expect(defences.findAll("tbody tr td")).toHaveLength(2);
    wrapper.unmount();
  });

  it("says a tablet's warnings apply to its whole map range", () => {
    const wrapper = mount(InspectCard, { props: { report: report("tablet-precursor.txt") } });
    expect(wrapper.get(".inspect-map").text()).toContain("every map in this tablet's range");
    wrapper.unmount();
  });

  it("rates a waystone, carries the atlas hint and admits the table is community-maintained", () => {
    const wrapper = mount(InspectCard, {
      props: {
        report: report("waystone-t15-deadly.txt", {
          area: { id: "HideoutCanal", name: "Canal Hideout", category: "hideout", level: 68 },
        }),
      },
    });
    const map = wrapper.get(".inspect-map");
    expect(map.get(".status-chip").text()).toBe("Deadly");
    expect(map.get(".status-chip").classes()).toContain("danger");
    expect(map.text()).toContain("Lowered maximum resistances");
    expect(map.text()).toContain("Item Quantity");
    expect(map.text()).toContain("Not rated (1)");
    expect(map.text()).toContain("open the Atlas");
    expect(map.text()).toContain("Community-maintained ratings");
    wrapper.unmount();
  });

  it("emits the link URL instead of navigating itself", async () => {
    const wrapper = mount(InspectCard, { props: { report: report("advanced-rare-ring.txt") } });
    const button = wrapper.findAll(".inspect-links button")[0]!;
    expect(button.attributes("title")).toBe("https://www.poe2wiki.net/wiki/Sapphire_Ring");
    await button.trigger("click");
    expect(wrapper.emitted("open-link")).toEqual([["https://www.poe2wiki.net/wiki/Sapphire_Ring"]]);
    wrapper.unmount();
  });

  it("shows the sealed reason and the unidentified state", () => {
    const sealed = mount(InspectCard, { props: { report: report("mirrored-rare.txt") } });
    expect(sealed.text()).toContain("sealed: mirrored — no open affixes");
    sealed.unmount();

    const unidentified = mount(InspectCard, { props: { report: report("unidentified-rare.txt") } });
    expect(unidentified.text()).toContain("Unidentified — modifiers and tiers are hidden");
    expect(unidentified.text()).toContain("No modifiers to show.");
    unidentified.unmount();
  });

  it("always carries the estimate disclaimer and hides the parser notes in compact mode", () => {
    const full = mount(InspectCard, { props: { report: report("plain-rare-ring.txt") } });
    expect(full.get(".disclaimer").text()).toContain("never guarantees");
    expect(full.text()).toContain("Parser notes");
    full.unmount();

    const compact = mount(InspectCard, { props: { report: report("plain-rare-ring.txt"), compact: true } });
    expect(compact.text()).not.toContain("Parser notes");
    expect(compact.find(".disclaimer").exists()).toBe(true);
    compact.unmount();
  });

  it("says where the tier knowledge came from", () => {
    const learned = mount(InspectCard, { props: { report: report("plain-rare-ring.txt") } });
    expect(learned.get(".knowledge-line").text()).toContain("learned from 23 observations");
    expect(learned.get(".knowledge-line").text()).toContain("tier numbering 1 = best");
    learned.unmount();

    const bare = mount(InspectCard, {
      props: { report: inspectItemText(fixture("plain-rare-ring.txt"))! },
    });
    expect(bare.get(".knowledge-line").text()).toContain("hand thresholds");
    expect(bare.get(".knowledge-line").text()).toContain("stat catalogue unavailable");
    bare.unmount();
  });
});
