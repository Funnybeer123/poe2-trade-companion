import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import { createGray, fillRect } from "../src/core/grayImage.js";
import {
  groupItemsByRoute,
  loadTabRoutes,
  routeForClass,
  saveTabRoutes,
  signatureDistance,
  stashContentSignature,
  tabGuardBoxes,
  type TabRoutesConfig,
} from "../src/core/tabRouter.js";
import { validateTransferInput } from "../src/core/transferInputGuard.js";

const CONFIG: TabRoutesConfig = {
  version: 1,
  client: { width: 1600, height: 900 },
  source: { label: "dump", x: 100, y: 60 },
  routes: [
    { tab: { label: "jewelry", x: 260, y: 60 }, classes: ["Rings", "Amulets"] },
    { tab: { label: "armour", x: 420, y: 60 }, classes: ["Body Armours"] },
  ],
};

describe("tabRouter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tab-router-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the routes config and tolerates a UTF-8 BOM", () => {
    saveTabRoutes(dir, CONFIG);
    expect(loadTabRoutes(dir)).toEqual(CONFIG);
    expect(loadTabRoutes(path.join(dir, "missing"))).toBeUndefined();
    const file = path.join(dir, "tab-routes.json");
    writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify(CONFIG));
    expect(loadTabRoutes(dir)).toEqual(CONFIG);
  });

  it("routes item classes case-insensitively and groups the rest as unrouted", () => {
    expect(routeForClass(CONFIG, "rings")?.tab.label).toBe("jewelry");
    expect(routeForClass(CONFIG, "Body Armours")?.tab.label).toBe("armour");
    expect(routeForClass(CONFIG, "Wands")).toBeUndefined();
    expect(routeForClass(CONFIG, undefined)).toBeUndefined();

    const groups = groupItemsByRoute(
      [
        { id: "a", itemClass: "Rings" },
        { id: "b", itemClass: "Amulets" },
        { id: "c", itemClass: "Body Armours" },
        { id: "d", itemClass: "Quivers" },
        { id: "e" },
      ],
      CONFIG,
    );
    expect(groups.byLabel.get("jewelry")!.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups.byLabel.get("armour")!.items.map((entry) => entry.id)).toEqual(["c"]);
    expect(groups.unrouted.map((entry) => entry.id)).toEqual(["d", "e"]);
  });

  it("lets the input guard accept calibrated tab clicks and still reject strays", () => {
    const profile = {
      ...emptyProfile(1600, 900),
      stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
    };
    const client = { left: 0, top: 0, width: 1600, height: 900 };
    const tabClick = [{ kind: "click" as const, x: 260, y: 60 }];
    expect(validateTransferInput(tabClick, profile, client).ok).toBe(false);
    expect(validateTransferInput(tabClick, profile, client, tabGuardBoxes(CONFIG)).ok).toBe(true);
    expect(
      validateTransferInput([{ kind: "click", x: 800, y: 60 }], profile, client, tabGuardBoxes(CONFIG)).ok,
    ).toBe(false);
  });

  it("signature distance separates a tab change from an unchanged tab", () => {
    const client = { left: 0, top: 0, width: 400, height: 300 };
    const region = { x: 40, y: 40, w: 240, h: 200 };
    const tabA = createGray(400, 300, 20);
    fillRect(tabA, 60, 60, 80, 60, 180);
    const tabASame = createGray(400, 300, 20);
    fillRect(tabASame, 60, 60, 80, 60, 180);
    const tabB = createGray(400, 300, 20);
    fillRect(tabB, 160, 120, 100, 80, 140);

    const sigA = stashContentSignature(tabA, client, region);
    expect(signatureDistance(sigA, stashContentSignature(tabASame, client, region))).toBeLessThan(1);
    expect(signatureDistance(sigA, stashContentSignature(tabB, client, region))).toBeGreaterThan(10);
  });
});
