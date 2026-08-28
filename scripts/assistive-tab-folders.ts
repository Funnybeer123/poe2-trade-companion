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

if (process.argv.includes("--implement")) {
  const { startWinHost } = await import("../src/adapters/winHost.js");
  const { snapRows, labelsSimilar } = await import("../src/core/tabList.js");
  const host = startWinHost({ requestTimeoutMs: 30_000 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const LIST_REGION = { left: 1340, top: 180, width: 760, height: 1430 };
  const FOLDER_BUTTON = { x: 1194, y: 31 };
  const PARK = { x: 660, y: 1900 };

  async function readList() {
    await host.send({ op: "move", x: PARK.x, y: PARK.y });
    await sleep(150);
    const reply = await host.send({ op: "ocr", ...LIST_REGION });
    return snapRows(((reply.lines ?? []) as { text: string; x: number; y: number; w: number; h: number }[]));
  }

  async function fullScreenOcr() {
    const reply = await host.send({ op: "ocr" });
    return ((reply.lines ?? []) as { text: string; x: number; y: number; w: number; h: number }[]);
  }

  try {
    const rect = await host.send({ op: "rect" });
    if (!rect.ok) throw new Error("PoE window not found");
    const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
    for (const folder of plan.folders) {
      if (only && folder.name !== only) continue;
      const before = await readList();
      if (before.some((row) => labelsSimilar(row.label, folder.name))) {
        console.log(`folder "${folder.name}" already present`);
        continue;
      }
      console.log(`creating folder "${folder.name}"...`);
      await host.send({ op: "click", x: FOLDER_BUTTON.x, y: FOLDER_BUTTON.y });
      await sleep(700);
      // The create dialog should show a text input; type the name and confirm.
      const dialog = await fullScreenOcr();
      console.log(
        "  dialog lines:",
        dialog
          .filter((line) => line.y > 400 && line.y < 1700)
          .slice(0, 12)
          .map((line) => `${line.x},${line.y}:"${line.text}"`)
          .join(" | "),
      );
      await host.send({ op: "type", text: folder.name });
      await sleep(250);
      await host.send({ op: "hotkey", keys: "enter" });
      await sleep(800);
      const after = await readList();
      const created = after.some((row) => labelsSimilar(row.label, folder.name));
      console.log(`  created=${created}`);
      if (!created) {
        console.error("  folder not visible after creation — stopping for review");
        await host.send({ op: "hotkey", keys: "escape" });
        break;
      }
    }
  } finally {
    await host.close();
  }
}
