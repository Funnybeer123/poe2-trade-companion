import type { DesirabilityCategory } from "../items/types.js";
import { GGG_DISCLAIMER } from "../operator/disclaimer.js";

export type FilterAction = "Show" | "Hide";

export interface FilterRule {
  id: string;
  action: FilterAction;
  class?: string;
  rarity?: string;
  baseType?: string;
  category?: DesirabilityCategory;
  setFontSize?: number;
  setTextColor?: string;
  setBorderColor?: string;
  playAlertSound?: string;
}

export interface FilterProfile {
  id: string;
  name: string;
  rules: FilterRule[];
}

export const DEFAULT_FILTER_PROFILE: FilterProfile = {
  id: "local-default",
  name: "Local default",
  rules: [
    {
      id: "currency-high",
      action: "Show",
      class: "Currency",
      baseType: "Divine Orb",
      category: "HighValueSell",
      setFontSize: 45,
      setTextColor: "255 215 0",
      setBorderColor: "255 215 0",
      playAlertSound: "1 300",
    },
    {
      id: "uniques",
      action: "Show",
      rarity: "Unique",
      category: "KeepUse",
      setFontSize: 40,
      setTextColor: "175 96 37",
    },
    {
      id: "rares",
      action: "Show",
      rarity: "Rare",
      category: "Sell",
      setFontSize: 32,
    },
    {
      id: "hide-normal",
      action: "Hide",
      rarity: "Normal",
      category: "Dump",
      setFontSize: 18,
    },
  ],
};

function emitRule(rule: FilterRule): string {
  const lines = [rule.action];
  if (rule.class !== undefined) {
    lines.push(`    Class "${rule.class}"`);
  }
  if (rule.rarity !== undefined) {
    lines.push(`    Rarity ${rule.rarity}`);
  }
  if (rule.baseType !== undefined) {
    lines.push(`    BaseType "${rule.baseType}"`);
  }
  if (rule.setTextColor !== undefined) {
    lines.push(`    SetTextColor ${rule.setTextColor}`);
  }
  if (rule.setBorderColor !== undefined) {
    lines.push(`    SetBorderColor ${rule.setBorderColor}`);
  }
  if (rule.setFontSize !== undefined) {
    lines.push(`    SetFontSize ${String(rule.setFontSize)}`);
  }
  if (rule.playAlertSound !== undefined) {
    lines.push(`    PlayAlertSound ${rule.playAlertSound}`);
  }
  return lines.join("\n");
}

export function generateLootFilter(profile: FilterProfile = DEFAULT_FILTER_PROFILE): string {
  const header = [
    `# ${profile.name}`,
    `# Local loot-filter export only. No OAuth filter sync.`,
    `# ${GGG_DISCLAIMER}`,
  ];
  return `${header.join("\n")}\n\n${profile.rules.map(emitRule).join("\n\n")}\n`;
}

export function defaultFilterFileName(profile: FilterProfile = DEFAULT_FILTER_PROFILE): string {
  const slug = profile.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug.length > 0 ? slug : "local-filter"}.filter`;
}
