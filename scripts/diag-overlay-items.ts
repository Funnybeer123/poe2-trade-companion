/**
 * Interactive perception overlay for the Dump tab: draws what the sorter's
 * occupancy pass concludes — LIME = cells it would sweep as occupied
 * (including dim-cell rescues), RED = phantom-store skips, thin RED border =
 * the grid region it believes in — and lets the user teach corrections:
 *
 *   Numpad 8 = done · Numpad 9 = then draw a small box around a MISSED item
 *   (start the drag on an EMPTY cell so the game does not pick the item up)
 *   · Numpad 0 = abort
 *
 * Each correction prints the cell's raw scores (mean/variance/itemFrac),
 * its baseline/bright-block/phantom verdicts, and why it was skipped — the
 * exact data needed to fix the misjudging rule. The Gear folder row is
 * opened first so the grid sits where sorting sees it (it shifts ~67px
 * between the two states, measured 2026-09-01).
 *
 *   npx tsx scripts/diag-overlay-items.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import {
  boundaryBrightness24,
  brightestCellPoint,
  scoreGridCells,
  type CellScore,
} from "../src/core/itemSprites.js";
import {
  detectGridDivisions,
  emptyCellKeysByBaseline,
  phantomSignatureMatches,
  type PhantomCellRecord,
} from "../src/core/gearSort.js";
import os from "node:os";
import { rmSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts", "tab-admin");
const storeFile = path.join(outDir, "phantom-cells.json");
const calibFile = path.join(outDir, "grid-calibration.json");

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, fast: true });
const kit = new StashTabKit(host);

async function captureGray() {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const file = path.join(os.tmpdir(), `overlay-${Date.now()}.bmp`);
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
  return { gray: bgrToGray(bgr), client };
}

try {
  await host.send({ op: "focus" });
  harness.startKeyListener();
  // Dump is a TOP-LEVEL tab: its grid sits one strip row higher than the
  // folder tabs' (user-diagnosed 2026-09-01) — use the top-level bounds.
  void kit; // strip interaction no longer needed for the overlay
  const calib = JSON.parse(readFileSync(calibFile, "utf8")) as Record<
    string,
    { x: number; y: number; w: number; h: number }
  >;
  const bounds = calib["__default_24x24_toplevel"] ?? calib["__default_24x24"]!;
  const phantoms: PhantomCellRecord[] = existsSync(storeFile)
    ? (JSON.parse(readFileSync(storeFile, "utf8")) as PhantomCellRecord[])
    : [];
  const phantomByCell = new Map(phantoms.map((r) => [`${r.row},${r.col}`, r]));

  for (let round = 0; round < 12; round += 1) {
    const { gray, client } = await captureGray();
    const { odd, even } = boundaryBrightness24(gray, client, bounds);
    const { divisions } = detectGridDivisions(odd, even);
    const cols = divisions;
    const rows = divisions;
    const cw = bounds.w / cols;
    const ch = bounds.h / rows;
    const scores = scoreGridCells(gray, client, bounds, cols, rows);
    const byKey = new Map<string, CellScore>(scores.map((s) => [`${s.row},${s.col}`, s]));
    const emptyKeys = emptyCellKeysByBaseline(scores);

    type Verdict = "occupied" | "dim-rescued" | "phantom-skipped" | "empty";
    const verdictOf = (s: CellScore): Verdict => {
      const stored = phantomByCell.get(`${s.row},${s.col}`);
      const baselineEmpty = emptyKeys.has(`${s.row},${s.col}`);
      if (baselineEmpty) {
        return brightestCellPoint(gray, client, bounds, cols, rows, s) ? "dim-rescued" : "empty";
      }
      if (stored && phantomSignatureMatches(stored, s)) return "phantom-skipped";
      return "occupied";
    };

    const rects: Array<{ x: number; y: number; w: number; h: number; kind: "click" | "found"; label?: string }> = [
      // Thin border showing where the sorter believes the grid is.
      { x: Math.round(bounds.x) - 3, y: Math.round(bounds.y) - 3, w: Math.round(bounds.w) + 6, h: 3, kind: "click" },
      { x: Math.round(bounds.x) - 3, y: Math.round(bounds.y + bounds.h), w: Math.round(bounds.w) + 6, h: 3, kind: "click" },
      { x: Math.round(bounds.x) - 3, y: Math.round(bounds.y), w: 3, h: Math.round(bounds.h), kind: "click" },
      { x: Math.round(bounds.x + bounds.w), y: Math.round(bounds.y), w: 3, h: Math.round(bounds.h), kind: "click" },
    ];
    const counts = { occupied: 0, "dim-rescued": 0, "phantom-skipped": 0, empty: 0 } as Record<Verdict, number>;
    for (const s of scores) {
      const verdict = verdictOf(s);
      counts[verdict] += 1;
      if (verdict === "empty") continue;
      rects.push({
        x: Math.round(bounds.x + s.col * cw) + 2,
        y: Math.round(bounds.y + s.row * ch) + 2,
        w: Math.round(cw) - 4,
        h: Math.round(ch) - 4,
        kind: verdict === "phantom-skipped" ? "click" : "found",
      });
    }
    console.log(
      `grid ${cols}x${cols} — would sweep ${counts.occupied + counts["dim-rescued"]} cell(s) ` +
        `(${counts["dim-rescued"]} dim-rescued), skip ${counts["phantom-skipped"]} phantom(s), ${counts.empty} empty`,
    );
    const verdict = await harness.confirmPlan(
      rects,
      `LIME=will sweep RED=phantom/border — 8 done · 9 then box a MISSED item · 0 abort`,
    );
    if (verdict === "good") break;
    const correction = await harness.captureCorrection("missed item", {
      x: Math.round(bounds.x + bounds.w / 2),
      y: Math.round(bounds.y + bounds.h / 2),
    });
    if (!correction) continue;
    const box = correction.box ?? {
      x: (correction.corrected?.x ?? 0) - 4,
      y: (correction.corrected?.y ?? 0) - 4,
      w: 8,
      h: 8,
    };
    console.log(`\n--- correction box (${box.x},${box.y}) ${box.w}x${box.h} ---`);
    for (const s of scores) {
      const cx = bounds.x + (s.col + 0.5) * cw;
      const cy = bounds.y + (s.row + 0.5) * ch;
      if (box.x >= cx + cw / 2 || box.x + box.w <= cx - cw / 2) continue;
      if (box.y >= cy + ch / 2 || box.y + box.h <= cy - ch / 2) continue;
      const stored = phantomByCell.get(`${s.row},${s.col}`);
      const bright = brightestCellPoint(gray, client, bounds, cols, rows, s);
      console.log(
        `cell (${s.row},${s.col}) center=(${Math.round(cx)},${Math.round(cy)}): ` +
          `mean=${s.mean.toFixed(1)} variance=${s.variance.toFixed(0)} itemFrac=${s.itemFrac.toFixed(3)} | ` +
          `baselineEmpty=${emptyKeys.has(`${s.row},${s.col}`)} brightBlock=${bright ? `(${bright.x},${bright.y})` : "none"} | ` +
          `phantom=${stored ? (phantomSignatureMatches(stored, s) ? `stored+MATCHES(mean ${stored.mean.toFixed(0)},var ${stored.variance.toFixed(0)})` : "stored+drifted") : "no"} | ` +
          `verdict=${verdictOf(s)}`,
      );
    }
    console.log("--- re-drawing overlay ---\n");
  }
} catch (error) {
  if (!(error instanceof SortStop)) throw error;
  console.log("aborted by Numpad 0");
} finally {
  await harness.dispose();
  await controlHost.close();
  await host.close();
}
