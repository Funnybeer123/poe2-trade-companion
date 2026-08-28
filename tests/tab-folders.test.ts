import { describe, expect, it } from "vitest";
import {
  folderFamilyFor,
  isPricedTabLabel,
  proposeFolderPlan,
  validateFolderPlan,
  type SurveyedTab,
} from "../src/core/tabFolders.js";

const TABS: SurveyedTab[] = [
  { index: 0, label: "-price 1 divine", removeOnly: false },
  { index: 1, label: "cUR", removeOnly: false },
  { index: 2, label: "CUR (Remove-only)", removeOnly: true },
  { index: 3, label: "ESS (Remove-only)", removeOnly: true },
  { index: 4, label: "Dist", removeOnly: false },
  { index: 5, label: "Maps (Remove-only)", removeOnly: true },
  { index: 6, label: "Skill Gems (Remove-only)", removeOnly: true },
  { index: 7, label: "Top Gear (Remove-only)", removeOnly: true },
  { index: 8, label: "Runes", removeOnly: false },
  { index: 9, label: "Breach (Remove-only)", removeOnly: true },
];

describe("tabFolders", () => {
  it("detects priced tab labels in any garbled form", () => {
    expect(isPricedTabLabel("-price 5 exalted")).toBe(true);
    expect(isPricedTabLabel("rice 11 exa te Remove-on")).toBe(false);
    expect(isPricedTabLabel("~price 1 divine")).toBe(true);
    expect(isPricedTabLabel("Top Gear")).toBe(false);
  });

  it("maps labels to family folders", () => {
    expect(folderFamilyFor("cUR")).toBe("Currency");
    expect(folderFamilyFor("CUR (Remove-only)")).toBe("Currency");
    expect(folderFamilyFor("ESS (Remove-only)")).toBe("Essences");
    expect(folderFamilyFor("Dist")).toBe("Delirium");
    expect(folderFamilyFor("Runes (Remove-only)")).toBe("Runes");
    expect(folderFamilyFor("Maps (Remove-only)")).toBe("Maps");
    expect(folderFamilyFor("Skill Gems (Remove-only)")).toBe("Gems");
    expect(folderFamilyFor("-price 55 exalted")).toBe("Shop");
    expect(folderFamilyFor("Top Gear (Remove-only)")).toBe("Gear");
    expect(folderFamilyFor("(unreadable)")).toBe("Gear");
  });

  it("proposes a complete plan covering every tab exactly once", () => {
    const plan = proposeFolderPlan(TABS);
    const assigned = plan.folders.flatMap((folder) => folder.tabIndices).sort((a, b) => a - b);
    expect(assigned).toEqual(TABS.map((tab) => tab.index));
    expect(plan.folders.find((folder) => folder.name === "Currency")!.tabIndices).toEqual([1, 2]);
    expect(validateFolderPlan(plan, TABS)).toEqual([]);
  });

  it("rejects renames of priced tabs and structural errors", () => {
    const plan = proposeFolderPlan(TABS);
    plan.renames.push({ index: 0, newName: "General" });
    plan.folders[0]!.tabIndices.push(999);
    const errors = validateFolderPlan(plan, TABS);
    expect(errors.some((error) => error.includes("priced tab 0"))).toBe(true);
    expect(errors.some((error) => error.includes("unknown tab index 999"))).toBe(true);
  });
});
