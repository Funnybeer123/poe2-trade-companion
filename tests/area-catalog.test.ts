import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo, humanizeAreaToken, isCampaignArea, KNOWN_AREAS } from "../src/core/areaCatalog.js";

function observedIds(): Array<{ id: string; level: number }> {
  const text = readFileSync(path.join(process.cwd(), "fixtures", "client-log", "area-ids-observed.tsv"), "utf8");
  const seen = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const [id, level] = line.split("\t");
    if (!id || seen.has(id)) continue;
    seen.set(id, Number(level));
  }
  return [...seen].map(([id, level]) => ({ id, level }));
}

describe("area catalogue — every observed id", () => {
  const ids = observedIds();

  it("loads the observed list", () => {
    expect(ids.length).toBeGreaterThan(300);
  });

  it("resolves every id to a non-empty name and a real category", () => {
    for (const { id } of ids) {
      const info = areaInfo(id);
      expect(info.id, id).toBe(id);
      expect(info.name.trim().length, id).toBeGreaterThan(0);
      expect(info.category, id).not.toBe("other");
    }
  });

  it("every campaign id has an act, a part, a catalogue level and a name that is not the raw id", () => {
    for (const { id } of ids.filter((entry) => isCampaignArea(entry.id))) {
      const info = areaInfo(id);
      expect(["campaign", "town"], id).toContain(info.category);
      expect(info.act, id).toBeGreaterThanOrEqual(1);
      expect(info.act, id).toBeLessThanOrEqual(4);
      expect(info.part, id).toBeDefined();
      expect(info.level, id).toBeGreaterThan(0);
      expect(info.name, id).not.toBe(id);
      expect(id in KNOWN_AREAS, id).toBe(true);
    }
  });

  it("catalogue levels stay close to the observed levels", () => {
    for (const { id, level } of ids) {
      const known = KNOWN_AREAS[id];
      if (!known?.level || id === "G3_10") continue; // Trial of Chaos repeats at endgame level
      expect(Math.abs(known.level - level), id).toBeLessThanOrEqual(8);
    }
  });

  it("hideouts and maps humanize instead of echoing the id", () => {
    for (const { id } of ids.filter((entry) => /^(Map|Hideout)/.test(entry.id))) {
      const info = areaInfo(id);
      // `MapHideout*` are claimable hideouts, not maps.
      expect(info.category, id).toBe(/^MapHideout/.test(id) || id.startsWith("Hideout") ? "hideout" : "map");
      expect(info.name, id).not.toMatch(/^Map|^Hideout[A-Z]/);
      expect(info.name, id).not.toContain("_");
    }
  });
});

describe("category rules", () => {
  it("towns, endgame town, hideouts, maps, sanctum, league, other", () => {
    expect(areaInfo("G1_town")).toEqual({
      id: "G1_town",
      name: "Clearfell Encampment",
      category: "town",
      act: 1,
      part: 1,
      level: 15,
    });
    expect(areaInfo("G2_town").name).toBe("The Ardura Caravan");
    expect(areaInfo("G3_town").level).toBe(44);
    expect(areaInfo("G4_town")).toMatchObject({ category: "town", act: 4, level: 53, unverified: true });
    expect(areaInfo("G_Endgame_Town")).toEqual({
      id: "G_Endgame_Town",
      name: "The Ziggurat Refuge",
      category: "endgame-town",
      level: 65,
    });
    expect(areaInfo("HideoutBeaconOfSalvation")).toEqual({
      id: "HideoutBeaconOfSalvation",
      name: "Beacon of Salvation Hideout",
      category: "hideout",
    });
    // Claimable hideouts are written `MapHideout*` but are hideouts, not maps
    // (observed "MapHideoutShoreline_Claimable" at level 46).
    expect(areaInfo("MapHideoutShoreline_Claimable")).toEqual({
      id: "MapHideoutShoreline_Claimable",
      name: "Shoreline Hideout (claimable)",
      category: "hideout",
    });
    expect(areaInfo("MapHideoutCanal_Claimable")).toMatchObject({ category: "hideout", name: "Canal Hideout (claimable)" });
    expect(areaInfo("MapHideoutLimestone")).toMatchObject({ category: "hideout", name: "Limestone Hideout" });
    // The plain map rule is untouched.
    expect(areaInfo("MapHiddenGrotto")).toMatchObject({ category: "map", name: "Hidden Grotto" });
    expect(areaInfo("MapSunTemple")).toEqual({ id: "MapSunTemple", name: "Sun Temple", category: "map" });
    expect(areaInfo("Sanctum_1_Foyer_1")).toMatchObject({
      category: "sanctum",
      name: "Trial of the Sekhemas floor 1: Foyer 1",
    });
    expect(areaInfo("BreachDomain_01")).toMatchObject({ category: "league", name: "Twisted Domain" });
    expect(areaInfo("Abyss_Depths2")).toMatchObject({ category: "league" });
    expect(areaInfo("Delirium_Act1Town")).toMatchObject({ category: "league" });
    expect(areaInfo("Totally_Unknown")).toEqual({ id: "Totally_Unknown", name: "Totally Unknown", category: "other" });
    expect(areaInfo("")).toEqual({ id: "", name: "", category: "other" });
  });

  it("campaign parts: acts 1–4, the second half and legacy Cruel", () => {
    expect(areaInfo("G1_1")).toMatchObject({ name: "The Riverbank", act: 1, part: 1, level: 1 });
    expect(areaInfo("G3_10_Airlock")).toMatchObject({ name: "The Temple of Chaos", act: 3 });
    expect(areaInfo("G4_11_1a")).toMatchObject({ category: "campaign", act: 4, unverified: true });
    expect(areaInfo("P1_1")).toMatchObject({ category: "campaign", act: 1, part: 2, level: 54, unverified: true });
    expect(areaInfo("P3_Town")).toMatchObject({ category: "town", act: 3, part: 2, level: 64 });
    expect(areaInfo("C_G1_1")).toEqual({
      id: "C_G1_1",
      name: "The Riverbank (Cruel)",
      category: "campaign",
      act: 1,
      part: 2,
      level: 45,
      isCruel: true,
    });
    expect(areaInfo("C_G3_town")).toMatchObject({ name: "Ziggurat Encampment (Cruel)", category: "town", isCruel: true, level: 64 });
    expect(areaInfo("C_G2_9_2_")).toMatchObject({ name: "The Spires of Deshar (Cruel)", level: 57 });
    // Unknown campaign ids still get act/part/category and an honest name.
    expect(areaInfo("G2_99")).toEqual({
      id: "G2_99",
      name: "Act 2 area 99",
      category: "campaign",
      act: 2,
      part: 1,
      unverified: true,
    });
    expect(areaInfo("C_G4_3_1")).toMatchObject({ name: "Cruel act 4 area 3-1", act: 4, part: 2, isCruel: true, unverified: true });
    expect(areaInfo("P4_Town")).toMatchObject({ name: "Part 2 act 4 town", category: "town", act: 4, part: 2 });
  });

  it("isCampaignArea covers G/P/C_G ids and nothing else", () => {
    for (const id of ["G1_1", "G4_11_1a", "G1_town", "P1_1", "P3_Town", "C_G1_1", "C_G3_town"]) {
      expect(isCampaignArea(id), id).toBe(true);
    }
    for (const id of ["G_Endgame_Town", "HideoutCanal", "MapSunTemple", "Sanctum_1_Foyer_1", "Abyss_Hub", "", "Gx_1"]) {
      expect(isCampaignArea(id), id).toBe(false);
    }
  });
});

describe("humanizer", () => {
  it("splits CamelCase, underscores and digits, lowercases small words", () => {
    expect(humanizeAreaToken("BeaconOfSalvation")).toBe("Beacon of Salvation");
    expect(humanizeAreaToken("Merchant03_Raft")).toBe("Merchant 03 Raft");
    expect(humanizeAreaToken("TheGrelwood")).toBe("The Grelwood");
    expect(humanizeAreaToken("")).toBe("");
  });

  it("map ids: strip Map, uber bosses, no-boss variants, uniques, odd spellings", () => {
    expect(areaInfo("MapUberBoss_Monolith").name).toBe("Uber Boss: Monolith");
    expect(areaInfo("MapUberBoss_IronCitadel_Quest").name).toBe("Uber Boss: Iron Citadel Quest");
    expect(areaInfo("MapAbyss_NoBoss").name).toBe("Abyss (no boss)");
    expect(areaInfo("MapTrenches_Noboss").name).toBe("Trenches (no boss)");
    expect(areaInfo("MapUniqueCastaway").name).toBe("Unique: Castaway");
    expect(areaInfo("MapUniqueMerchant03_Raft").name).toBe("Unique: Merchant 03 Raft");
    expect(areaInfo("Map_HildaCampsite").name).toBe("Hilda Campsite");
    expect(areaInfo("MapSpring_").name).toBe("Spring");
    expect(areaInfo("MapHideoutFelled_Claimable").name).toBe("Felled Hideout (claimable)");
    expect(areaInfo("MapVaalCity").name).toBe("Vaal City");
  });
});
