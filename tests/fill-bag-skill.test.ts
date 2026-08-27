import { describe, expect, it } from "vitest";
import { emptyProfile, packNpcPatch, packPatch } from "../src/core/calibrationProfile.js";
import { FillBagFromStash, type Skill } from "../src/core/skills.js";
import { perceiveUi, type UiFacts } from "../src/core/uiPerception.js";
import { stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

function planAction(skill: Skill, facts: UiFacts) {
  return skill.plan(facts);
}

function hudProfile(stashOccupied: Array<{ row: number; col: number }> = [{ row: 0, col: 0 }]) {
  const frame = stashAndBagFrame([], stashOccupied);
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

describe("FillBagFromStash", () => {
  it("ctrl-clicks a stash item so the game places it in the bag", () => {
    const profile = hudProfile([{ row: 1, col: 2 }]);
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 1, col: 2 }]), TEST_CLIENT, {}, profile);
    expect(facts.occupiedStash.some((cell) => cell.row === 1 && cell.col === 2)).toBe(true);
    const step = planAction(new FillBagFromStash(), facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.reason).toBe("fill-1-items");
      expect(step.actions[0]?.kind).toBe("click");
      expect(step.actions[0]?.x).toBeGreaterThan(0);
    }
  });

  it("uses a rejected non-stackable 1x1 as a full-bag probe", () => {
    const facts = perceiveUi(
      stashAndBagFrame([], [{ row: 1, col: 2 }]),
      TEST_CLIENT,
      {},
      hudProfile([{ row: 1, col: 2 }]),
    );
    const ring = {
      id: "1,2:1x1",
      w: 1,
      h: 1,
      itemClass: "Rings",
      grab: { row: 1, col: 2, x: 220, y: 220, bag: "stash" as const },
      cells: [{ row: 1, col: 2 }],
    };
    facts.stashItems = [ring];
    facts.occupiedBag = Array.from({ length: 59 }, (_, index) => ({
      row: Math.floor(index / 12),
      col: index % 12,
      x: 0,
      y: 0,
      bag: "bag",
    }));
    const skill = new FillBagFromStash([ring], new Set(), true, [], ["Rings"]);

    expect(skill.plan(facts).kind).toBe("burst");
    expect(skill.plan(facts)).toMatchObject({ kind: "done", reason: "no-more-auto-fit" });
  });

  it("polls a vanished source before failing closed and never re-clicks its empty anchor", () => {
    const profile = hudProfile([{ row: 1, col: 2 }]);
    const before = perceiveUi(
      stashAndBagFrame([], [{ row: 1, col: 2 }]),
      TEST_CLIENT,
      {},
      profile,
    );
    const skill = new FillBagFromStash(before.stashItems);
    expect(planAction(skill, before).kind).toBe("burst");
    const ambiguous = perceiveUi(stashAndBagFrame([]), TEST_CLIENT, {}, profile);

    expect(skill.plan(ambiguous)).toMatchObject({ kind: "wait", reason: "confirm-fill-burst" });
    expect(planAction(skill, ambiguous)).toMatchObject({ kind: "done", reason: "failed" });
  });

  it("reports no-more-auto-fit when the remaining item is too large", () => {
    const profile = hudProfile([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
    ]);
    const facts = perceiveUi(
      stashAndBagFrame([], [
        { row: 0, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 1 },
      ]),
      TEST_CLIENT,
      {},
      profile,
    );
    facts.occupiedBag = Array.from({ length: 59 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 0,
      y: 0,
    }));
    expect(planAction(new FillBagFromStash(), facts).reason).toBe("no-more-auto-fit");
  });

  it("withdraws only enough items to fill remaining bag cells in one burst", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = Array.from({ length: 20 }, (_, index) => ({
      id: `0,${index}:1x1`,
      w: 1,
      h: 1,
      grab: { row: 0, col: index, x: 90 + index * 10, y: 160, bag: "stash" },
      cells: [{ row: 0, col: index, x: 90 + index * 10, y: 160, bag: "stash" }],
    }));
    facts.occupiedStash = facts.stashItems.flatMap((item) =>
      item.cells.map((cell) => ({ ...cell, x: item.grab.x, y: item.grab.y })),
    );
    facts.occupiedBag = [];
    const skill = new FillBagFromStash(undefined, new Set(), true);
    const step = planAction(skill, facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions.length).toBeLessThanOrEqual(12);
    }
    const retry = skill.plan(facts);
    expect(retry.kind).toBe("burst");
    if (retry.kind === "burst") expect(retry.actions).toHaveLength(1);
  });

  it("stops filling when many stash clicks are not landing in the bag", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = Array.from({ length: 24 }, (_, index) => ({
      id: `${index},8:1x1`,
      w: 1,
      h: 1,
      grab: { row: index, col: 8, x: 140, y: 160 + index * 10 },
      cells: [{ row: index, col: 8 }],
    }));
    facts.occupiedStash = facts.stashItems.flatMap((item) =>
      item.cells.map((cell) => ({ ...cell, x: item.grab.x, y: item.grab.y, bag: "stash" })),
    );
    facts.occupiedBag = Array.from({ length: 4 }, (_, i) => ({ row: 0, col: i, x: 0, y: 0 }));
    const skill = new FillBagFromStash(undefined, new Set(), true);
    expect(planAction(skill, facts).kind).toBe("burst");
    const retry = skill.plan(facts);
    expect(retry.kind).toBe("burst");
    if (retry.kind === "burst") expect(retry.actions).toHaveLength(1);
    expect(skill.plan(facts).kind).toBe("burst");
  });

  it("keeps filling past a 32-cell occupancy report", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = [
      {
        id: "0,4:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 4, x: 140, y: 160 },
        cells: [{ row: 0, col: 4 }],
      },
    ];
    facts.occupiedBag = Array.from({ length: 34 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 0,
      y: 0,
    }));
    const step = planAction(new FillBagFromStash(undefined, new Set(), true), facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") expect(step.actions[0]).toMatchObject({ x: 140, y: 160 });
  });

  it("keeps withdrawing until all 60 physical bag cells are occupied", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = [
      {
        id: "0,4:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 4, x: 140, y: 160 },
        cells: [{ row: 0, col: 4 }],
      },
    ];
    facts.occupiedBag = Array.from({ length: 48 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 0,
      y: 0,
    }));
    const skill = new FillBagFromStash(undefined, new Set(), true);
    const first = planAction(skill, facts);
    expect(first.kind).toBe("burst");
  });

  it("ctrl-clicks identified sizes instead of re-reading visual sprite sizes", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = [];
    const known = [
      {
        id: "0,0:2x4",
        w: 2,
        h: 4,
        grab: { row: 0, col: 0, x: 90, y: 160 },
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 1, col: 0 },
          { row: 1, col: 1 },
          { row: 2, col: 0 },
          { row: 2, col: 1 },
          { row: 3, col: 0 },
          { row: 3, col: 1 },
        ],
      },
      {
        id: "0,3:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 3, x: 130, y: 160 },
        cells: [{ row: 0, col: 3 }],
      },
    ];
    facts.occupiedStash = known.flatMap((entry) =>
      entry.cells.map((cell) => ({ ...cell, x: entry.grab.x, y: entry.grab.y, bag: "stash" })),
    );
    const exclude = new Set<string>();
    const withdrawn: typeof known = [];
    const skill = new FillBagFromStash(known, exclude, false, withdrawn);
    const first = planAction(skill, facts);
    expect(first.kind).toBe("burst");
    if (first.kind === "burst") {
      expect(first.actions).toHaveLength(2);
      expect(first.actions[0]).toMatchObject({ kind: "click", x: 90, y: 160 });
    }
    const afterFacts = {
      ...facts,
      occupiedStash: [],
      occupiedBag: Array.from({ length: 9 }, (_, i) => ({
        row: Math.floor(i / 12),
        col: i % 12,
        x: i,
        y: 0,
        bag: "bag",
      })),
    };
    expect(skill.plan(afterFacts)).toMatchObject({ kind: "done", reason: "source-empty" });
    expect(withdrawn).toHaveLength(2);
    expect(exclude).toEqual(new Set(["0,0", "0,3"]));
  });

  it("only withdraws identified items that still fit the remaining bag", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.occupiedBag = Array.from({ length: 59 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 0,
      y: 0,
    }));
    const skill = new FillBagFromStash([
      {
        id: "0,0:2x4",
        w: 2,
        h: 4,
        grab: { row: 0, col: 0, x: 90, y: 160 },
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 1, col: 0 },
          { row: 1, col: 1 },
          { row: 2, col: 0 },
          { row: 2, col: 1 },
          { row: 3, col: 0 },
          { row: 3, col: 1 },
        ],
      },
      {
        id: "0,3:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 3, x: 130, y: 160 },
        cells: [{ row: 0, col: 3 }],
      },
    ]);
    const step = planAction(skill, facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions).toHaveLength(1);
      expect(step.actions[0]).toMatchObject({ kind: "click", x: 130, y: 160 });
    }
  });

  it("greedy fill skips excluded stash cells and prefers leftover 1x1s", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashItems = [
      {
        id: "0,0:2x2",
        w: 2,
        h: 2,
        grab: { row: 0, col: 0, x: 90, y: 160 },
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 1, col: 0 },
          { row: 1, col: 1 },
        ],
      },
      {
        id: "0,4:1x1",
        w: 1,
        h: 1,
        grab: { row: 0, col: 4, x: 140, y: 160 },
        cells: [{ row: 0, col: 4 }],
      },
    ];
    facts.occupiedBag = Array.from({ length: 20 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 0,
      y: 0,
    }));
    const exclude = new Set(["0,0", "0,1", "1,0", "1,1"]);
    const step = planAction(new FillBagFromStash(undefined, exclude, true), facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions).toHaveLength(1);
      expect(step.actions[0]).toMatchObject({ x: 140, y: 160 });
    }
  });

  it("waits before treating a mid-fill world look as closed", () => {
    const skill = new FillBagFromStash();
    const open = perceiveUi(stashAndBagFrame([], [{ row: 1, col: 2 }]), TEST_CLIENT, {}, hudProfile([{ row: 1, col: 2 }]));
    expect(planAction(skill, open).kind).toBe("burst");
    const world: UiFacts = {
      ...open,
      stashPanelOpen: false,
      inventoryPanelOpen: false,
      inventoryRegion: undefined,
      stashChestVisible: false,
      chest: undefined,
      reason: "world-or-unknown",
    };
    expect(skill.plan(world)).toMatchObject({ kind: "wait", reason: "confirm-panels" });
    for (let i = 0; i < 5; i += 1) expect(skill.plan(world).kind).toBe("wait");
    expect(skill.plan(world)).toMatchObject({ kind: "abort", reason: "failed" });
  });

  it("does not click the stash nameplate while that path is disabled", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.stashPanelOpen = false;
    facts.inventoryPanelOpen = false;
    facts.inventoryRegion = undefined;
    facts.stashChestVisible = true;
    facts.chest = { x: 800, y: 520, w: 80, h: 24 };
    facts.reason = "chest-visible";
    const step = new FillBagFromStash().plan(facts);
    expect(step).toMatchObject({ kind: "abort", reason: "chest-click-disabled" });
  });

  it("does not withdraw while a vendor is open", () => {
    const facts = perceiveUi(stashAndBagFrame([], [{ row: 0, col: 0 }]), TEST_CLIENT, {}, hudProfile());
    facts.vendorPanelOpen = true;
    expect(new FillBagFromStash().plan(facts).reason).toBe("vendor-open");
  });
});
