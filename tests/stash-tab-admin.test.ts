import { describe, expect, it } from "vitest";
import {
  COLOUR_GRID,
  GEAR_SLOT_TABS,
  STASH_TAB_COLOURS,
  buildGearTabPlan,
  colourByName,
  colourPoint,
  highlightQueryForSlot,
  isDrainableRemoveOnlyLabel,
  isQuadTab,
  isProtectedTabLabel,
  isRemoveOnlyTabLabel,
  looksPricedTabLabel,
  slotForItemClass,
  validateStashTabPlan,
  type StashTabPlan,
  type StashTabState,
} from "../src/core/stashTabAdmin.js";

const tab = (label: string, extra: Partial<StashTabState> = {}): StashTabState => ({
  index: 0,
  label,
  gridCols: 24,
  occupiedCells: 0,
  ...extra,
});

describe("colour palette", () => {
  it("exposes exactly the 27 selectable swatches", () => {
    expect(STASH_TAB_COLOURS).toHaveLength(COLOUR_GRID.rows * COLOUR_GRID.cols);
    expect(new Set(STASH_TAB_COLOURS.map((colour) => colour.name)).size).toBe(27);
  });

  it("maps swatches onto the sampled dialog lattice", () => {
    expect(colourPoint({ row: 0, col: 0 })).toEqual({ x: 356, y: 648 });
    expect(colourPoint({ row: 2, col: 8 })).toEqual({ x: 356 + 8 * 76, y: 648 + 2 * 82 });
  });

  it("refuses the preview column, which is not selectable", () => {
    expect(() => colourPoint({ row: 0, col: 9 })).toThrow(/out of range/);
  });
});

describe("gear slot layout", () => {
  it("covers the nine requested equipment slots with unique names and colours", () => {
    expect(GEAR_SLOT_TABS).toHaveLength(9);
    expect(new Set(GEAR_SLOT_TABS.map((slot) => slot.tabName)).size).toBe(9);
    expect(new Set(GEAR_SLOT_TABS.map((slot) => slot.colour)).size).toBe(9);
    for (const slot of GEAR_SLOT_TABS) expect(colourByName(slot.colour)).toBeDefined();
  });

  it("routes item classes to their slot", () => {
    expect(slotForItemClass("Helmets")?.key).toBe("helmets");
    expect(slotForItemClass("body armours")?.key).toBe("body-armours");
    expect(slotForItemClass("Quivers")?.key).toBe("off-hands");
    expect(slotForItemClass("Crossbows")?.key).toBe("weapons");
    expect(slotForItemClass("Waystones")).toBeUndefined();
  });

  it("builds a highlight query naming every class in the slot", () => {
    const query = highlightQueryForSlot(GEAR_SLOT_TABS.find((slot) => slot.key === "off-hands")!);
    expect(query).toBe('"class: Shields" "class: Bucklers" "class: Foci" "class: Quivers"');
  });
});

describe("buildGearTabPlan", () => {
  it("only assigns tabs the caller marked editable", () => {
    const tabs = [tab("Scratch A"), tab("Scratch B"), tab("Someone Else's Tab")];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["Scratch A", "Scratch B"] });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["Scratch A", "Scratch B"]);
    expect(plan.unassigned).toHaveLength(7);
  });

  it("never assigns a priced tab even when it is marked editable", () => {
    const tabs = [tab("~price 5 exalted"), tab("Scratch")];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["~price 5 exalted", "Scratch"] });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.targetLabel).toBe("Scratch");
  });

  it("never assigns a Remove-only tab even when it is marked editable", () => {
    const tabs = [tab("Rit (Remove-only)"), tab("Scratch")];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["Rit (Remove-only)", "Scratch"] });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["Scratch"]);
  });

  it("can require quad tabs", () => {
    const tabs = [tab("Normal", { gridCols: 12 }), tab("Quad", { gridCols: 24 })];
    const plan = buildGearTabPlan(tabs, {
      editableLabels: ["Normal", "Quad"],
      requireQuad: true,
    });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["Quad"]);
  });

  it("fills the emptiest tabs first among equally sized ones", () => {
    const tabs = [
      tab("Busy", { index: 0, occupiedCells: 300 }),
      tab("Empty", { index: 1, occupiedCells: 0 }),
    ];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["Busy", "Empty"] });
    expect(plan.assignments[0]!.targetLabel).toBe("Empty");
  });

  it("spends roomy tabs on the earliest slots before smaller ones", () => {
    // Weapons is the first slot and needs the space; a nearly-empty 12-wide
    // tab must not outrank a quad tab just because it holds fewer items.
    const tabs = [
      tab("Small", { index: 0, gridCols: 12, occupiedCells: 12 }),
      tab("Roomy", { index: 1, gridCols: 24, occupiedCells: 500 }),
    ];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["Small", "Roomy"] });
    expect(plan.assignments[0]).toMatchObject({ targetLabel: "Roomy" });
    expect(plan.assignments[0]!.slot.key).toBe("weapons");
    expect(plan.assignments[1]!.targetLabel).toBe("Small");
  });
});

describe("validateStashTabPlan", () => {
  const slot = GEAR_SLOT_TABS[0]!;
  const other = GEAR_SLOT_TABS[1]!;

  it("accepts a clean plan", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [
        { slot, targetLabel: "Scratch A" },
        { slot: other, targetLabel: "Scratch B" },
      ],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan)).toEqual([]);
  });

  it("blocks renaming a priced tab", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [{ slot, targetLabel: "~price 1 divine" }],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan).join(" ")).toMatch(/public price/);
  });

  it("blocks touching a Remove-only tab", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [{ slot, targetLabel: "Rit (Remove-only)" }],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan).join(" ")).toMatch(/Remove-only/);
  });

  it("rejects duplicate colours and duplicate targets", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [
        { slot, targetLabel: "Scratch A" },
        { slot: { ...other, colour: slot.colour }, targetLabel: "Scratch A" },
      ],
      unassigned: [],
    };
    const errors = validateStashTabPlan(plan).join(" ");
    expect(errors).toMatch(/assigned twice/);
    expect(errors).toMatch(/duplicate colour/);
  });

  it("rejects a new name that would read as a public price", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [{ slot: { ...slot, tabName: "~price 3 chaos" }, targetLabel: "Scratch" }],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan).join(" ")).toMatch(/public price/);
  });
});

describe("priced-tab detection under OCR garble", () => {
  // These exact strings came out of a live tab-strip survey, where the strip
  // clipped one physical "~price 5 exalted" tab four different ways.
  it.each([
    "~price 5 exalted",
    "-price 5 exalted",
    "rice 5 exalted",
    "price 5 exalted",
    "exalted 5",
    "~price 1 divine",
    "rice 1 divine",
  ])("treats %j as priced", (label) => {
    expect(looksPricedTabLabel(label)).toBe(true);
  });

  it.each(["Weapons", "Helmets", "T15", "Maps", "Great Gear", "Breach Tab"])(
    "leaves %j editable",
    (label) => {
      expect(looksPricedTabLabel(label)).toBe(false);
    },
  );

  it("protects both priced and Remove-only tabs", () => {
    expect(isProtectedTabLabel("rice 5 exalted")).toBe(true);
    expect(isProtectedTabLabel("Rit (Remove-only)")).toBe(true);
    expect(isProtectedTabLabel("Boots")).toBe(false);
  });

  it("keeps a garbled priced tab out of a plan that names it editable", () => {
    const tabs = [tab("rice 5 exalted"), tab("Scratch")];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["rice 5 exalted", "Scratch"] });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["Scratch"]);
  });
});

describe("priced-tab opt-in", () => {
  it("is off by default", () => {
    const tabs = [tab("~price 5 exalted"), tab("Scratch")];
    const plan = buildGearTabPlan(tabs, { editableLabels: ["~price 5 exalted", "Scratch"] });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["Scratch"]);
  });

  it("lets priced tabs become destinations when explicitly enabled", () => {
    const tabs = [tab("~price 5 exalted"), tab("rice 1 divine"), tab("Scratch")];
    const plan = buildGearTabPlan(tabs, {
      editableLabels: ["~price 5 exalted", "rice 1 divine", "Scratch"],
      allowPricedTabs: true,
    });
    expect(plan.assignments.map((entry) => entry.targetLabel).sort()).toEqual(
      ["Scratch", "rice 1 divine", "~price 5 exalted"].sort(),
    );
  });

  it("still refuses Remove-only tabs with the opt-in enabled", () => {
    const tabs = [tab("Rit (Remove-only)"), tab("~price 5 exalted")];
    const plan = buildGearTabPlan(tabs, {
      editableLabels: ["Rit (Remove-only)", "~price 5 exalted"],
      allowPricedTabs: true,
    });
    expect(plan.assignments.map((entry) => entry.targetLabel)).toEqual(["~price 5 exalted"]);
  });

  it("validates a priced plan only when the same opt-in is passed", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [{ slot: GEAR_SLOT_TABS[0]!, targetLabel: "~price 1 divine" }],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan).join(" ")).toMatch(/public price/);
    expect(validateStashTabPlan(plan, { allowPricedTabs: true })).toEqual([]);
  });

  it("never validates a Remove-only target, opt-in or not", () => {
    const plan: StashTabPlan = {
      version: 1,
      assignments: [{ slot: GEAR_SLOT_TABS[0]!, targetLabel: "Rit (Remove-only)" }],
      unassigned: [],
    };
    expect(validateStashTabPlan(plan, { allowPricedTabs: true }).join(" ")).toMatch(/Remove-only/);
  });
});

describe("tab predicates", () => {
  it("recognises Remove-only labels the way the game writes them", () => {
    expect(isRemoveOnlyTabLabel("Rit (Remove-only)")).toBe(true);
    expect(isRemoveOnlyTabLabel("rune (remove only)")).toBe(true);
    expect(isRemoveOnlyTabLabel("Runes")).toBe(false);
  });

  it("identifies quad tabs by grid width", () => {
    expect(isQuadTab({ gridCols: 24 })).toBe(true);
    expect(isQuadTab({ gridCols: 12 })).toBe(false);
    expect(isQuadTab({})).toBe(false);
  });

  it("admits Remove-only labels as drain sources, and nothing else", () => {
    expect(isDrainableRemoveOnlyLabel("Currency (Remove-only)")).toBe(true);
    expect(isDrainableRemoveOnlyLabel("rune (remove only)")).toBe(true);
    expect(isDrainableRemoveOnlyLabel("Currency")).toBe(false);
    expect(isDrainableRemoveOnlyLabel("T13")).toBe(false);
    expect(isDrainableRemoveOnlyLabel("")).toBe(false);
  });

  it("keeps priced protection above the drain flag on garbled labels", () => {
    // A label that reads BOTH priced and Remove-only stays untouchable.
    expect(isDrainableRemoveOnlyLabel("~price 5 exalted (Remove-only)")).toBe(false);
    expect(isDrainableRemoveOnlyLabel("rice 3 chaos remove only")).toBe(false);
  });
});
