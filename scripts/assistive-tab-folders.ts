/**
 * Stash tab folder planner: proposes a folder layout from the surveyed tab
 * inventory (Currency / Essences / Delirium / Runes / Maps / Gems / Breach /
 * Shop / Gear), validates it — priced tabs are never renamed — and saves the
 * plan for the in-game executor.
 *
 * Usage:
 *   npx tsx scripts/assistive-tab-folders.ts --propose   # write + print the plan
 *   npx tsx scripts/assistive-tab-folders.ts --check     # validate the saved/edited plan
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  proposeFolderPlan,
  validateFolderPlan,
  type SurveyedTab,
  type TabFolderPlan,
} from "../src/core/tabFolders.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryFile = path.join(root, "artifacts", "tab-survey", "tab-inventory.json");
const planFile = path.join(root, "artifacts", "tab-survey", "tab-folder-plan.json");

if (!existsSync(inventoryFile)) {
  console.error("No tab inventory — run scripts/assistive-survey-tabs.ts first.");
  process.exit(1);
}
const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  tabs: Array<{ index: number; label: string; removeOnly: boolean }>;
};
const tabs: SurveyedTab[] = inventory.tabs.map(({ index, label, removeOnly }) => ({ index, label, removeOnly }));

if (process.argv.includes("--propose")) {
  const plan = proposeFolderPlan(tabs);
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  for (const folder of plan.folders) {
    console.log(`${folder.name}:`);
    for (const index of folder.tabIndices) {
      const tab = tabs.find((entry) => entry.index === index)!;
      console.log(`  #${index} ${tab.label}${tab.removeOnly ? " [RO]" : ""}`);
    }
  }
  console.log(`\nplan written: ${planFile} — edit freely, then run --check`);
  process.exit(0);
}

if (!existsSync(planFile)) {
  console.error("No plan — run with --propose first.");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planFile, "utf8")) as TabFolderPlan;
const errors = validateFolderPlan(plan, tabs);
if (errors.length) {
  console.error("plan invalid:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`plan valid: ${plan.folders.length} folders, ${plan.renames.length} renames`);
