import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import {
  actKey,
  campaignIdParts,
  defaultCampaignGuideSettings,
  mergeCampaignRoute,
  parseCampaignRoute,
  resolveArea,
  wikiUrl,
} from "../src/core/campaignGuide.js";

const ROUTE_TEXT = readFileSync(
  path.join(process.cwd(), "src", "data", "campaign", "route.json"),
  "utf8",
);
const parsed = parseCampaignRoute(ROUTE_TEXT);
const route = parsed.route;
const merged = mergeCampaignRoute(route, defaultCampaignGuideSettings());

/** id → [min, max] of the levels this id was actually seen at. */
function observedLevels(): Map<string, [number, number]> {
  const tsv = readFileSync(
    path.join(process.cwd(), "fixtures", "client-log", "area-ids-observed.tsv"),
    "utf8",
  );
  const out = new Map<string, [number, number]>();
  for (const line of tsv.split(/\r?\n/)) {
    const [id, levelText] = line.split("\t");
    if (!id || !levelText) continue;
    const level = Number(levelText);
    if (!Number.isFinite(level)) continue;
    const current = out.get(id);
    out.set(id, current ? [Math.min(current[0], level), Math.max(current[1], level)] : [level, level]);
  }
  return out;
}

const OBSERVED = observedLevels();
/** Both repeat at endgame levels, so their instance level says nothing about the route. */
const LEVEL_EXCEPTIONS = new Set(["G2_13", "G3_10"]);
const CAMPAIGN_ID = /^(?:C_)?(?:G\d+_|P\d+_)/;

const allAreas = route.acts.flatMap((act) => act.areas);

describe("bundled campaign route", () => {
  it("parses with no issues and carries the community note", () => {
    expect(parsed.issues).toEqual([]);
    expect(route.schemaVersion).toBe(1);
    expect(route.communityNote).toContain("verify");
    expect(allAreas.length).toBeGreaterThan(80);
  });

  it("marks every area and objective unverified", () => {
    for (const area of allAreas) {
      expect(area.verified).toBe(false);
      for (const objective of area.objectives) expect(objective.verified).toBe(false);
    }
  });

  it("has unique ids, a town per act and at least one objective per area", () => {
    const ids = new Set<string>();
    for (const area of allAreas) {
      expect(ids.has(area.id)).toBe(false);
      ids.add(area.id);
      expect(area.objectives.length).toBeGreaterThan(0);
    }
    for (const act of route.acts) {
      expect(act.areas.some((area) => area.town)).toBe(true);
      expect(act.townId && ids.has(act.townId)).toBe(true);
    }
  });

  it("points every exit, reach target and wiki title at something real", () => {
    const ids = new Set(allAreas.map((area) => area.id));
    const actIndexOf = new Map<string, number>();
    for (const [index, act] of route.acts.entries()) {
      for (const area of act.areas) actIndexOf.set(area.id, index);
    }
    for (const area of allAreas) {
      for (const exit of area.exits) expect(ids.has(exit)).toBe(true);
      for (const objective of area.objectives) {
        if (!objective.targetAreaId) continue;
        expect(ids.has(objective.targetAreaId)).toBe(true);
        const from = actIndexOf.get(area.id) ?? 0;
        const to = actIndexOf.get(objective.targetAreaId) ?? 0;
        expect(to - from).toBeLessThanOrEqual(1);
        expect(to - from).toBeGreaterThanOrEqual(0);
      }
      if (area.wiki) expect(wikiUrl(area)).toBeDefined();
    }
  });

  it("keeps every act key distinct and ordered part 1 then part 2", () => {
    const keys = route.acts.map((act) => actKey(act.part, act.act));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["1-1", "1-2", "1-3", "1-4", "2-1", "2-2", "2-3"]);
  });
});

describe("bundled route against the observed area ids", () => {
  const observedCampaignIds = [...OBSERVED.keys()].filter((id) => CAMPAIGN_ID.test(id));

  it("covers every campaign id ever seen in a real log", () => {
    expect(observedCampaignIds.length).toBeGreaterThanOrEqual(150);
    const unresolved = observedCampaignIds.filter(
      (id) => resolveArea(merged, id, areaInfo(id)).kind !== "known",
    );
    expect(unresolved).toEqual([]);
  });

  it("resolves every legacy Cruel id to its part-1 area with isCruel", () => {
    const cruel = observedCampaignIds.filter((id) => id.startsWith("C_"));
    expect(cruel.length).toBeGreaterThan(40);
    for (const id of cruel) {
      const resolution = resolveArea(merged, id, areaInfo(id));
      expect(resolution.kind).toBe("known");
      expect(resolution.isCruel).toBe(true);
      expect(campaignIdParts(id)?.part).toBe(1);
    }
  });

  it("keeps the route level inside the observed instance-level range", () => {
    const offenders: string[] = [];
    for (const id of observedCampaignIds) {
      if (id.startsWith("C_")) continue; // Cruel instances run 45-64 whatever the route says.
      if (LEVEL_EXCEPTIONS.has(id)) continue;
      const resolution = resolveArea(merged, id, areaInfo(id));
      const area = resolution.area;
      if (!area) continue;
      const [min, max] = OBSERVED.get(id) ?? [0, 0];
      if (area.level < min - 1 || area.level > max + 1) {
        offenders.push(`${id}: route ${area.level}, observed ${min}-${max}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
