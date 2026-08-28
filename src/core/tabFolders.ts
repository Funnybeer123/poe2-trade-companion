/**
 * Stash tab folder planning: groups the surveyed tabs into named folders
 * (currency, essences, maps, gear, shop, ...) and validates a plan before the
 * in-game executor creates folders and drags tabs into them.
 */

export interface SurveyedTab {
  index: number;
  label: string;
  removeOnly: boolean;
}

export interface TabFolder {
  name: string;
  tabIndices: number[];
}

export interface TabFolderPlan {
  version: 1;
  folders: TabFolder[];
  /** Optional renames; priced tabs must never appear here. */
  renames: Array<{ index: number; newName: string }>;
}

/** `~price ...` tab names ARE the public pricing mechanism — never rename them. */
export function isPricedTabLabel(label: string): boolean {
  return /price\s*\d/i.test(label);
}

const FAMILY_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Currency", pattern: /^c?ur\b|currency/i },
  { name: "Essences", pattern: /^ess\b|essence/i },
  { name: "Delirium", pattern: /^dist\b|delirium/i },
  { name: "Runes", pattern: /^runes?\b/i },
  { name: "Maps", pattern: /^maps?\b|waystone/i },
  { name: "Gems", pattern: /skill\s*gems?|^gems?\b/i },
  { name: "Breach", pattern: /^breach\b/i },
];

export function folderFamilyFor(label: string): string {
  const cleaned = label.replace(/\(.*?\)/g, "").trim();
  if (isPricedTabLabel(label)) return "Shop";
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(cleaned)) return rule.name;
  }
  return "Gear";
}

/** Group every surveyed tab into a family folder; unreadable labels go to Gear. */
export function proposeFolderPlan(tabs: SurveyedTab[]): TabFolderPlan {
  const folders = new Map<string, number[]>();
  for (const tab of tabs) {
    const family = folderFamilyFor(tab.label);
    const list = folders.get(family) ?? [];
    list.push(tab.index);
    folders.set(family, list);
  }
  return {
    version: 1,
    folders: [...folders.entries()]
      .map(([name, tabIndices]) => ({ name, tabIndices: [...tabIndices].sort((a, b) => a - b) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    renames: [],
  };
}

export function validateFolderPlan(plan: TabFolderPlan, tabs: SurveyedTab[]): string[] {
  const errors: string[] = [];
  const byIndex = new Map(tabs.map((tab) => [tab.index, tab]));
  const seen = new Set<number>();
  const names = new Set<string>();
  for (const folder of plan.folders) {
    if (!folder.name.trim()) errors.push("folder with empty name");
    if (names.has(folder.name)) errors.push(`duplicate folder name: ${folder.name}`);
    names.add(folder.name);
    for (const index of folder.tabIndices) {
      if (!byIndex.has(index)) errors.push(`folder ${folder.name}: unknown tab index ${index}`);
      if (seen.has(index)) errors.push(`tab ${index} assigned to more than one folder`);
      seen.add(index);
    }
  }
  for (const rename of plan.renames) {
    const tab = byIndex.get(rename.index);
    if (!tab) {
      errors.push(`rename: unknown tab index ${rename.index}`);
      continue;
    }
    if (isPricedTabLabel(tab.label)) {
      errors.push(
        `rename of priced tab ${rename.index} ("${tab.label}") refused — the name is its public pricing`,
      );
    }
    if (!rename.newName.trim()) errors.push(`rename of tab ${rename.index}: empty name`);
  }
  return errors;
}
