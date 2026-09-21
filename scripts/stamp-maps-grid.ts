/**
 * Stamp a measured Maps unique-tab grid into calibration, then hover-copy
 * corner cells so we can see whether the box is still high.
 *
 *   npx tsx scripts/stamp-maps-grid.ts
 *   npx tsx scripts/stamp-maps-grid.ts --box=92,596,1152,768
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWinHost } from "../src/adapters/winHost.js";
import { loadProfile, saveProfile } from "../src/core/calibrationStore.js";
import { applyMapsStashPanel, stampMapsStashPanel } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDir =
  process.env.POE2_TEMPLATE_DIR ??
  path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "perception-templates");
const fixtureDir = path.join(root, "fixtures", "perception", "templates");

const boxArg = process.argv.find((entry) => entry.startsWith("--box="))?.slice(6);
const parts = (boxArg ?? "92,750,1152,768").split(",").map(Number);
const box = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
const mark = applyMapsStashPanel(box);

for (const dir of [userDir, fixtureDir]) {
  const profile = stampMapsStashPanel(loadProfile(dir), box);
  saveProfile(dir, profile);
  console.log(`stamped maps ${mark.cols}×${mark.rows} ${JSON.stringify(box)} → ${dir}`);
}

const probe = process.argv.includes("--probe");
if (!probe) process.exit(0);

const host = startWinHost({ requestTimeoutMs: 45_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  const captured = await host.send({ op: "capture", path: path.join(root, "artifacts", "crafting", `maps-probe-${Date.now()}.bmp`) });
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
  const grid = {
    topLeft: { x: client.left + mark.x, y: client.top + mark.y },
    bottomRight: { x: client.left + mark.x + mark.w, y: client.top + mark.y + mark.h },
  };
  const cells = [
    { row: 0, col: 0 },
    { row: 0, col: 5 },
    { row: 0, col: 11 },
    { row: 1, col: 0 },
    { row: 1, col: 5 },
    { row: 3, col: 5 },
    { row: mark.rows - 1, col: 0 },
    { row: mark.rows - 1, col: 11 },
  ];
  for (const cell of cells) {
    const point = cellCenterTwoCorner(grid, cell.col, cell.row, mark.cols, mark.rows);
    const sentinel = `maps-probe-${cell.row}-${cell.col}`;
    await host.send({ op: "move", x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 140));
    await host.send({ op: "setclipboard", text: sentinel });
    await host.send({ op: "hotkey", keys: "ctrlc" });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const copied = await host.send({ op: "clipboard" });
    const text = String(copied.text ?? "");
    const classLine = /Item Class:\s*(.+)/i.exec(text)?.[1]?.trim();
    const name = /Rarity:.*\r?\n(.+)/i.exec(text)?.[1]?.trim();
    const summary = classLine ? `${classLine} / ${name ?? "?"}` : `EMPTY (${text === sentinel ? "no-copy" : text.slice(0, 40).replace(/\s+/g, " ")})`;
    console.log(`r${cell.row}c${cell.col} @${point.x},${point.y} → ${summary}`);
  }
} finally {
  await host.close();
}
