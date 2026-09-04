/**
 * Read-only diagnostic: ONE screenshot of the open Dump tab, then a
 * row-by-row map of which cells score occupied, which of those the phantom
 * store would skip (and whether their signatures still match), and which
 * cells the empty-baseline would drop. No clicks, no hovers.
 *
 *   npx tsx scripts/diag-dump-occupancy.ts
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { brightestCellPoint, scoreGridCells } from "../src/core/itemSprites.js";
import {
  emptyCellKeysByBaseline,
  phantomSignatureMatches,
  type PhantomCellRecord,
} from "../src/core/gearSort.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeFile = path.join(root, "artifacts", "tab-admin", "phantom-cells.json");
const calibFile = path.join(root, "artifacts", "tab-admin", "grid-calibration.json");

const host = startWinHost({ requestTimeoutMs: 20_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const file = path.join(os.tmpdir(), `diag-${Date.now()}.bmp`);
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
  const bounds = calib["__default_24x24"]!;
  const scores = scoreGridCells(gray, client, bounds, 24, 24);
  const emptyKeys = emptyCellKeysByBaseline(scores);
  const store: PhantomCellRecord[] = existsSync(storeFile)
    ? (JSON.parse(readFileSync(storeFile, "utf8")) as PhantomCellRecord[])
    : [];
  const phantoms = new Map(store.map((r) => [`${r.row},${r.col}`, r]));
  const byRow = new Map<
    number,
    { occ: number[]; skipped: number[]; drifted: number[]; dim: number[] }
  >();
  const rowEntry = (row: number) => {
    const entry = byRow.get(row) ?? { occ: [], skipped: [], drifted: [], dim: [] };
    byRow.set(row, entry);
    return entry;
  };
  for (const s of scores) {
    if (emptyKeys.has(`${s.row},${s.col}`)) {
      // Baseline says empty — but does the cell hold a bright block (small
      // dim item art the baseline misses)?
      if (brightestCellPoint(gray, client, bounds, 24, 24, s)) rowEntry(s.row).dim.push(s.col);
      continue;
    }
    const entry = rowEntry(s.row);
    const stored = phantoms.get(`${s.row},${s.col}`);
    if (stored && phantomSignatureMatches(stored, s)) entry.skipped.push(s.col);
    else if (stored) entry.drifted.push(s.col);
    else entry.occ.push(s.col);
  }
  console.log("row | occupied | phantom-skipped | DRIFTED | baseline-empty-but-BRIGHT (missed?)");
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const e = byRow.get(row)!;
    console.log(
      `${String(row).padStart(3)} | ${e.occ.join(",") || "-"} | ${e.skipped.join(",") || "-"} | ${e.drifted.join(",") || "-"} | ${e.dim.join(",") || "-"}`,
    );
  }
  const totals = [...byRow.values()].reduce(
    (t, e) => ({
      occ: t.occ + e.occ.length,
      skipped: t.skipped + e.skipped.length,
      drifted: t.drifted + e.drifted.length,
    }),
    { occ: 0, skipped: 0, drifted: 0 },
  );
  console.log(
    `totals: ${totals.occ} would be swept, ${totals.skipped} phantom-skipped, ${totals.drifted} drifted (would re-probe)`,
  );
} finally {
  await host.close();
}
