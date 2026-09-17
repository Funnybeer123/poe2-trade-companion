import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rescanRingBag, runRingGamble } from "../src/core/ringGamble.js";
import { openRingGamble } from "../src/adapters/ringGambleLive.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
  const root = process.env.POE2_BAG_DATA_ROOT ?? process.cwd();
  const journal = path.resolve(value("journal") ?? path.join(root, "artifacts", "ring-gamble", `rings-${Date.now()}.jsonl`));
  const rescan = args.includes("--rescan");
  const max = Number(value("max-purchases") ?? 60);
  if (!Number.isInteger(max) || max < 1 || max > 60) throw new Error("Purchase cap must be 1–60.");
  if (!args.includes("--run")) {
    if (rescan) { console.log("Preview: rescan existing rings and sell verified rejects, without buying. No game input emitted."); return; }
    console.log("Preview: Alt-left-click Ange → Jewelry → Ctrl-click rings into free slots (maximum " + max + ") → retain strong/craft/unknown rolls → Ctrl-click verified weak rings back. No game input emitted.");
    return;
  }
  const calibrationFile = value("calibration");
  const perceptionFile = value("perception");
  if (!calibrationFile || !perceptionFile) throw new Error("Inventory/vendor calibration and cursor perception files are required.");
  const calibration = JSON.parse(readFileSync(calibrationFile, "utf8")) as CalibrationProfile;
  mkdirSync(path.dirname(journal), { recursive: true });
  const live = openRingGamble({ root, journal, directory: journal + ".evidence", calibration, perceptionFile });
  try {
    const result = rescan ? await rescanRingBag(live.port) : await runRingGamble(live.port, max);
    writeFileSync(journal + ".result.json", JSON.stringify(result));
    console.log(`Complete: ${"inspected" in result ? result.inspected + " rings rescanned" : result.purchased + " rings purchased"}, ${result.sold} sold, ${result.retained} retained.`);
  } finally { await live.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
