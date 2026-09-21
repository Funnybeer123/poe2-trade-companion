/**
 * Capture the Maps T1–T16 strip, mark specialty-views click points, OCR it,
 * then hover-copy one well so we can see which tier is actually selected.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";
import { cropBgr, drawRectOutline } from "../src/core/perceptionProbe.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts", "crafting");
mkdirSync(outDir, { recursive: true });

const host = startWinHost({ requestTimeoutMs: 45_000 });
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  await host.send({ op: "focus" });
  const bmpPath = path.join(outDir, `maps-tiers-${Date.now()}.bmp`);
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
  const strip = cropBgr(bgr, 0, 220, 1400, 520);
  const parsed = JSON.parse(
    readFileSync(path.join(root, "fixtures", "perception", "templates", "specialty-views.json"), "utf8"),
  ) as { layouts?: Array<{ match: string; views: Array<{ name: string; x: number; y: number }> }> };
  const views = parsed.layouts?.find((entry) => /maps/i.test(entry.match))?.views ?? [];
  for (const view of views) {
    const color = view.name === "tier-15" ? { r: 40, g: 220, b: 40 } : { r: 40, g: 40, b: 220 };
    drawRectOutline(strip, view.x - 18, view.y - 220 - 18, 36, 36, color);
  }
  const png = path.join(outDir, "maps-tiers-annotated.png");
  writeFileSync(png, encodeBgrPng(strip));
  const ocr = await host.send({ op: "ocr", left: client.left + 20, top: client.top + 220, width: 1360, height: 520 });
  console.log(`origin ${client.left},${client.top}`);
  console.log(`ocr "${String(ocr.text ?? "").replace(/\s+/g, " ").slice(0, 200)}"`);
  console.log(`wrote ${png}`);

  const well = { x: client.left + 92 + 48, y: client.top + 750 + 48 };
  await host.send({ op: "move", x: well.x, y: well.y });
  await new Promise((resolve) => setTimeout(resolve, 160));
  await host.send({ op: "setclipboard", text: "tier-probe" });
  await host.send({ op: "hotkey", keys: "ctrlc" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const copied = await host.send({ op: "clipboard" });
  const text = String(copied.text ?? "");
  const name = /Rarity:.*\r?\n(.+)/i.exec(text)?.[1]?.trim();
  const tier = /Waystone Tier:\s*(\d+)/i.exec(text)?.[1] ?? /Tier (\d+)/i.exec(text)?.[1];
  console.log(`well r0c0 → ${name ?? "empty"} tier=${tier ?? "?"}`);
} finally {
  await host.close();
}
