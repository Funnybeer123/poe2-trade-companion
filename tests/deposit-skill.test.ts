import { describe, expect, it } from "vitest";
import { perceiveUi } from "../src/core/uiPerception.js";
import { DepositBagToStash, type Skill } from "../src/core/skills.js";
import type { UiFacts } from "../src/core/uiPerception.js";

function planAction(skill: Skill, facts: UiFacts) {
  return skill.plan(facts);
}
import { runSkill } from "../src/core/skillRunner.js";
import {
  busyWorldFrame,
  chestTemplates,
  hudTemplates,
  optionsFrame,
  stashAndBagFrame,
  TEST_CLIENT,
  worldChestFrame,
} from "./perceptionFixtures.js";

const instant = {
  async wait() {
    /* tests should not sleep */
  },
};

describe("UiPerception fail-closed", () => {
  it("aborts a skill before capture when the emergency stop is latched", async () => {
    let captures = 0;
    const result = await runSkill(
      new DepositBagToStash(),
      {
        async capture() {
          captures += 1;
          return { facts: perceiveUi(stashAndBagFrame([]), TEST_CLIENT, hudTemplates()), client: TEST_CLIENT };
        },
      },
      {
        async click() {
          return { ok: true };
        },
        async hotkey() {
          return { ok: true };
        },
        cancelled: () => true,
      },
    );

    expect(result).toMatchObject({ result: "abort", reason: "cancelled" });
    expect(captures).toBe(0);
  });

  it("does not treat hideout scenery as an open stash or bag", () => {
    const facts = perceiveUi(busyWorldFrame(), TEST_CLIENT);
    expect(facts.stashPanelOpen).toBe(false);
    expect(facts.inventoryPanelOpen).toBe(false);
    expect(facts.occupiedBag).toEqual([]);
    expect(facts.reason).toMatch(/world-or-unknown|needs-calibration/);
    expect(new DepositBagToStash().plan(facts).reason).toBe("looks-like-world");
  });

  it("does not trust a stash-looking frame without calibrated HUD templates", () => {
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT);
    expect(facts.stashPanelOpen).toBe(false);
    expect(facts.inventoryPanelOpen).toBe(false);
    expect(facts.occupiedBag).toEqual([]);
    expect(new DepositBagToStash().plan(facts).kind).toBe("abort");
  });

  it("detects the options menu and blocks gameplay", () => {
    const facts = perceiveUi(optionsFrame(), TEST_CLIENT);
    expect(facts.optionsOpen).toBe(true);
    const step = new DepositBagToStash().plan(facts);
    expect(step.kind).toBe("abort");
    expect(step.reason).toBe("options-open");
  });

  it("clicks the chest only when a chest template matches", () => {
    const unproven = perceiveUi(worldChestFrame(), TEST_CLIENT);
    expect(unproven.stashChestVisible).toBe(false);
    expect(new DepositBagToStash().plan(unproven).reason).toBe("looks-like-world");

    const facts = perceiveUi(worldChestFrame(), TEST_CLIENT, chestTemplates());
    expect(facts.stashPanelOpen).toBe(false);
    expect(facts.stashChestVisible).toBe(true);
    expect(facts.chest).toBeTruthy();
    const step = new DepositBagToStash().plan(facts);
    expect(step.kind).toBe("abort");
    expect(step.reason).toBe("chest-click-disabled");
  });

  it("aborts when stash is not visible at all", () => {
    const facts = perceiveUi(optionsFrame(), TEST_CLIENT);
    facts.optionsOpen = false;
    facts.stashPanelOpen = false;
    facts.stashChestVisible = false;
    facts.confidence = 0.4;
    expect(new DepositBagToStash().plan(facts).reason).toBe("looks-like-world");
  });

  it("does not issue a speculative right-click before depositing", () => {
    const skill = new DepositBagToStash();
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    const step = skill.plan(facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions.every((action) => action.kind === "click" && action.button !== "right")).toBe(true);
    }
  });

  it("ctrl-clicks only occupied bag cells when both panels are proven open", async () => {
    const templates = hudTemplates();
    const first = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }, { row: 2, col: 3 }]), TEST_CLIENT, templates);
    expect(first.stashPanelOpen).toBe(true);
    expect(first.inventoryPanelOpen).toBe(true);
    expect(first.occupiedBag.length).toBeGreaterThanOrEqual(1);

    const frames = [
      first,
      perceiveUi(stashAndBagFrame([{ row: 2, col: 3 }]), TEST_CLIENT, templates),
      perceiveUi(stashAndBagFrame([]), TEST_CLIENT, templates),
    ];
    let index = 0;
    const clicks: Array<{ x: number; y: number; ctrl?: boolean }> = [];
    const result = await runSkill(
      new DepositBagToStash(),
      {
        async capture() {
          const facts = frames[Math.min(index, frames.length - 1)]!;
          index += 1;
          return { facts, client: TEST_CLIENT };
        },
      },
      {
        async click(x, y, ctrl) {
          clicks.push({ x, y, ctrl });
          return { ok: true };
        },
        async hotkey() {
          return { ok: true };
        },
        async drag() {
          return { ok: true };
        },
        async rightClick() {
          return { ok: true };
        },
        ...instant,
      },
    );
    expect(result.result).toBe("done");
    expect(clicks.some((click) => click.ctrl)).toBe(true);
    expect(clicks.length).toBeGreaterThanOrEqual(1);
    expect(clicks.length).toBeLessThanOrEqual(12);
  });

  it("does not click a cell again after it is cleared", async () => {
    const templates = hudTemplates();
    const skill = new DepositBagToStash();
    const occupied = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, templates);
    const first = planAction(skill, occupied);
    expect(first.kind).toBe("burst");
    const empty = perceiveUi(stashAndBagFrame([]), TEST_CLIENT, templates);
    empty.occupiedStash = [
      ...occupied.occupiedStash,
      { row: 11, col: 11, x: 780, y: 740, bag: "stash" },
    ];
    const second = skill.plan(empty);
    expect(second).toMatchObject({ kind: "wait", reason: "confirm-bag-empty" });
    expect(skill.plan(empty)).toMatchObject({ kind: "done", reason: "bag-empty" });
  });

  it("does not deposit while a vendor inventory is open", () => {
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 1 }]), TEST_CLIENT, hudTemplates());
    facts.vendorPanelOpen = true;
    expect(new DepositBagToStash().plan(facts).reason).toBe("vendor-open");
  });

  it("retries leftovers without changing Ctrl-click semantics", () => {
    const skill = new DepositBagToStash();
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    const first = planAction(skill, facts);
    expect(first.kind).toBe("burst");
    if (first.kind === "burst") {
      expect(first.reason).toMatch(/^deposit-\d+-items$/);
      expect(first.shift).toBeFalsy();
    }
    const retry = skill.plan(facts);
    expect(retry.kind).toBe("burst");
    if (retry.kind === "burst") {
      expect(retry.reason).toMatch(/^deposit-retry-\d+-items$/);
      expect(retry.shift).toBeFalsy();
    }
    const stuck = skill.plan(facts);
    expect(stuck.kind).toBe("burst");
    if (stuck.kind === "burst") {
      expect(stuck.reason).toMatch(/^deposit-retry-\d+-items$/);
      expect(stuck.shift).toBeFalsy();
      expect(stuck.actions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("deposits at most eight bag items per ctrl burst", () => {
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    facts.occupiedBag = Array.from({ length: 12 }, (_, i) => ({
      row: Math.floor(i / 6) * 2,
      col: (i % 6) * 2,
      x: 1100 + (i % 6) * 40,
      y: 340 + Math.floor(i / 6) * 80,
    }));
    const step = planAction(new DepositBagToStash(), facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions).toHaveLength(8);
      expect(step.shift).toBeFalsy();
    }
  });

  it("fails closed instead of manually dropping a rejected leftover", () => {
    const skill = new DepositBagToStash([
      { key: "5,0", x: 120, y: 160, row: 5, col: 0, w: 1, h: 1 },
    ]);
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    expect(planAction(skill, facts).reason).toMatch(/^deposit-\d+-items$/);
    expect(skill.plan(facts).reason).toMatch(/^deposit-retry-/);
    expect(skill.plan(facts).reason).toMatch(/^deposit-retry-/);
    const stopped = skill.plan(facts);
    expect(stopped).toMatchObject({ kind: "done", reason: "failed" });
    expect(skill.returnedTo).toEqual([]);
  });

  it("never picks up a leftover when the full return footprint is blocked", () => {
    const skill = new DepositBagToStash([
      { key: "5,4", x: 360, y: 430, row: 5, col: 4, w: 2, h: 3 },
    ]);
    const bagArmour = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 0 },
      { row: 2, col: 1 },
    ];
    const facts = perceiveUi(stashAndBagFrame(bagArmour), TEST_CLIENT, hudTemplates());
    facts.occupiedStash = Array.from({ length: 12 * 12 }, (_, i) => ({
      row: Math.floor(i / 12),
      col: i % 12,
      x: 100,
      y: 100,
      bag: "stash",
    })).filter((cell) => !(cell.row === 0 && cell.col < 3));
    const reasons: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const step = skill.plan(facts);
      reasons.push(step.reason);
      if (step.kind === "done" || step.kind === "abort") break;
    }
    expect(reasons).not.toContain("return-leftover-pickup");
    expect(reasons).not.toContain("return-leftover-drop");
  });

  it("does not drag leftovers after Ctrl-click retries", () => {
    const skill = new DepositBagToStash();
    const facts = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    expect(planAction(skill, facts).reason).toMatch(/^deposit-\d+-items$/);
    expect(skill.plan(facts).reason).toMatch(/^deposit-retry-/);
    expect(skill.plan(facts).reason).toMatch(/^deposit-retry-/);
    let next = skill.plan(facts);
    while (next.reason.startsWith("deposit-retry-")) next = skill.plan(facts);
    expect(next).toMatchObject({ kind: "done", reason: "failed" });
    expect(next.reason.startsWith("drag-")).toBe(false);
  });

  it("covers every occupied bag cell so touching items cannot hide each other", () => {
    const facts = perceiveUi(
      stashAndBagFrame([
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
        { row: 0, col: 3 },
      ]),
      TEST_CLIENT,
      hudTemplates(),
    );
    const step = planAction(new DepositBagToStash(), facts);
    expect(step.kind).toBe("burst");
    if (step.kind === "burst") {
      expect(step.actions).toHaveLength(5);
      expect(step.actions.every((action) => action.kind === "click")).toBe(true);
    }
  });

  it("does not declare success after a panel flicker", () => {
    const skill = new DepositBagToStash();
    const occupied = perceiveUi(
      stashAndBagFrame([
        { row: 0, col: 0 },
        { row: 0, col: 2 },
        { row: 2, col: 0 },
      ]),
      TEST_CLIENT,
      hudTemplates(),
    );
    expect(planAction(skill, occupied).kind).toBe("burst");
    const fewer = perceiveUi(stashAndBagFrame([{ row: 2, col: 0 }]), TEST_CLIENT, hudTemplates());
    expect(skill.plan(fewer)).toMatchObject({ kind: "wait", reason: "confirm-deposit-burst" });
    const flicker: UiFacts = {
      ...fewer,
      stashPanelOpen: false,
      inventoryPanelOpen: false,
      inventoryRegion: undefined,
      stashRegion: undefined,
      occupiedBag: [],
      bagEmpty: false,
      reason: "world-or-unknown",
    };
    expect(skill.plan(flicker)).toMatchObject({ kind: "wait", reason: "confirm-stash" });
    expect(skill.plan(flicker).reason).not.toBe("bag-empty");
  });

  it("requires two open-panel empty observations before success", () => {
    const skill = new DepositBagToStash();
    const occupied = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    expect(planAction(skill, occupied).kind).toBe("burst");
    const empty = perceiveUi(stashAndBagFrame([]), TEST_CLIENT, hudTemplates());
    empty.occupiedStash = [
      ...occupied.occupiedStash,
      { row: 11, col: 11, x: 780, y: 740, bag: "stash" },
    ];
    expect(skill.plan(empty)).toMatchObject({ kind: "wait", reason: "confirm-bag-empty" });
    const flicker: UiFacts = {
      ...empty,
      stashPanelOpen: false,
      inventoryPanelOpen: false,
      inventoryRegion: undefined,
      stashRegion: undefined,
      occupiedBag: [],
      bagEmpty: false,
      reason: "world-or-unknown",
    };
    expect(skill.plan(flicker)).toMatchObject({ kind: "wait", reason: "confirm-stash" });
    expect(skill.plan(empty)).toMatchObject({ kind: "wait", reason: "confirm-bag-empty" });
    expect(skill.plan(empty)).toMatchObject({ kind: "done", reason: "bag-empty" });
  });

  it("does not press I after deposit clicks have started", () => {
    const skill = new DepositBagToStash();
    const open = perceiveUi(stashAndBagFrame([{ row: 0, col: 0 }]), TEST_CLIENT, hudTemplates());
    expect(planAction(skill, open).kind).toBe("burst");
    const lost = { ...open, inventoryPanelOpen: false, occupiedBag: [] };
    expect(skill.plan(lost).reason).toBe("wait-bag-reacquire");
    skill.plan(lost);
    skill.plan(lost);
    const aborted = skill.plan(lost);
    expect(aborted.reason).toBe("failed");
    expect(aborted.reason).not.toBe("open-bag");
  });

  it("opens the bag with I only after stash is proven open", () => {
    const facts = perceiveUi(stashAndBagFrame([]), TEST_CLIENT, hudTemplates());
    facts.inventoryPanelOpen = false;
    facts.occupiedBag = [];
    const step = new DepositBagToStash().plan(facts);
    expect(step.kind).toBe("act");
    if (step.kind === "act") {
      expect(step.reason).toBe("open-bag");
      expect(step.action.key).toBe("I");
    }
  });
});
