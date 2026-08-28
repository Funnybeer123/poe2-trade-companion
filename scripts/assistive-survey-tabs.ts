/**
 * Stash tab survey v2: reads the tab-list dropdown via OCR (rows snapped to
 * slots, missed rows interpolated), visits every tab by clicking its row â€”
 * using label alignment to stay addressed when the list auto-scrolls â€” and
 * writes tab-inventory.json with label, kind, occupancy, and a content
 * signature per tab for later verified navigation.
 *
 * Usage: npx tsx scripts/assistive-survey-tabs.ts [--max=N]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { alignWindow, extendCanonical, snapRows, type ListRow, type OcrLine } from "../src/core/tabList.js";
import { signatureDistance, stashContentSignature } from "../src/core/tabRouter.js";
import { perceiveUi } from "../src/core/uiPerception.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-survey");
mkdirSync(outDir, { recursive: true });

const maxArg = process.argv.find((arg) => arg.startsWith("--max="))?.slice(6);
const maxTabs = maxArg ? Number(maxArg) : 64;

const LIST_REGION = { left: 1340, top: 180, width: 760, height: 1430 };
const LIST_ROW_X = 1700;
const LIST_CENTER = { x: 1700, y: 800 };
const LIST_TOGGLE = { x: 1259, y: 219 };
const PARK = { x: 660, y: 1900 };

const profile = loadProfile(templateDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const host = startWinHost({ requestTimeoutMs: 30_000 });

async function readWindow(): Promise<ListRow[]> {
  await host.send({ op: "move", x: PARK.x, y: PARK.y });
  await sleep(140);
  const reply = await host.send({ op: "ocr", ...LIST_REGION });
  if (!reply.ok) return [];
  return snapRows((Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[]);
}

async function anchorTop(): Promise<ListRow[]> {
  await host.send({ op: "wheel", x: LIST_CENTER.x, y: LIST_CENTER.y, steps: 12 });
  await sleep(350);
  let rows = await readWindow();
  if (rows.length < 5) {
    await host.send({ op: "click", x: LIST_TOGGLE.x, y: LIST_TOGGLE.y });
    await sleep(700);
    await host.send({ op: "wheel", x: LIST_CENTER.x, y: LIST_CENTER.y, steps: 12 });
    await sleep(350);
    rows = await readWindow();
  }
  return rows;
}

async function capture(tag: string) {
  const file = path.join(outDir, `${tag}.bmp`);
  const captured = await host.send({ op: "capture", path: file });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const rect = await host.send({ op: "rect" });
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
  const bgr = readBmpBgr(file);
  const { rmSync } = await import("node:fs");
  rmSync(file, { force: true });
  const frame = bgrToGray(bgr);
  const facts = perceiveUi(frame, client, {}, profile, bgr);
  const signature = facts.stashRegion ? stashContentSignature(frame, client, facts.stashRegion) : [];
  return { bgr, facts, signature };
}

try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("PoE window not found");

  let window = await anchorTop();
  if (window.length < 5) throw new Error("tab-list-not-readable");
  let canonical = extendCanonical([], window, 0);
  console.log(`canonical seed: ${canonical.length} rows`);

  const inventory: Array<Record<string, unknown>> = [];
  let previousSignature: number[] | undefined;
  for (let index = 0; index < Math.min(maxTabs, 64); index += 1) {
    if (index >= canonical.length) break;
    // Locate the row for this index in the current window; re-anchor if needed.
    let shift = alignWindow(window, canonical) ?? 0;
    if (index < shift || index >= shift + window.length) {
      window = await anchorTop();
      shift = alignWindow(window, canonical) ?? 0;
      if (index >= shift + window.length) {
        // Hidden below the fold: select the bottom visible row to force the
        // list to scroll, then re-read and re-align.
        const bottom = window.at(-1)!;
        await host.send({ op: "click", x: LIST_ROW_X, y: bottom.clickY });
        await sleep(650);
        window = await readWindow();
        const aligned = alignWindow(window, canonical);
        if (aligned === undefined) {
          console.error(`alignment lost at index ${index} â€” stopping`);
          break;
        }
        shift = aligned;
        canonical = extendCanonical(canonical, window, shift);
        if (index >= shift + window.length) {
          console.log(`index ${index} unreachable; canonical=${canonical.length} â€” done`);
          break;
        }
      }
    }
    const row = window[index - shift]!;
    const clicked = await host.send({ op: "click", x: LIST_ROW_X, y: row.clickY });
    if (!clicked.ok) {
      console.log(`index ${index}: click failed ${clicked.error}`);
      continue;
    }
    await sleep(650);
    const snap = await capture(`tab-${index}`);
    const kind =
      snap.facts.stashPanelOpen && snap.facts.stashGridSize
        ? snap.facts.stashGridSize.cols === 24
          ? "quad-grid"
          : "normal-grid"
        : "specialty-or-unknown";
    const changed =
      previousSignature && snap.signature.length
        ? signatureDistance(previousSignature, snap.signature) >= 2
        : undefined;
    previousSignature = snap.signature.length ? snap.signature : previousSignature;
    const label = canonical[index] ?? row.label;
    const entry = {
      index,
      label,
      removeOnly: /remove.?onl/i.test(label),
      kind,
      occupiedCells: snap.facts.occupiedStash.length,
      freeCells: kind === "quad-grid" ? 576 - snap.facts.occupiedStash.length : undefined,
      changedFromPrevious: changed,
      signature: snap.signature.map((value) => Math.round(value)),
    };
    inventory.push(entry);
    console.log(
      `#${index} "${label}" ${entry.removeOnly ? "[RO]" : "    "} ${kind} occupied=${entry.occupiedCells} changed=${changed}`,
    );
    if (kind === "specialty-or-unknown") {
      writeFileSync(path.join(outDir, `preview-${index}.png`), encodeBgrPng(snap.bgr));
    }
    // Selecting a bottom row may have scrolled the list; refresh the window.
    window = await readWindow();
    const aligned = alignWindow(window, canonical);
    if (aligned !== undefined) canonical = extendCanonical(canonical, window, aligned);
  }

  writeFileSync(
    path.join(outDir, "tab-inventory.json"),
    JSON.stringify({ surveyedAt: new Date().toISOString(), canonical, tabs: inventory }, null, 2),
  );
  const ro = inventory.filter((entry) => entry.removeOnly);
  const roCells = ro.reduce((sum, entry) => sum + Number(entry.occupiedCells ?? 0), 0);
  const free = inventory
    .filter((entry) => !entry.removeOnly)
    .reduce((sum, entry) => sum + Number(entry.freeCells ?? 0), 0);
  console.log(
    `\n${inventory.length} tabs surveyed: ${ro.length} remove-only holding ${roCells} cells; ${free} free cells in regular tabs`,
  );
} finally {
  await host.close();
}
