import { describe, expect, it } from "vitest";
import {
  activeStashGrid,
  emptyProfile,
  packNpcPatch,
  packPatch,
  profileReadyForDeposit,
  profileReadyForWalk,
  stashSearchBox,
  toPlain,
} from "../src/core/calibrationProfile.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { perceiveUi } from "../src/core/uiPerception.js";
import { loadProfile, resetProfile, saveProfile } from "../src/core/calibrationStore.js";
import { fillRect } from "../src/core/grayImage.js";
import { busyWorldFrame, stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

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

  it("keeps a quad stash grid and uses the last marked tab when both look open", () => {
    const frame = stashAndBagFrame([{ row: 0, col: 1 }]);
    const profile = {
      ...hudProfile(),
      stashGrid: {
        x: 80,
        y: 144,
        w: 736,
        h: 630,
        cols: 12,
        rows: 12,
        patch: packPatch(frame, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      quadStashGrid: {
        x: 80,
        y: 144,
        w: 736,
        h: 630,
        cols: 24,
        rows: 24,
        patch: packPatch(frame, TEST_CLIENT, { x: 80, y: 144, w: 736, h: 630 }),
      },
      activeStashTab: "quad" as const,
    };
    expect(activeStashGrid(profile)?.cols).toBe(24);
    const facts = perceiveUi(frame, TEST_CLIENT, {}, profile);
    expect(facts.stashRegion).toEqual({ x: 80, y: 144, w: 736, h: 630 });
    expect(activeStashGrid({ ...profile, activeStashTab: "normal" })?.cols).toBe(12);
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
