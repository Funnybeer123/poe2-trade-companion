import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultCampaignGuideSettings,
  mergeCampaignRoute,
  parseCampaignRoute,
  type CampaignGuideSettings,
} from "../src/core/campaignGuide.js";
import { layoutCampaignMap, mapNodeClass } from "../src/core/campaignGuideMap.js";

const MINI = parseCampaignRoute(
  readFileSync(path.join(process.cwd(), "fixtures", "campaign-guide", "route-mini.json"), "utf8"),
).route;

function layout(settings: CampaignGuideSettings = defaultCampaignGuideSettings(), includeHidden = false) {
  return layoutCampaignMap(mergeCampaignRoute(MINI, settings), { includeHidden });
}

describe("layoutCampaignMap", () => {
  it("places one lane per act with the main path on the spine", () => {
    const result = layout();
    expect(result.lanes).toEqual([
      { key: "1-1", label: "Act 1", y: 48 },
      { key: "1-2", label: "Act 2", y: 168 },
    ]);
    const byId = Object.fromEntries(result.nodes.map((node) => [node.id, node]));
    expect([byId.G1_1.x, byId.G1_1.y]).toEqual([48, 48]);
    expect([byId.G1_2.x, byId.G1_2.y]).toEqual([166, 48]);
    expect([byId.G1_town.x, byId.G1_town.y]).toEqual([284, 48]);
    expect([byId.G2_1.x, byId.G2_1.y]).toEqual([48, 168]);
    expect(result.viewBox).toEqual({ width: 332, height: 288 });
  });

  it("hangs a side area under the main area it connects to", () => {
    const byId = Object.fromEntries(layout().nodes.map((node) => [node.id, node]));
    expect(byId.G1_3.branch).toBe(true);
    expect([byId.G1_3.x, byId.G1_3.y]).toEqual([225, 100]);
  });

  it("flags the cross-act edge and drops nothing else", () => {
    const result = layout();
    expect(result.edges).toEqual([
      { from: "G1_1", to: "G1_2", crossAct: false },
      { from: "G1_2", to: "G1_3", crossAct: false },
      { from: "G1_2", to: "G1_town", crossAct: false },
      { from: "G1_3", to: "G1_2", crossAct: false },
      { from: "G1_town", to: "G2_1", crossAct: true },
    ]);
  });

  it("excludes hidden areas unless asked", () => {
    const hidden = {
      ...defaultCampaignGuideSettings(),
      customisations: { ...defaultCampaignGuideSettings().customisations, hiddenAreaIds: ["G1_3"] },
    };
    expect(layout(hidden).nodes.some((node) => node.id === "G1_3")).toBe(false);
    expect(layout(hidden, true).nodes.some((node) => node.id === "G1_3")).toBe(true);
    // Edges to a dropped node go with it.
    expect(layout(hidden).edges.some((edge) => edge.to === "G1_3")).toBe(false);
  });
});

describe("mapNodeClass", () => {
  it("names the states the stylesheet keys off", () => {
    const byId = Object.fromEntries(layout().nodes.map((node) => [node.id, node]));
    expect(mapNodeClass(byId.G1_1, { visited: new Set() })).toBe("node");
    expect(
      mapNodeClass(byId.G1_town, { currentId: "G1_town", visited: new Set(["G1_town"]), selectedId: "G1_town" }),
    ).toBe("node town current visited selected");
    expect(mapNodeClass(byId.G1_2, { visited: new Set(["G1_2"]) })).toBe("node waypoint visited");
    expect(mapNodeClass(byId.G1_3, { visited: new Set() })).toBe("node branch");
  });
});
