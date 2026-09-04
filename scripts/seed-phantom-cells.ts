/**
 * One-shot seeder for artifacts/tab-admin/phantom-cells.json: captures ONE
 * frame (no clicks, no hovers, no focus steal) and records the Dump quad's
 * bottom decorative band (rows 22-23) as phantom cells with their pixel
 * signatures. The user confirmed no items live there (2026-09-01, "clicking
 * around on the bottom row where there are no items"); the signature match
 * in cleanTab re-probes any cell whose pixels later change, so nothing real
 * can be masked. Requires the stash panel to be open on the Dump tab.
 *
 *   npx tsx scripts/seed-phantom-cells.ts
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { scoreGridCells } from "../src/core/itemSprites.js";
import { emptyCellKeysByBaseline, type PhantomCellRecord } from "../src/core/gearSort.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeFile = path.join(root, "artifacts", "tab-admin", "phantom-cells.json");
const calibFile = path.join(root, "artifacts", "tab-admin", "grid-calibration.json");

const host = startWinHost({ requestTimeoutMs: 20_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const file = path.join(os.tmpdir(), `seed-phantoms-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: file });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const bgr = readBmpBgr(file);
  rmSync(file, { force: true });
  const client = resolvePhysicalClient(
    {
      left: Number(captured.left),
      top: Number(captured.top),
      width: Number(captured.width),
      height: Number(captured.height),
    },
    Number(rect.monitorWidth) || Number(captured.width),
    Number(rect.monitorHeight) || Number(captured.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );
  const gray = bgrToGray(bgr);
  const calib = JSON.parse(readFileSync(calibFile, "utf8")) as Record<
    string,
    { x: number; y: number; w: number; h: number }
  >;
  const bounds = calib["__default_24x24"];
  if (!bounds) throw new Error("no __default_24x24 calibration — teach the grid first");
  const scores = scoreGridCells(gray, client, bounds, 24, 24);
  const emptyKeys = emptyCellKeysByBaseline(scores);
  const existing: PhantomCellRecord[] = existsSync(storeFile)
    ? (JSON.parse(readFileSync(storeFile, "utf8")) as PhantomCellRecord[])
    : [];
  const byKey = new Map(existing.map((r) => [`${r.tab}:${r.row},${r.col}`, r]));
  let added = 0;
  for (const score of scores) {
    if (score.row < 22) continue; // only the bottom decorative band
    if (emptyKeys.has(`${score.row},${score.col}`)) continue; // already skipped for free
    const key = `Dump#0:${score.row},${score.col}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      tab: "Dump#0",
      row: score.row,
      col: score.col,
      mean: score.mean,
      variance: score.variance,
      at: new Date().toISOString(),
    });
    added += 1;
  }
  writeFileSync(storeFile, JSON.stringify([...byKey.values()], null, 2));
  console.log(`seeded ${added} bottom-band phantom cell(s); store holds ${byKey.size} total`);
} finally {
  await host.close();
}
