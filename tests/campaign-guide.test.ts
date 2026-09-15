import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import {
  applyCustomisePatch,
  applyOrder,
  CAMPAIGN_IMPORT_MAX_BYTES,
  campaignIdParts,
  defaultCampaignGuideSettings,
  experienceBand,
  experienceChipTone,
  exportMergedRoute,
  importRouteAsCustomisations,
  mergeCampaignRoute,
  newObjectiveId,
  nextStep,
  normalizeCampaignGuideSettings,
  parseCampaignRoute,
  recordVisit,
  resolveArea,
  routeAffectingSettingsChanged,
  sanitizeCampaignRoute,
  visibleObjectives,
  wikiUrl,
  type CampaignGuideSettings,
  type CampaignRouteFile,
} from "../src/core/campaignGuide.js";

const MINI_TEXT = readFileSync(
  path.join(process.cwd(), "fixtures", "campaign-guide", "route-mini.json"),
  "utf8",
);
const CUSTOMISATIONS_TEXT = readFileSync(
  path.join(process.cwd(), "fixtures", "campaign-guide", "customisations.json"),
  "utf8",
);

function mini(): { route: CampaignRouteFile; issues: string[] } {
  return parseCampaignRoute(MINI_TEXT);
}

function settingsWith(patch: Partial<CampaignGuideSettings> = {}): CampaignGuideSettings {
  return { ...defaultCampaignGuideSettings(), ...patch };
}

describe("sanitizeCampaignRoute", () => {
  it("parses the mini fixture and reports the dangling exit", () => {
    const { route, issues } = mini();
    expect(route.acts).toHaveLength(2);
    expect(route.acts[0].areas.map((area) => area.id)).toEqual(["G1_1", "G1_2", "G1_3", "G1_town"]);
    expect(issues).toContain("G1_town.exits: unknown area G1_99");
    expect(route.acts[0].areas[3].exits).toEqual(["G2_1"]);
  });

  it("refuses junk and keeps the empty route", () => {
    expect(sanitizeCampaignRoute(42)).toEqual({
      route: expect.objectContaining({ acts: [] }),
      issues: ["route: not an object"],
    });
  });

  it("keeps the first of two areas with the same id", () => {
    const { route, issues } = sanitizeCampaignRoute({
      schemaVersion: 1,
      acts: [
        {
          part: 1,
          act: 1,
          areas: [
            { id: "G1_1", name: "First", level: 1, exits: [], objectives: [] },
            { id: "G1_1", name: "Second", level: 9, exits: [], objectives: [] },
          ],
        },
      ],
    });
    expect(route.acts[0].areas).toHaveLength(1);
    expect(route.acts[0].areas[0].name).toBe("First");
    expect(issues.some((issue) => issue.includes("duplicate area id"))).toBe(true);
  });

  it("drops a dangling reach target, an unknown reward tag and an unknown kind", () => {
    const { route, issues } = sanitizeCampaignRoute({
      schemaVersion: 1,
      acts: [
        {
          part: 1,
          act: 1,
          areas: [
            {
              id: "G1_1",
              name: "First",
              level: 1,
              exits: [],
              objectives: [
                { id: "a", title: "A", kind: "nonsense", rewards: ["gems", "sparkles"], targetAreaId: "G9_9" },
              ],
            },
          ],
        },
      ],
    });
    const objective = route.acts[0].areas[0].objectives[0];
    expect(objective.kind).toBe("note");
    expect(objective.rewards).toEqual(["gems"]);
    expect(objective.targetAreaId).toBeUndefined();
    expect(issues.some((issue) => issue.includes("unknown reward tag"))).toBe(true);
    expect(issues.some((issue) => issue.includes("targetAreaId: unknown area G9_9"))).toBe(true);
  });

  it("caps areas at 400 and objectives at 40, and coerces verified", () => {
    const areas = Array.from({ length: 401 }, (_, index) => ({
      id: `G1_${index}`,
      name: `Area ${index}`,
      level: 1,
      exits: [],
      verified: true,
      objectives: index === 0
        ? Array.from({ length: 41 }, (_, o) => ({ id: `o${o}`, title: `O${o}`, kind: "note", rewards: [] }))
        : [],
    }));
    const { route, issues } = sanitizeCampaignRoute({ schemaVersion: 1, acts: [{ part: 1, act: 1, areas }] });
    expect(route.acts[0].areas).toHaveLength(400);
    expect(route.acts[0].areas[0].objectives).toHaveLength(40);
    expect(route.acts[0].areas[0].verified).toBe(true);
    expect(issues.some((issue) => issue.includes("more than 400 areas"))).toBe(true);
    expect(issues.some((issue) => issue.includes("more than 40 objectives"))).toBe(true);
  });

  it("drops an act that does not exist and fills a missing name and level from the catalogue", () => {
    const { route, issues } = sanitizeCampaignRoute({
      schemaVersion: 1,
      acts: [
        { part: 2, act: 4, areas: [] },
        { part: 1, act: 1, areas: [{ id: "G1_4", exits: [], objectives: [] }] },
      ],
    });
    expect(route.acts).toHaveLength(1);
    expect(issues.some((issue) => issue.includes("part 2 has no act 4"))).toBe(true);
    expect(route.acts[0].areas[0].name).toBe(areaInfo("G1_4").name);
    expect(route.acts[0].areas[0].level).toBe(areaInfo("G1_4").level);
  });

  it("drops a wiki title that would escape the wiki host", () => {
    const { route, issues } = sanitizeCampaignRoute({
      schemaVersion: 1,
      acts: [
        {
          part: 1,
          act: 1,
          areas: [{ id: "G1_1", name: "First", level: 1, exits: [], objectives: [], wiki: "../../evil" }],
        },
      ],
    });
    expect(route.acts[0].areas[0].wiki).toBeUndefined();
    expect(issues.some((issue) => issue.includes("not a usable wiki page title"))).toBe(true);
  });

  it("reports an unexpected schemaVersion but still parses", () => {
    const { route, issues } = sanitizeCampaignRoute({ schemaVersion: 9, acts: [] });
    expect(route.acts).toEqual([]);
    expect(issues.some((issue) => issue.includes("unexpected schemaVersion"))).toBe(true);
  });
});

describe("parseCampaignRoute", () => {
  it("refuses anything over 2 MiB before parsing", () => {
    const big = "x".repeat(CAMPAIGN_IMPORT_MAX_BYTES + 1);
    expect(parseCampaignRoute(big)).toEqual({
      route: expect.objectContaining({ acts: [] }),
      issues: ["route: larger than 2 MiB"],
    });
  });

  it("reports invalid JSON without throwing", () => {
    const result = parseCampaignRoute("{ nope");
    expect(result.route.acts).toEqual([]);
    expect(result.issues[0]).toContain("not valid JSON");
  });
});

describe("wikiUrl", () => {
  it("encodes spaces and non-ASCII and refuses anything off the host", () => {
    expect(wikiUrl({ name: "The Red Vale" })).toBe("https://www.poe2wiki.net/wiki/The_Red_Vale");
    expect(wikiUrl({ name: "x", wiki: "Jiquani's Sanctum" })).toBe(
      "https://www.poe2wiki.net/wiki/Jiquani's_Sanctum",
    );
    for (const wiki of [
      "../../evil",
      "http://evil/wiki/x",
      "//evil/wiki/x",
      "x?y#z",
      // A backslash is refused in its own right: inside a character class
      // "\:" is only a colon, so the class has to spell the backslash out.
      "a\\b",
      "..\\..\\evil",
    ]) {
      expect(wikiUrl({ name: "x", wiki })).toBeUndefined();
    }
    expect(wikiUrl({ name: "" })).toBeUndefined();
  });
});

describe("normalizeCampaignGuideSettings", () => {
  it("returns the documented defaults for junk", () => {
    expect(normalizeCampaignGuideSettings(undefined)).toEqual(defaultCampaignGuideSettings());
    expect(normalizeCampaignGuideSettings("nope")).toEqual(defaultCampaignGuideSettings());
  });

  it("never accepts the cursor anchor and clamps the level override", () => {
    expect(normalizeCampaignGuideSettings({ overlayAnchor: "cursor" }).overlayAnchor).toBe("right");
    expect(normalizeCampaignGuideSettings({ overlayAnchor: "left" }).overlayAnchor).toBe("left");
    expect(normalizeCampaignGuideSettings({ characterLevelOverride: 0 }).characterLevelOverride).toBe(1);
    expect(normalizeCampaignGuideSettings({ characterLevelOverride: 101 }).characterLevelOverride).toBe(100);
    expect(normalizeCampaignGuideSettings({ characterLevelOverride: "x" }).characterLevelOverride).toBeNull();
    expect(normalizeCampaignGuideSettings({ characterLevelOverride: null }).characterLevelOverride).toBeNull();
  });

  it("sanitizes the fixture payload", () => {
    const settings = normalizeCampaignGuideSettings(JSON.parse(CUSTOMISATIONS_TEXT));
    expect(settings.overlayAnchor).toBe("right");
    expect(settings.rewardFilters).toEqual({
      gems: false,
      passives: true,
      stats: true,
      currency: true,
      unlocks: true,
      ascendancy: true,
      league: false,
    });
    expect(settings.characterLevelOverride).toBe(41);
    expect(settings.customisations.hiddenAreaIds).toEqual(["G1_3"]);
    expect(settings.customisations.areaNotes.G1_2).toBe("Portal out before the boss.");
    expect(settings.customisations.customObjectives.G1_2[0].verified).toBe(false);
    expect(settings.customisations.customAreas[0].verified).toBe(false);
    expect(settings.customisations.areaOverrides.G1_1).toEqual({ level: 2 });
    expect(settings.customisations.objectiveOverrides["G1_2.beira"]).toEqual({
      title: "Kill Beira (ranged is easier)",
      rewards: ["stats"],
    });
    expect(Object.keys(settings.progress.visited)).toEqual(["G1_2", "G1_1"]);
    expect(settings.progress.done).toEqual({ "G1_2.beira": "2026-09-12T18:10:00.000Z" });
    expect(settings.progress.undone).toEqual(["G1_1.reach-G1_2"]);
    expect((settings as unknown as Record<string, unknown>).unknownTopLevelKey).toBeUndefined();
  });

  it("keeps only the 500 newest visits and cuts long notes", () => {
    const visited: Record<string, string> = {};
    for (let index = 0; index < 520; index += 1) {
      visited[`A${index}`] = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    }
    const settings = normalizeCampaignGuideSettings({
      progress: { visited },
      customisations: { areaNotes: { G1_1: "n".repeat(3000) } },
    });
    expect(Object.keys(settings.progress.visited)).toHaveLength(500);
    expect(settings.progress.visited.A519).toBeDefined();
    expect(settings.progress.visited.A0).toBeUndefined();
    expect(settings.customisations.areaNotes.G1_1).toHaveLength(2000);
  });
});

describe("routeAffectingSettingsChanged", () => {
  it("ignores progress-only differences and notices everything else", () => {
    const base = defaultCampaignGuideSettings();
    const progressOnly = { ...base, progress: { visited: { G1_1: "x" }, done: {}, undone: [] } };
    expect(routeAffectingSettingsChanged(progressOnly, base)).toBe(false);
    expect(
      routeAffectingSettingsChanged({ ...base, rewardFilters: { ...base.rewardFilters, gems: false } }, base),
    ).toBe(true);
    expect(
      routeAffectingSettingsChanged(
        { ...base, customisations: { ...base.customisations, hiddenAreaIds: ["G1_1"] } },
        base,
      ),
    ).toBe(true);
    expect(routeAffectingSettingsChanged({ ...base, overlayAnchor: "left" }, base)).toBe(true);
  });
});

describe("applyOrder", () => {
  it("puts the user's order first and keeps the rest in bundled order", () => {
    const items = ["A", "B", "C", "D"].map((id) => ({ id }));
    expect(applyOrder(items, ["C", "X", "A"]).map((item) => item.id)).toEqual(["C", "A", "B", "D"]);
    expect(applyOrder(items, undefined).map((item) => item.id)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("mergeCampaignRoute", () => {
  it("applies overrides, hidden flags, custom entries and the alias index", () => {
    const { route } = mini();
    const settings = normalizeCampaignGuideSettings(JSON.parse(CUSTOMISATIONS_TEXT));
    const merged = mergeCampaignRoute(route, settings);
    const act1 = merged.acts[0];
    expect(act1.areas.map((area) => area.id)).toEqual(["G1_town", "G1_1", "G1_2", "G1_3", "G1_90"]);
    expect(merged.areaIndex.G1_1.level).toBe(2);
    expect(merged.areaIndex.G1_1.edited).toBe(true);
    expect(merged.areaIndex.G1_3.hidden).toBe(true);
    expect(merged.areaIndex.G1_90.custom).toBe(true);
    expect(merged.areaIndex.G1_2.userNote).toBe("Portal out before the boss.");
    expect(merged.aliasIndex.G1_2b).toBe("G1_2");
    expect(merged.aliasIndex.C_G1_2).toBe("G1_2");
    expect(merged.aliasIndex.C_G1_2b).toBe("G1_2");

    const beira = merged.areaIndex.G1_2.objectives.find((o) => o.id === "G1_2.beira");
    expect(beira?.title).toBe("Kill Beira (ranged is easier)");
    expect(beira?.edited).toBe(true);
    expect(beira?.done).toBe(true);
    const custom = merged.areaIndex.G1_2.objectives.find((o) => o.id === "c_custom_1");
    expect(custom?.custom).toBe(true);

    const reorder = merged.areaIndex.G1_1.objectives.map((o) => o.id);
    expect(reorder).toEqual(["G1_1.reach-G1_2", "G1_1.miller"]);
    expect(merged.areaIndex.G1_1.objectives[1].hidden).toBe(true);
  });

  it("drops a custom area whose id is already bundled (hand-edited settings)", () => {
    const { route } = mini();
    const settings = settingsWith();
    settings.customisations = {
      ...settings.customisations,
      customAreas: [
        { id: "G1_1", name: "Impostor", part: 1, act: 1, level: 9, exits: [], objectives: [], verified: false },
      ],
    };
    const merged = mergeCampaignRoute(route, settings);
    const ids = merged.acts[0].areas.map((area) => area.id);
    expect(ids.filter((id) => id === "G1_1")).toHaveLength(1);
    expect(merged.areaIndex.G1_1.name).not.toBe("Impostor");
    expect(merged.areaIndex.G1_1.custom).toBe(false);
  });

  it("marks a reach objective auto once its target was visited", () => {
    const { route } = mini();
    const settings = settingsWith({
      progress: { visited: { G1_2: "2026-09-12T18:00:00.000Z" }, done: {}, undone: [] },
    });
    const merged = mergeCampaignRoute(route, settings);
    const reach = merged.areaIndex.G1_1.objectives.find((o) => o.id === "G1_1.reach-G1_2");
    expect(reach?.auto).toBe(true);
  });
});

describe("campaignIdParts + resolveArea", () => {
  const { route } = mini();
  const merged = mergeCampaignRoute(route, defaultCampaignGuideSettings());

  it("reads part and act off the id, never off the catalogue", () => {
    expect(campaignIdParts("C_G3_16_")).toEqual({ stripped: "G3_16", isCruel: true, part: 1, act: 3 });
    expect(campaignIdParts("P2_5")).toEqual({ stripped: "P2_5", isCruel: false, part: 2, act: 2 });
    expect(campaignIdParts("HideoutBeaconOfSalvation")).toBeUndefined();
  });

  it("resolves known areas, aliases and legacy Cruel ids", () => {
    expect(resolveArea(merged, "G1_2", areaInfo("G1_2")).kind).toBe("known");
    const alias = resolveArea(merged, "G1_2b", areaInfo("G1_2b"));
    expect(alias.kind).toBe("known");
    expect(alias.normalizedId).toBe("G1_2");
    const cruel = resolveArea(merged, "C_G1_3", areaInfo("C_G1_3"));
    expect(cruel.kind).toBe("known");
    expect(cruel.isCruel).toBe(true);
    expect(cruel.area?.name).toBe("Mud Burrow");
  });

  it("guesses part and act for an unknown campaign id, Cruel included", () => {
    const unknown = resolveArea(merged, "G4_99", areaInfo("G4_99"));
    expect(unknown.kind).toBe("unknown-campaign");
    expect(unknown.guess?.part).toBe(1);
    expect(unknown.guess?.act).toBe(4);

    // areaInfo() calls every C_G* id part 2; the guess must not.
    expect(areaInfo("C_G4_99").part).toBe(2);
    const cruelUnknown = resolveArea(merged, "C_G4_99", areaInfo("C_G4_99"));
    expect(cruelUnknown.guess?.part).toBe(1);
    expect(cruelUnknown.guess?.act).toBe(4);
    expect(cruelUnknown.isCruel).toBe(true);

    const second = resolveArea(merged, "P2_9", areaInfo("P2_9"));
    expect(second.guess?.part).toBe(2);
    expect(second.guess?.act).toBe(2);
  });

  it("calls hideouts, maps and the endgame town outside", () => {
    for (const id of ["HideoutBeaconOfSalvation", "MapSunTemple", "G_Endgame_Town"]) {
      expect(resolveArea(merged, id, areaInfo(id)).kind).toBe("outside");
    }
  });
});

describe("experienceBand", () => {
  it("matches the three worked examples", () => {
    const onLevel = experienceBand(12, 15);
    expect(onLevel).toMatchObject({ band: "on-level", percent: 100, severity: "none", safeZone: 3 });
    expect(onLevel.message).toBe("On pace for this area.");
    expect(experienceChipTone(onLevel)).toBe("safe");

    const over = experienceBand(40, 32);
    expect(over).toMatchObject({ band: "over-levelled", percent: 64, severity: "moderate", safeZone: 5 });
    expect(over.message).toBe("You are 8 levels above this area — about 64 % experience; move on.");
    expect(experienceChipTone(over)).toBe("warning");

    const wayOver = experienceBand(20, 10);
    expect(wayOver).toMatchObject({ band: "over-levelled", percent: 10, severity: "severe", safeZone: 4 });
    expect(experienceChipTone(wayOver)).toBe("danger");

    const under = experienceBand(10, 20);
    expect(under.band).toBe("under-levelled");
    expect(under.message).toContain("monsters are 10 levels above you");
    expect(experienceChipTone(under)).toBe("danger");
  });

  it("labels the formula it used", () => {
    expect(experienceBand(50, 50).formula).toBe("poe1-community");
  });
});

describe("nextStep + visibleObjectives", () => {
  const { route } = mini();

  it("suggests an open objective, then an unvisited exit, then the act's town", () => {
    const settings = defaultCampaignGuideSettings();
    const merged = mergeCampaignRoute(route, settings);
    expect(nextStep(merged, merged.areaIndex.G1_1, settings)).toMatchObject({ kind: "objective" });

    const doneAll = settingsWith({
      progress: {
        visited: {},
        done: { "G1_1.miller": "x", "G1_1.reach-G1_2": "x" },
        undone: [],
      },
    });
    const merged2 = mergeCampaignRoute(route, doneAll);
    expect(nextStep(merged2, merged2.areaIndex.G1_1, doneAll)).toMatchObject({
      kind: "exit",
      area: expect.objectContaining({ id: "G1_2" }),
    });

    const visited = settingsWith({
      progress: {
        visited: { G1_2: "x" },
        done: { "G1_1.miller": "x", "G1_1.reach-G1_2": "x" },
        undone: [],
      },
    });
    const merged3 = mergeCampaignRoute(route, visited);
    expect(nextStep(merged3, merged3.areaIndex.G1_1, visited)).toMatchObject({
      kind: "act-complete",
      town: expect.objectContaining({ id: "G1_town" }),
    });
  });

  it("skips hidden and filtered objectives", () => {
    const settings = settingsWith({
      showOptional: false,
      rewardFilters: { ...defaultCampaignGuideSettings().rewardFilters, unlocks: false },
    });
    const merged = mergeCampaignRoute(route, settings);
    expect(visibleObjectives(merged.areaIndex.G1_3, settings)).toEqual([]);
    expect(visibleObjectives(merged.areaIndex.G1_3, settings, true)).toEqual([]);
  });
});

describe("recordVisit", () => {
  const { route } = mini();

  it("records the first visit, auto-completes reach objectives and reports no change on a repeat", () => {
    const first = recordVisit(defaultCampaignGuideSettings(), "G1_2", "2026-09-12T18:00:00.000Z", route);
    expect(first.changed).toBe(true);
    expect(first.settings.progress.visited.G1_2).toBe("2026-09-12T18:00:00.000Z");
    expect(first.settings.progress.done["G1_1.reach-G1_2"]).toBe("2026-09-12T18:00:00.000Z");

    const again = recordVisit(first.settings, "G1_2", "2026-09-12T19:00:00.000Z", route);
    expect(again.changed).toBe(false);
    expect(again.settings).toBe(first.settings);
  });

  it("records an alias visit under the canonical id", () => {
    const result = recordVisit(defaultCampaignGuideSettings(), "G1_2b", "2026-09-12T18:00:00.000Z", route);
    expect(result.settings.progress.visited.G1_2).toBeDefined();
    expect(result.settings.progress.visited.G1_2b).toBeUndefined();
  });

  it("leaves an objective the user un-ticked alone", () => {
    const settings = settingsWith({ progress: { visited: {}, done: {}, undone: ["G1_1.reach-G1_2"] } });
    const result = recordVisit(settings, "G1_2", "2026-09-12T18:00:00.000Z", route);
    expect(result.settings.progress.done["G1_1.reach-G1_2"]).toBeUndefined();
  });

  it("ignores hideouts, maps and league areas — progress is route areas only", () => {
    for (const areaId of [
      "HideoutBeaconOfSalvation",
      "MapSunTemple",
      "MapHideoutShoreline_Claimable",
      "ExpeditionSubArea_Kalguur_Act1",
    ]) {
      const result = recordVisit(defaultCampaignGuideSettings(), areaId, "2026-09-12T18:00:00.000Z", route);
      expect(result.changed).toBe(false);
      expect(result.settings.progress.visited).toEqual({});
    }
  });

  it("still records a campaign id the route does not have yet, and a custom area", () => {
    const unknown = recordVisit(defaultCampaignGuideSettings(), "G4_99", "2026-09-12T18:00:00.000Z", route);
    expect(unknown.settings.progress.visited.G4_99).toBeDefined();

    const withCustom = normalizeCampaignGuideSettings(JSON.parse(CUSTOMISATIONS_TEXT));
    const custom = recordVisit(withCustom, "G1_90", "2026-09-12T18:00:00.000Z", route);
    expect(custom.settings.progress.visited.G1_90).toBeDefined();
  });
});

describe("applyCustomisePatch", () => {
  const { route } = mini();
  const now = () => Date.parse("2026-09-12T20:00:00.000Z");

  it("never mutates its input", () => {
    const settings = defaultCampaignGuideSettings();
    const clone = JSON.parse(JSON.stringify(settings)) as CampaignGuideSettings;
    applyCustomisePatch(settings, { op: "hide-area", id: "G1_3" }, route, now);
    expect(settings).toStrictEqual(clone);
  });

  it("hides and restores areas and objectives", () => {
    let settings = defaultCampaignGuideSettings();
    settings = applyCustomisePatch(settings, { op: "hide-area", id: "G1_3" }, route, now).settings;
    settings = applyCustomisePatch(settings, { op: "hide-objective", id: "G1_1.miller" }, route, now).settings;
    expect(settings.customisations.hiddenAreaIds).toEqual(["G1_3"]);
    expect(settings.customisations.hiddenObjectiveIds).toEqual(["G1_1.miller"]);
    settings = applyCustomisePatch(settings, { op: "restore-area", id: "G1_3" }, route, now).settings;
    settings = applyCustomisePatch(settings, { op: "restore-objective", id: "G1_1.miller" }, route, now).settings;
    expect(settings.customisations.hiddenAreaIds).toEqual([]);
    expect(settings.customisations.hiddenObjectiveIds).toEqual([]);
  });

  it("stores the full order for a move and trims a note", () => {
    let settings = defaultCampaignGuideSettings();
    settings = applyCustomisePatch(
      settings,
      { op: "move-area", actKey: "1-1", orderedIds: ["G1_2", "G1_1", "G1_2"] },
      route,
      now,
    ).settings;
    expect(settings.customisations.areaOrder["1-1"]).toEqual(["G1_2", "G1_1"]);
    settings = applyCustomisePatch(
      settings,
      { op: "move-objective", areaId: "G1_1", orderedIds: ["G1_1.reach-G1_2", "G1_1.miller"] },
      route,
      now,
    ).settings;
    expect(settings.customisations.objectiveOrder.G1_1).toEqual(["G1_1.reach-G1_2", "G1_1.miller"]);
    settings = applyCustomisePatch(settings, { op: "set-note", areaId: "G1_1", note: "  hi  " }, route, now).settings;
    expect(settings.customisations.areaNotes.G1_1).toBe("hi");
    settings = applyCustomisePatch(settings, { op: "set-note", areaId: "G1_1", note: "   " }, route, now).settings;
    expect(settings.customisations.areaNotes.G1_1).toBeUndefined();
  });

  it("adds, edits and deletes custom objectives and refuses to delete a bundled one", () => {
    let settings = defaultCampaignGuideSettings();
    settings = applyCustomisePatch(
      settings,
      {
        op: "add-objective",
        areaId: "G1_1",
        objective: { title: "Pick up the tools", kind: "quest", rewards: ["currency"] },
      },
      route,
      now,
    ).settings;
    const added = settings.customisations.customObjectives.G1_1[0];
    expect(added.title).toBe("Pick up the tools");
    expect(added.verified).toBe(false);

    settings = applyCustomisePatch(
      settings,
      { op: "edit-objective", id: added.id, patch: { title: "Pick up Renly's tools" } },
      route,
      now,
    ).settings;
    expect(settings.customisations.customObjectives.G1_1[0].title).toBe("Pick up Renly's tools");

    const bundled = applyCustomisePatch(settings, { op: "delete-objective", id: "G1_1.miller" }, route, now);
    expect(bundled.issue).toContain("is bundled");
    expect(bundled.settings).toBe(settings);

    settings = applyCustomisePatch(settings, { op: "delete-objective", id: added.id }, route, now).settings;
    expect(settings.customisations.customObjectives.G1_1).toBeUndefined();
  });

  it("adds an area, refuses a duplicate id and validates edited exits", () => {
    let settings = defaultCampaignGuideSettings();
    const duplicate = applyCustomisePatch(
      settings,
      { op: "add-area", area: { id: "G1_1", name: "Mine", part: 1, act: 1, level: 4, exits: [] } },
      route,
      now,
    );
    expect(duplicate.issue).toContain("already exists");

    settings = applyCustomisePatch(
      settings,
      { op: "add-area", area: { id: "G1_90", name: "Mine", part: 1, act: 1, level: 4, exits: ["G1_2"] } },
      route,
      now,
    ).settings;
    expect(settings.customisations.customAreas[0].id).toBe("G1_90");

    const badExit = applyCustomisePatch(settings, { op: "edit-area", id: "G1_2", patch: { exits: ["G9_9"] } }, route, now);
    expect(badExit.issue).toContain("unknown exit");

    settings = applyCustomisePatch(settings, { op: "edit-area", id: "G1_2", patch: { level: 7 } }, route, now).settings;
    expect(settings.customisations.areaOverrides.G1_2).toEqual({ level: 7 });

    settings = applyCustomisePatch(settings, { op: "delete-area", id: "G1_90" }, route, now).settings;
    expect(settings.customisations.customAreas).toEqual([]);
    expect(applyCustomisePatch(settings, { op: "delete-area", id: "G1_1" }, route, now).issue).toContain("bundled");
  });

  it("ticks and un-ticks, and resets each scope on its own", () => {
    let settings = defaultCampaignGuideSettings();
    settings = applyCustomisePatch(
      settings,
      { op: "set-done", id: "G1_1.miller", done: true, at: "2026-09-12T20:00:00.000Z" },
      route,
      now,
    ).settings;
    expect(settings.progress.done["G1_1.miller"]).toBe("2026-09-12T20:00:00.000Z");
    settings = applyCustomisePatch(
      settings,
      { op: "set-done", id: "G1_1.miller", done: false, at: "2026-09-12T20:05:00.000Z" },
      route,
      now,
    ).settings;
    expect(settings.progress.done["G1_1.miller"]).toBeUndefined();
    expect(settings.progress.undone).toEqual(["G1_1.miller"]);

    settings = applyCustomisePatch(settings, { op: "hide-area", id: "G1_3" }, route, now).settings;
    const progressReset = applyCustomisePatch(settings, { op: "reset", what: "progress" }, route, now).settings;
    expect(progressReset.progress).toEqual({ visited: {}, done: {}, undone: [] });
    expect(progressReset.customisations.hiddenAreaIds).toEqual(["G1_3"]);
    const all = applyCustomisePatch(settings, { op: "reset", what: "all" }, route, now).settings;
    expect(all.customisations.hiddenAreaIds).toEqual([]);
  });

  it("keeps a tick the sanitizer will accept even when the stamp is junk", () => {
    const good = applyCustomisePatch(
      defaultCampaignGuideSettings(),
      { op: "set-done", id: "G1_1.miller", done: true, at: "2026-09-12T19:30:00.000Z" },
      route,
      now,
    ).settings;
    expect(good.progress.done["G1_1.miller"]).toBe("2026-09-12T19:30:00.000Z");

    const junk = applyCustomisePatch(
      defaultCampaignGuideSettings(),
      { op: "set-done", id: "G1_1.miller", done: true, at: "yesterday" },
      route,
      now,
    ).settings;
    expect(junk.progress.done["G1_1.miller"]).toBe("2026-09-12T20:00:00.000Z");
    // The stamp survives a normalize; a non-ISO one would have vanished.
    expect(normalizeCampaignGuideSettings(junk).progress.done["G1_1.miller"]).toBe(
      "2026-09-12T20:00:00.000Z",
    );
  });

  it("rejects an unknown op", () => {
    const result = applyCustomisePatch(
      defaultCampaignGuideSettings(),
      { op: "nope" } as never,
      route,
      now,
    );
    expect(result.issue).toContain("unknown op");
  });
});

describe("newObjectiveId", () => {
  it("is stable for a fixed clock and random source", () => {
    expect(newObjectiveId(() => 0, () => 0)).toBe("c_0_0000");
    expect(newObjectiveId(() => 1_000_000, () => 0.5)).toMatch(/^c_[0-9a-z]+_[0-9a-z]{4}$/);
  });
});

describe("export → import round trip", () => {
  const { route } = mini();

  it("keeps custom and edited entries and never marks anything verified", () => {
    const settings = normalizeCampaignGuideSettings(JSON.parse(CUSTOMISATIONS_TEXT));
    const merged = mergeCampaignRoute(route, settings);
    const json = exportMergedRoute(merged, route);
    const parsed = parseCampaignRoute(json);
    expect(parsed.route.acts.length).toBeGreaterThan(0);
    for (const act of parsed.route.acts) {
      for (const area of act.areas) {
        expect(area.verified).toBe(false);
        for (const objective of area.objectives) expect(objective.verified).toBe(false);
      }
    }

    const imported = importRouteAsCustomisations(
      parsed.route,
      route,
      { ...settings.customisations, areaOverrides: {}, objectiveOverrides: {}, customAreas: [], customObjectives: {} },
      "replace-customisations",
    );
    expect(imported.customisations.areaOverrides.G1_1).toMatchObject({ level: 2 });
    expect(imported.customisations.objectiveOverrides["G1_2.beira"]).toMatchObject({
      title: "Kill Beira (ranged is easier)",
    });
    expect(imported.customisations.customAreas.map((area) => area.id)).toContain("G1_90");
    expect(imported.customisations.customObjectives.G1_2?.[0].id).toBe("c_custom_1");
    expect(imported.areas).toBeGreaterThan(0);
  });

  it("merge keeps the entries the user already had", () => {
    const existing = {
      ...defaultCampaignGuideSettings().customisations,
      areaOverrides: { G1_1: { name: "My own name" } },
    };
    const incoming = parseCampaignRoute(MINI_TEXT).route;
    incoming.acts[0].areas[0].name = "Imported name";
    const merged = importRouteAsCustomisations(incoming, route, existing, "merge");
    expect(merged.customisations.areaOverrides.G1_1).toEqual({ name: "My own name" });

    const replaced = importRouteAsCustomisations(incoming, route, existing, "replace-customisations");
    expect(replaced.customisations.areaOverrides.G1_1).toEqual({ name: "Imported name" });
  });

  it("says where an imported area landed when its act is not in the bundled route", () => {
    const incoming = parseCampaignRoute(MINI_TEXT).route;
    incoming.acts.push({
      part: 2,
      act: 3,
      name: "Act 3 · second half",
      areas: [
        {
          id: "P3_9",
          name: "Somewhere new",
          part: 2,
          act: 3,
          level: 60,
          exits: [],
          objectives: [],
          verified: false,
        },
      ],
    });
    const result = importRouteAsCustomisations(
      incoming,
      route,
      defaultCampaignGuideSettings().customisations,
      "replace-customisations",
    );
    expect(result.customisations.customAreas.map((area) => area.id)).toContain("P3_9");
    expect(result.issues.some((issue) => issue.includes("P3_9"))).toBe(true);

    // A merge that finds the area already there says so instead of silently
    // leaving the user's copy alone.
    const second = importRouteAsCustomisations(incoming, route, result.customisations, "merge");
    expect(second.issues.some((issue) => issue.includes("already one of your areas"))).toBe(true);
  });
});
