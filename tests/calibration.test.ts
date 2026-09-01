import { describe, expect, it } from "vitest";
import {
  activeStashGrid,
  applyStashPanel,
  emptyProfile,
  packNpcPatch,
  packPatch,
  profileReadyForDeposit,
  profileReadyForWalk,
  resolveStashGrids,
  stashAreasDiverge,
  stashGridForKind,
  stashSearchBox,
  stampStashPanel,
  toPlain,
} from "../src/core/calibrationProfile.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { perceiveUi } from "../src/core/uiPerception.js";
import { loadProfile, resetProfile, saveProfile } from "../src/core/calibrationStore.js";
import { fillRect } from "../src/core/grayImage.js";
import { busyWorldFrame, paintGridSprite, quadStashAndBagFrame, stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function hudProfile() {
  const frame = stashAndBagFrame([{ row: 0, col: 1 }]);
  return {
    ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
    stashGrid: {
      x: 80,
      y: 144,
      w: 736,
      h: 630,
      cols: 12,
      rows: 12,
      patch: packPatch(frame, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
    },
    bagGrid: {
      x: 1048,
      y: 324,
      w: 480,
      h: 450,
      cols: 12,
      rows: 5,
      patch: packPatch(frame, TEST_CLIENT, { x: 1048, y: 324, w: 480, h: 450 }),
    },
    npcs: [
      {
        id: "stash",
        label: "Stash",
        x: 800,
        y: 520,
        patch: packNpcPatch(frame, TEST_CLIENT, 800, 520),
      },
    ],
  };
}

describe("in-app calibration profile", () => {
  it("treats user-marked grids as stash/bag and uses the drawn bag grid", () => {
    const profile = hudProfile();
    expect(profileReadyForDeposit(profile)).toBe(true);
    expect(profileReadyForWalk(profile)).toBe(true);
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT, {}, profile);
    expect(facts.stashPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(true);
    expect(facts.vendorPanelOpen).toBe(false);
    expect(facts.reason).toBe("stash-and-bag-open");
    expect(facts.inventoryRegion).toEqual({ x: 1048, y: 324, w: 480, h: 450 });
    expect(facts.occupiedBag.some((cell) => cell.row === 0 && cell.col === 1)).toBe(true);
  });

  it("reports a vendor inventory separately from the player bag", () => {
    const bag = hudProfile().bagGrid;
    const profile = { ...hudProfile(), bagGrid: undefined, stashGrid: undefined, ventorBagGrid: bag };
    expect(profileReadyForDeposit(profile)).toBe(false);
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT, {}, profile);
    expect(facts.vendorPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(false);
    expect(facts.reason).toBe("vendor-open");
    expect(facts.occupiedBag).toEqual([]);
  });

  it("does not treat an overlapping vendor mark as the player bag", () => {
    const bag = hudProfile().bagGrid!;
    const profile = { ...hudProfile(), stashGrid: undefined, ventorBagGrid: bag };
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT, {}, profile);
    expect(facts.vendorPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(false);
    expect(facts.reason).toBe("vendor-open");
  });

  it("keeps stash and bag open after the bag items change", () => {
    const filled = Array.from({ length: 12 }, (_, col) => ({ row: 0, col }));
    const packed = stashAndBagFrame(filled);
    const profile = {
      ...hudProfile(),
      stashGrid: {
        x: 80,
        y: 144,
        w: 736,
        h: 630,
        cols: 12,
        rows: 12,
        patch: packPatch(packed, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      bagGrid: {
        x: 1048,
        y: 324,
        w: 480,
        h: 450,
        cols: 12,
        rows: 5,
        patch: packPatch(packed, TEST_CLIENT, { x: 1048, y: 324, w: 480, h: 450 }),
      },
    };
    const facts = perceiveUi(stashAndBagFrame([]), TEST_CLIENT, {}, profile);
    expect(facts.stashPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(true);
    expect(facts.reason).toBe("stash-and-bag-open");
  });

  it("still sees a recolored bag when stash is open", () => {
    const frame = stashAndBagFrame([{ row: 0, col: 1 }]);
    const invX = 1048;
    const invY = 324;
    const cellW = 480 / 12;
    const cellH = 450 / 5;
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        fillRect(frame, invX + col * cellW + 4, invY + row * cellH + 4, cellW - 8, cellH - 8, col % 2 === 0 ? 40 : 90);
      }
    }
    fillRect(frame, invX + cellW + 6, invY + 6, cellW - 12, cellH - 12, 210);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, hudProfile());
    expect(facts.stashPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(true);
    expect(facts.reason).toBe("stash-and-bag-open");
  });

  it("keeps stash and bag open after the grid fills with different items", () => {
    const profile = hudProfile();
    const frame = stashAndBagFrame(
      Array.from({ length: 12 }, (_, i) => ({ row: Math.floor(i / 6), col: i % 6 })),
      Array.from({ length: 40 }, (_, i) => ({ row: Math.floor(i / 8), col: i % 8 })),
    );
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    expect(facts.stashPanelOpen).toBe(true);
    expect(facts.inventoryPanelOpen).toBe(true);
    expect(facts.reason).toBe("stash-and-bag-open");
  });

  it("does not treat hideout scenery as open just because a profile exists", () => {
    const facts = perceiveUi(busyWorldFrame(), TEST_CLIENT, {}, hudProfile());
    expect(facts.stashPanelOpen).toBe(false);
    expect(facts.inventoryPanelOpen).toBe(false);
    expect(facts.vendorPanelOpen).toBe(false);
    expect(facts.occupiedBag).toEqual([]);
    expect(facts.reason).not.toBe("stash-and-bag-open");
  });

  it("writes both 12×12 and 24×24 grids from one stamped stash panel", () => {
    const box = { x: 80, y: 144, w: 736, h: 630 };
    const profile = stampStashPanel(emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height), box);
    expect(profile.stashGrid).toMatchObject({ ...box, cols: 12, rows: 12 });
    expect(profile.quadStashGrid).toMatchObject({ ...box, cols: 24, rows: 24 });
    expect(resolveStashGrids(profile).shared).toBe(true);
    expect(stashAreasDiverge(profile)).toBe(false);
    expect(activeStashGrid(profile)?.cols).toBe(12);
    expect(activeStashGrid(profile, "quad")?.cols).toBe(24);
    expect(stashGridForKind(profile, "stash-quad")).toMatchObject({ ...box, cols: 24, rows: 24 });
  });

  it("derives the missing stash grid from a single stored panel", () => {
    const box = { x: 80, y: 144, w: 736, h: 630 };
    const profile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      stashGrid: { ...box, cols: 12, rows: 12 },
    };
    const grids = resolveStashGrids(profile);
    expect(grids.shared).toBe(true);
    expect(grids.quad).toMatchObject({ ...box, cols: 24, rows: 24 });
    expect(stashGridForKind(profile, "stash-quad")?.cols).toBe(24);
  });

  it("treats near-identical old stash and quad marks as one shared panel", () => {
    const profile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
      quadStashGrid: { x: 82, y: 140, w: 740, h: 634, cols: 24, rows: 24 },
    };
    const grids = resolveStashGrids(profile);
    expect(grids.shared).toBe(true);
    expect(grids.normal).toMatchObject({ x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 });
    expect(grids.quad).toMatchObject({ x: 80, y: 144, w: 736, h: 630, cols: 24, rows: 24 });
  });

  it("keeps divergent old stash and quad boxes until the panel is re-stamped", () => {
    const profile = {
      ...emptyProfile(TEST_CLIENT.width, TEST_CLIENT.height),
      stashGrid: { x: 20, y: 100, w: 720, h: 720, cols: 12, rows: 12 },
      quadStashGrid: { x: 40, y: 120, w: 600, h: 600, cols: 24, rows: 24 },
    };
    expect(stashAreasDiverge(profile)).toBe(true);
    expect(resolveStashGrids(profile).shared).toBe(false);
    expect(activeStashGrid(profile, "normal")).toMatchObject({ x: 20, y: 100, w: 720, h: 720, cols: 12 });
    expect(activeStashGrid(profile, "quad")).toMatchObject({ x: 40, y: 120, w: 600, h: 600, cols: 24 });
    const combined = stampStashPanel(profile, { x: 80, y: 144, w: 736, h: 630 });
    expect(stashAreasDiverge(combined)).toBe(false);
    expect(combined.stashGrid).toMatchObject({ x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 });
    expect(combined.quadStashGrid).toMatchObject({ x: 80, y: 144, w: 736, h: 630, cols: 24, rows: 24 });
  });

  it("detects a 12×12 tab from one shared panel even when the last hint was quad", () => {
    const frame = stashAndBagFrame([{ row: 0, col: 1 }], [{ row: 2, col: 3 }]);
    const box = { x: 80, y: 144, w: 736, h: 630 };
    const patch = packPatch(frame, TEST_CLIENT, box);
    const profile = {
      ...hudProfile(),
      ...applyStashPanel(box, patch),
      activeStashTab: "quad" as const,
    };
    expect(activeStashGrid(profile)?.cols).toBe(24);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    expect(facts.stashRegion).toEqual(box);
    expect(facts.stashGridSize).toEqual({ cols: 12, rows: 12 });
    expect(activeStashGrid(profile, facts.stashGridSize)?.cols).toBe(12);
  });

  it("detects a 24×24 tab from the same stamped panel", () => {
    const frame = quadStashAndBagFrame([{ row: 0, col: 1 }], [{ row: 0, col: 0 }, { row: 0, col: 3 }]);
    paintGridSprite(frame, { x: 80, y: 144, w: 736, h: 630 }, 24, 24, 2, 3, 1, 1);
    const box = { x: 80, y: 144, w: 736, h: 630 };
    const patch = packPatch(frame, TEST_CLIENT, box);
    const profile = {
      ...hudProfile(),
      ...applyStashPanel(box, patch),
      activeStashTab: "normal" as const,
    };
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    expect(facts.stashRegion).toEqual(box);
    expect(facts.stashGridSize).toEqual({ cols: 24, rows: 24 });
  });

  it("keeps a marked stash search box on the profile", () => {
    const profile = { ...hudProfile(), stashSearch: { x: 220, y: 1548, w: 420, h: 32 } };
    expect(stashSearchBox(profile)).toEqual({ x: 220, y: 1548, w: 420, h: 32 });
    expect(stashSearchBox(hudProfile())).toBeUndefined();
    expect(stashSearchBox({ ...hudProfile(), stashSearch: { x: 1, y: 1, w: 4, h: 4 } })).toBeUndefined();
  });

  it("serializes a profile to a plain object for Electron IPC", () => {
    const profile = hudProfile();
    expect(toPlain(profile).stashGrid?.w).toBe(736);
  });

  it("resets a saved calibration to an empty profile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poe2-cal-"));
    saveProfile(dir, hudProfile());
    expect(loadProfile(dir).stashGrid).toBeTruthy();
    const cleared = resetProfile(dir);
    expect(cleared.stashGrid).toBeUndefined();
    expect(cleared.npcs).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, "calibration.json"), "utf8")).npcs).toEqual([]);
  });
});
