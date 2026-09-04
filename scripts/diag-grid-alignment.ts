/**
 * Read-only: find the stash grid's TRUE horizontal separator lines on the
 * current frame and compare them against the taught calibration. Scans row
 * brightness in the grid's x-band; separator lines are local brightness
 * maxima spaced ~cellH apart. Also OCRs nothing and clicks nothing.
 *
 *   npx tsx scripts/diag-grid-alignment.ts
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calibFile = path.join(root, "artifacts", "tab-admin", "grid-calibration.json");

const host = startWinHost({ requestTimeoutMs: 20_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  if (process.argv.includes("--open-gear")) {
    // One Gear-header click so the folder row is open, to measure whether
    // the grid shifts down in that state (the state every sort runs in).
    const { StashTabKit } = await import("../src/adapters/stashTabKit.js");
    const kit = new StashTabKit(host);
    const opened = await kit.openFolder("Gear");
    console.log(`gear folder row open: ${opened}`);
  }
  const file = path.join(os.tmpdir(), `align-${Date.now()}.bmp`);
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
  const b = calib["__default_24x24"]!;
  const sx = gray.width / client.width;
  const sy = gray.height / client.height;
  // Mean brightness per screen row across the grid's x-band (inset to skip
  // the panel frame), scanned well above and below the taught bounds.
  const x0 = Math.round((b.x + 60 - client.left) * sx);
  const x1 = Math.round((b.x + b.w - 60 - client.left) * sx);
  const yTop = Math.round((b.y - 120 - client.top) * sy);
  const yBot = Math.round((b.y + b.h + 120 - client.top) * sy);
  const rowMean: number[] = [];
  for (let y = yTop; y <= yBot; y += 1) {
    let sum = 0;
    let n = 0;
    for (let x = x0; x < x1; x += 7) {
      sum += gray.pixels[y * gray.width + x]!;
      n += 1;
    }
    rowMean.push(sum / n);
  }
  // Separator lines: local maxima that beat the local neighbourhood by a
  // margin. Collapse maxima within 6px into one line.
  const lines: number[] = [];
  for (let i = 8; i < rowMean.length - 8; i += 1) {
    const v = rowMean[i]!;
    let neighbourhood = 0;
    for (let k = -8; k <= 8; k += 1) neighbourhood += rowMean[i + k]!;
    neighbourhood /= 17;
    if (v > neighbourhood + 3 && v >= rowMean[i - 1]! && v >= rowMean[i + 1]!) {
      const yScreen = (yTop + i) / sy + client.top;
      if (lines.length === 0 || yScreen - lines[lines.length - 1]! > 6) lines.push(yScreen);
      else if (v > rowMean[Math.round((lines[lines.length - 1]! - client.top) * sy) - yTop]!) {
        lines[lines.length - 1] = yScreen;
      }
    }
  }
  console.log(`taught region: y=${b.y}..${b.y + b.h} (cellH=${(b.h / 24).toFixed(1)})`);
  console.log(`taught row lines would be at: ${Array.from({ length: 25 }, (_, i) => Math.round(b.y + (i * b.h) / 24)).join(", ")}`);
  console.log(`detected separator lines (${lines.length}): ${lines.map((y) => Math.round(y)).join(", ")}`);
  // Estimate the offset: for each detected line, distance to nearest taught line.
  const taught = Array.from({ length: 25 }, (_, i) => b.y + (i * b.h) / 24);
  const deltas = lines
    .map((y) => {
      let best = Number.POSITIVE_INFINITY;
      for (const t of taught) if (Math.abs(y - t) < Math.abs(best)) best = y - t;
      return best;
    })
    .filter((d) => Math.abs(d) < 40);
  if (deltas.length > 0) {
    const median = deltas.sort((a, c) => a - c)[Math.floor(deltas.length / 2)]!;
    console.log(`median line offset vs taught lattice: ${median.toFixed(1)}px over ${deltas.length} lines`);
  }
  if (lines.length >= 2) {
    console.log(`detected grid top ≈ ${Math.round(lines[0]!)}, bottom ≈ ${Math.round(lines[lines.length - 1]!)}`);
  }
} finally {
  await host.close();
}
