/**
 * Manual stash-grid calibration.
 *
 * The user's own mouse pointer is the measuring instrument: hover a corner of
 * the grid and press a numpad key to sample it — no dragging, no OCR, no
 * guessing. The live lattice overlay redraws after every keypress so each
 * adjustment is visible immediately.
 *
 *   Numpad 7  set TOP-LEFT of the grid to the current mouse position
 *             (hover the outer corner of the top-left CELL first)
 *   Numpad 3  set BOTTOM-RIGHT to the current mouse position
 *             (7 and 3 sit on those corners of the numpad itself)
 *   Numpad 4/6/8/2  nudge the whole grid left/right/up/down 3px
 *   Numpad + / -    grow/shrink the grid 3px in both directions
 *   Numpad 9  toggle 24x24 <-> 12x12
 *   Numpad 5  SAVE and exit
 *   Numpad 0  exit without saving
 *
 * Saving writes artifacts/tab-admin/grid-calibration.json: the
 * `__default_{cols}x{rows}` entry plus every stored per-tab entry of the same
 * size (the stash panel's bounds are shared across tabs, so a stale per-tab
 * entry must never outrank a fresh calibration).
 *
 *   npx tsx scripts/calibrate-grid.ts [--size 12|24] [--tab <label>] [--occurrence <n>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startWinHost } from "../src/adapters/winHost.js";

interface GridEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
}

const root = process.cwd();
const calibrationFile = path.join(root, "artifacts", "tab-admin", "grid-calibration.json");

function parseArgs(): { size: number; tab?: string; occurrence: number } {
  const args = process.argv.slice(2);
  let size = 24;
  let tab: string | undefined;
  let occurrence = 0;
  for (const arg of args) {
    if (arg.startsWith("--size=")) size = Number(arg.slice(7)) === 12 ? 12 : 24;
    else if (arg.startsWith("--tab=")) tab = arg.slice(6);
    else if (arg.startsWith("--occurrence=")) occurrence = Math.max(0, Number(arg.slice(13)) || 0);
  }
  return { size, tab, occurrence };
}

function loadCalibration(): Record<string, GridEntry> {
  try {
    return JSON.parse(readFileSync(calibrationFile, "utf8")) as Record<string, GridEntry>;
  } catch {
    return {};
  }
}

/** Reap win-input-host processes whose parent died (same guard as sort-gear). */
function reapOrphanHosts(): void {
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*win-input-host.ps1*' } | Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ]);
  } catch {
    // best effort
  }
}

type MarkRect = { x: number; y: number; w: number; h: number; kind: "click" | "found"; label?: string };

function latticeRects(region: { x: number; y: number; w: number; h: number }, cols: number, rows: number): MarkRect[] {
  const rects: MarkRect[] = [];
  for (let c = 0; c <= cols; c += 1) {
    rects.push({ x: Math.round(region.x + (c * region.w) / cols) - 1, y: region.y, w: 2, h: region.h, kind: "found" });
  }
  for (let r = 0; r <= rows; r += 1) {
    rects.push({ x: region.x, y: Math.round(region.y + (r * region.h) / rows) - 1, w: region.w, h: 2, kind: "found" });
  }
  return rects;
}

async function main(): Promise<void> {
  const { size, tab, occurrence } = parseArgs();
  reapOrphanHosts();
  const host = startWinHost({ requestTimeoutMs: 65_000 });
  const calibration = loadCalibration();
  const tabKey = tab ? `${tab}#${occurrence}` : undefined;

  const seed: GridEntry =
    (tabKey ? calibration[tabKey] : undefined) ??
    calibration[`__default_${size}x${size}`] ??
    { x: 27, y: 303, w: 1290, h: 1227, cols: size, rows: size };
  const region = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };
  let cols = seed.cols ?? size;
  let rows = seed.rows ?? size;

  const draw = async (): Promise<void> => {
    const cellW = (region.w / cols).toFixed(1);
    const cellH = (region.h / rows).toFixed(1);
    const rects: MarkRect[] = [
      ...latticeRects(region, cols, rows),
      // Red anchors on the two corners the user samples.
      { x: region.x - 5, y: region.y - 5, w: 10, h: 10, kind: "click" },
      { x: region.x + region.w - 5, y: region.y + region.h - 5, w: 10, h: 10, kind: "click" },
      {
        x: 1500, y: 30, w: 1400, h: 70, kind: "click",
        label: "CALIBRATE — hover a corner, then: 7=set top-left · 3=set bottom-right",
      },
      {
        x: 1500, y: 110, w: 1400, h: 70, kind: "click",
        label: `4/6/8/2=nudge · +/-=size · 9=12/24 · 5=SAVE · 0=quit   [${cols}x${rows} cell ${cellW}x${cellH}]`,
      },
    ];
    await host.send({ op: "marks", rects });
  };

  const cursor = async (): Promise<{ x: number; y: number } | undefined> => {
    const reply = await host.send({ op: "cursor" });
    if (reply.ok !== true) return undefined;
    return { x: Number(reply.x), y: Number(reply.y) };
  };

  console.log(`calibrate-grid — ${cols}x${rows}${tabKey ? ` for ${tabKey}` : ""}`);
  console.log(`starting from x=${region.x} y=${region.y} w=${region.w} h=${region.h}`);
  console.log("in game: hover the OUTER corner of the top-left cell, press Numpad 7;");
  console.log("hover the outer corner of the bottom-right cell, press Numpad 3;");
  console.log("nudge with 4/6/8/2, resize with +/-, then Numpad 5 to save (0 quits).");
  await draw();

  let saved = false;
  for (;;) {
    const reply = await host.send({ op: "waitkey", timeoutMs: 60_000 });
    if (reply.ok !== true) {
      if (reply.error === "timeout") continue; // keep waiting, overlay stays up
      console.log(`host: ${String(reply.error)} — retrying in 2s`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    const key = Number(reply.key);
    if (key === 0) break;
    if (key === 5) {
      saved = true;
      break;
    }
    if (key === 7 || key === 3) {
      const at = await cursor();
      if (!at) continue;
      if (key === 7) {
        const right = region.x + region.w;
        const bottom = region.y + region.h;
        if (right - at.x < 200 || bottom - at.y < 200) {
          console.log(`ignored top-left sample ${at.x},${at.y} — would collapse the grid`);
          continue;
        }
        region.x = at.x;
        region.y = at.y;
        region.w = right - at.x;
        region.h = bottom - at.y;
        console.log(`top-left set to ${at.x},${at.y}`);
      } else {
        if (at.x - region.x < 200 || at.y - region.y < 200) {
          console.log(`ignored bottom-right sample ${at.x},${at.y} — would collapse the grid`);
          continue;
        }
        region.w = at.x - region.x;
        region.h = at.y - region.y;
        console.log(`bottom-right set to ${at.x},${at.y}`);
      }
    } else if (key === 4) region.x -= 3;
    else if (key === 6) region.x += 3;
    else if (key === 8) region.y -= 3;
    else if (key === 2) region.y += 3;
    else if (key === 10) {
      region.w += 3;
      region.h += 3;
    } else if (key === 11) {
      region.w -= 3;
      region.h -= 3;
    } else if (key === 9) {
      cols = cols === 24 ? 12 : 24;
      rows = rows === 24 ? 12 : 24;
      console.log(`grid size toggled to ${cols}x${rows}`);
    } else {
      continue; // 1 unused
    }
    await draw();
  }

  await host.send({ op: "hidemark" }).catch(() => undefined);
  await host.close();

  if (!saved) {
    console.log("exited without saving — calibration unchanged");
    return;
  }

  const entry: GridEntry = { ...region, cols, rows };
  const fresh = loadCalibration();
  fresh[`__default_${cols}x${rows}`] = entry;
  if (tabKey) fresh[tabKey] = entry;
  // The stash panel's bounds are shared across tabs: refresh every stored
  // per-tab entry of this size so no stale one outranks this calibration.
  const refreshed: string[] = [];
  for (const key of Object.keys(fresh)) {
    if (key.startsWith("__default_")) continue;
    if (fresh[key]!.cols === cols && fresh[key]!.rows === rows && key !== tabKey) {
      fresh[key] = entry;
      refreshed.push(key);
    }
  }
  mkdirSync(path.dirname(calibrationFile), { recursive: true });
  writeFileSync(calibrationFile, JSON.stringify(fresh, null, 2));
  console.log(`SAVED ${cols}x${rows}: x=${entry.x} y=${entry.y} w=${entry.w} h=${entry.h} (cell ${(entry.w / cols).toFixed(1)}x${(entry.h / rows).toFixed(1)})`);
  if (refreshed.length > 0) console.log(`also refreshed same-size tab entries: ${refreshed.join(", ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
