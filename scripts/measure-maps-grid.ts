/**
 * Find the Maps specialty waystone lattice (circular icons below T1–T16).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { cropBgr, drawRectOutline, fillRectBgr, PROBE_COLORS } from "../src/core/perceptionProbe.js";
import type { BgrImage } from "../src/core/cellOccupancy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir =
  process.env.POE2_TEMPLATE_DIR ??
  path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "perception-templates");
const outDir = path.join(root, "artifacts", "crafting");
mkdirSync(outDir, { recursive: true });

function isWaystonePixel(image: BgrImage, x: number, y: number): boolean {
  const i = (y * image.width + x) * 3;
  const b = image.data[i] ?? 0;
  const g = image.data[i + 1] ?? 0;
  const r = image.data[i + 2] ?? 0;
  // Brown ring / parchment disc: warm, not the dark empty well.
  return r > 70 && r > g + 8 && r > b + 18 && g > 35 && b < 90;
}

function countHits(image: BgrImage, x0: number, y0: number, x1: number, y1: number, step = 2): number {
  let hits = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      n += 1;
      if (isWaystonePixel(image, x, y)) hits += 1;
    }
  }
  return n === 0 ? 0 : hits / n;
}

const profile = loadProfile(templateDir);
const stash = profile.stashGrid ?? profile.quadStashGrid;
if (!stash) throw new Error("no stash grid in calibration");

const host = startWinHost({ requestTimeoutMs: 45_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  const bmpPath = path.join(outDir, `maps-grid-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: bmpPath });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const bgr = readBmpBgr(bmpPath);
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

  const x0 = Math.round(stash.x);
  const y0 = Math.round(stash.y);
  const x1 = x0 + Math.round(stash.w);
  const y1 = y0 + Math.round(stash.h);

  // T9–T16 click row lives around y=486. Start hunting below that.
  const huntY0 = Math.max(y0, 520);
  const rowScores: Array<{ y: number; score: number }> = [];
  for (let y = huntY0; y < y1 - 20; y += 4) {
    rowScores.push({ y, score: countHits(bgr, x0 + 20, y, x1 - 20, y + 8) });
  }
  const peak = Math.max(...rowScores.map((row) => row.score), 0.01);
  const on = rowScores.filter((row) => row.score > peak * 0.35);
  const top = on[0]?.y ?? huntY0;
  const bottom = (on[on.length - 1]?.y ?? y1) + 8;

  const colScores: Array<{ x: number; score: number }> = [];
  for (let x = x0; x < x1 - 20; x += 4) {
    colScores.push({ x, score: countHits(bgr, x, top, x + 8, bottom) });
  }
  const colPeak = Math.max(...colScores.map((col) => col.score), 0.01);
  const onCols = colScores.filter((col) => col.score > colPeak * 0.35);
  const left = onCols[0]?.x ?? x0;
  const right = (onCols[onCols.length - 1]?.x ?? x1) + 8;

  const box = { x: left, y: top, w: right - left, h: bottom - top };
  const cellW = box.w / 12;
  const rows = Math.max(1, Math.round(box.h / cellW));
  const mark = { ...box, cols: 12, rows };

  const annotated = { width: bgr.width, height: bgr.height, data: Buffer.from(bgr.data) };
  drawRectOutline(annotated, stash.x, stash.y, stash.w, stash.h, PROBE_COLORS.grayOnly, 2);
  drawRectOutline(annotated, mark.x, mark.y, mark.w, mark.h, PROBE_COLORS.agree, 4);
  for (let row = 0; row < mark.rows; row += 1) {
    for (let col = 0; col < mark.cols; col += 1) {
      const cx = mark.x + (col + 0.5) * (mark.w / mark.cols);
      const cy = mark.y + (row + 0.5) * (mark.h / mark.rows);
      fillRectBgr(annotated, cx - 3, cy - 3, 6, 6, PROBE_COLORS.agree);
    }
  }
  const crop = cropBgr(bgr, mark.x - 12, mark.y - 80, mark.w + 24, mark.h + 100);
  writeFileSync(path.join(outDir, "maps-grid-measure.json"), JSON.stringify({ client, regularStash: stash, measured: mark, peak }, null, 2));
  writeFileSync(path.join(outDir, "maps-grid-annotated.png"), encodeBgrPng(annotated));
  writeFileSync(path.join(outDir, "maps-grid-stash-crop.png"), encodeBgrPng(crop));
  console.log(JSON.stringify({ client, measured: mark, peak: Number(peak.toFixed(3)) }, null, 2));
} finally {
  await host.close();
}
