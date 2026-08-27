import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bmpToGray } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { WinHostInputSink } from "../src/adapters/winHostInputSink.js";
import { RuntimeCapabilities, resolveBuildMode } from "../src/core/capabilities.js";
import { GameInputController } from "../src/core/gameInputController.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import {
  bucketSpritesBySize,
  classDefaultSize,
  enrichItemSize,
  isFixedItemClass,
  indexByGridSize,
  itemSizeDatabasePath,
  knownBaseTypes,
  loadItemSizeDatabase,
  lookupItemSize,
  mergeSameItemFragments,
  resolvedMeasuredSize,
  saveItemSizeDatabase,
  sizeKey,
  sizeLabel,
  upsertMeasuredSize,
} from "../src/core/itemSizeStore.js";
import { parseItemText } from "../src/core/parseItem.js";
import { hasHudCalibration, loadPerceptionTemplates } from "../src/core/perceptionTemplates.js";
import { activeStashGrid, profileHasGrids, profileReadyForDeposit } from "../src/core/calibrationProfile.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { scenario } from "../src/core/scenarios.js";
import { validateTransferInput } from "../src/core/transferInputGuard.js";
import type { InputAction } from "../src/core/types.js";
import { perceiveUi } from "../src/core/uiPerception.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dumpDir = path.join(root, "fixtures", "perception", "live");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const dbFile = itemSizeDatabasePath(root);
mkdirSync(dumpDir, { recursive: true });

const wantLearn = process.argv.includes("--learn");
const wantLookup = process.argv.includes("--lookup");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printIndex(db: ReturnType<typeof loadItemSizeDatabase>) {
  const index = indexByGridSize(db);
  for (const label of Object.keys(index)) {
    const rows = index[label] ?? [];
    const measured = rows.filter((row) => row.kind === "baseType");
    if (measured.length === 0 && rows.length === 0) continue;
    console.log(`${label}: ${measured.length} bases`);
    for (const row of measured) {
      console.log(`  ${row.baseType} (${row.itemClass}) samples=${row.samples}`);
    }
  }
}

if (wantLookup) {
  const db = loadItemSizeDatabase(dbFile);
  const host = startWinHost();
  try {
    const clip = await host.send({ op: "clipboard" });
    const text = String(clip.text ?? "");
    if (!/Item Class:/i.test(text)) {
      console.error("Clipboard is not a PoE item. Hover one and press Ctrl+C first.");
      process.exit(1);
    }
    const item = enrichItemSize(parseItemText(text), db);
    const found = lookupItemSize(db, item);
    console.log(
      JSON.stringify(
        {
          name: item.name,
          baseType: item.baseType,
          itemClass: item.itemClass,
          gridW: item.gridW,
          gridH: item.gridH,
          known: Boolean(found && found.record.kind === "baseType"),
          source: found?.record.source,
        },
        null,
        2,
      ),
    );
  } finally {
    await host.close();
  }
  process.exit(0);
}

const { templates, loaded, missing } = loadPerceptionTemplates(templateDir);
const profile = loadProfile(templateDir);
const calibrated = hasHudCalibration(templates) || profileReadyForDeposit(profile) || profileHasGrids(profile);
const db = loadItemSizeDatabase(dbFile);
const host = startWinHost();

try {
  const target = await host.send({ op: "rect" });
  if (!target.ok) {
    console.error("PoE window not found");
    process.exit(1);
  }
  const bmpPath = path.join(dumpDir, `sizes-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: bmpPath });
  if (!captured.ok) {
    console.error("capture failed", captured);
    process.exit(1);
  }
  const client = resolvePhysicalClient(
    {
      left: Number(captured.left),
      top: Number(captured.top),
      width: Number(captured.width),
      height: Number(captured.height),
    },
    Number(target.monitorWidth) || Number(captured.width),
    Number(target.monitorHeight) || Number(captured.height),
    { left: Number(target.monitorLeft ?? captured.left ?? 0), top: Number(target.monitorTop ?? captured.top ?? 0) },
  );
  const gray = bmpToGray(bmpPath);
  const facts = perceiveUi(gray, client, templates, profile);
  const items = facts.stashItems;
  const visual = bucketSpritesBySize(items);
  const visualCounts = Object.fromEntries(
    Object.entries(visual).map(([label, list]) => [label, list.length]).filter(([, n]) => Number(n) > 0),
  );

  writeFileSync(
    path.join(root, "assistive-summary.json"),
    JSON.stringify(
      {
        bmpPath,
        client,
        facts: { ...facts, occupiedBag: facts.occupiedBag.length, occupiedStash: facts.occupiedStash.length },
        templates: { loaded, missing, calibrated },
        visualCounts,
        items: items.map((item) => ({ id: item.id, w: item.w, h: item.h, x: item.grab.x, y: item.grab.y })),
      },
      null,
      2,
    ),
  );

  if (!facts.stashPanelOpen) {
    console.error("Stash is not open. Open a stash tab, then run again.");
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        stashOpen: facts.stashPanelOpen,
        stashGridSize: facts.stashGridSize,
        reason: facts.reason,
        sprites: items.length,
        visualCounts,
        dbFile,
        knownBases: knownBaseTypes(db).size,
      },
      null,
      2,
    ),
  );
  console.log("Visual stash index:");
  for (const [label, list] of Object.entries(visual)) {
    if (list.length === 0) continue;
    console.log(`  ${label}: ${list.length}`);
  }

  if (!wantLearn) {
    console.log("Database index (Ctrl+C lookup):");
    printIndex(db);
    console.log("Re-run with --learn to hover each unknown sprite, Ctrl+C it, and save its size.");
    process.exit(0);
  }

  if (!activeStashGrid(profile)) throw new Error("stash-grid-calibration-required");
  const mode = resolveBuildMode(process.env.POE2_BUILD_MODE);
  if (mode !== "authorized-qa") throw new Error("authorized-qa-build-required");
  if (process.env.POE2_QA_OPT_IN !== "1") throw new Error("qa-local-opt-in-required");
  if (process.env.POE2_QA_ACK !== "1") throw new Error("qa-acknowledgement-required");
  const allowlist = (process.env.POE2_PROCESS_ALLOWLIST ??
    "PathOfExileSteam.exe,PathOfExile.exe,PathOfExile_x64Steam.exe")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const targetProcess = String(target.process ?? "PathOfExile");
  const processName = /\.exe$/i.test(targetProcess) ? targetProcess : `${targetProcess}.exe`;
  const capabilities = new RuntimeCapabilities({
    mode,
    buildAllowsQa: true,
    qaAcknowledged: true,
    assistiveAcknowledged: false,
    allowlist,
    bannerVisible: true,
    emergencyStopRegistered: true,
  });
  const processAllowed = capabilities.isProcessAllowed(processName);
  if (!processAllowed) throw new Error("process-not-allowlisted");
  const sink = new WinHostInputSink(host, {
    allowedProcesses: allowlist,
    requireForeground: true,
    actionGuard: (action) => validateTransferInput([action], profile, client),
  });
  const controller = new GameInputController(sink, new KillSwitch(), mode);
  const learnScenario = scenario({
    id: "assistive-item-size-learning",
    name: "Assistive item size learning",
    enabledModules: ["stash"],
    dryRun: false,
    actionsPerMinute: Number(process.env.POE2_ACTIONS_PER_MINUTE ?? 600),
  });
  async function auditedInput(action: InputAction, reason: string): Promise<void> {
    const traces = await controller.execute(
      {
        module: "stash",
        rule: "audited-item-size-learning",
        reason,
        intended: [action],
        confidence: facts.confidence,
      },
      learnScenario,
      processName,
      "item-size-learning",
      processAllowed,
    );
    appendFileSync(
      path.join(root, "assistive-session.jsonl"),
      `${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
    );
    const failed = traces.find((trace) => trace.result !== "emitted");
    if (failed) throw new Error(failed.reason);
  }
  await auditedInput({ kind: "focus" }, "focus allowlisted target for item-size learning");

  let next = db;
  let created = 0;
  let known = 0;
  let failed = 0;
  const seenClassDefault = new Set<string>();
  const fragments: Array<{
    item: ReturnType<typeof parseItemText>;
    cells: Array<{ row: number; col: number }>;
    w: number;
    h: number;
  }> = [];

  async function copyHoveredItem(): Promise<string> {
    await host.send({ op: "setclipboard", text: "" });
    await sleep(40);
    await auditedInput({ kind: "key", key: "ctrl+c" }, "copy hovered item metadata");
    await sleep(80);
    let clip = await host.send({ op: "clipboard" });
    let text = String(clip.text ?? "");
    if (/Item Class:/i.test(text)) return text;
    await sleep(120);
    await auditedInput({ kind: "key", key: "ctrl+c" }, "retry hovered item metadata copy");
    await sleep(80);
    clip = await host.send({ op: "clipboard" });
    return String(clip.text ?? "");
  }

  for (const sprite of items) {
    const parsedHint = seenClassDefault;
    await auditedInput(
      { kind: "move", x: sprite.grab.x, y: sprite.grab.y },
      "hover calibrated stash sprite for item-size learning",
    );
    await sleep(100);
    const text = await copyHoveredItem();
    if (!/Item Class:/i.test(text)) {
      failed += 1;
      console.log(`FAIL copy ${sizeLabel(sprite.w, sprite.h)} @${sprite.grab.col},${sprite.grab.row}`);
      continue;
    }
    const parsed = parseItemText(text);
    const key = sizeKey(parsed.baseType);
    if (isFixedItemClass(parsed.itemClass) && parsedHint.has(key)) {
      known += 1;
      continue;
    }
    parsedHint.add(key);
    fragments.push({ item: parsed, cells: sprite.cells, w: sprite.w, h: sprite.h });
    console.log(`copy ${sizeLabel(sprite.w, sprite.h)} ${parsed.baseType} (${parsed.itemClass})`);
    await sleep(80);
  }

  for (const fragment of mergeSameItemFragments(fragments)) {
    const learned = upsertMeasuredSize(
      next,
      fragment.item,
      resolvedMeasuredSize(fragment.item.itemClass, { w: fragment.w, h: fragment.h }),
    );
    next = learned.db;
    if (learned.created) created += 1;
    else known += 1;
    console.log(`${learned.created ? "NEW" : "have"} ${sizeLabel(learned.record.w, learned.record.h)} ${fragment.item.baseType}`);
  }

  saveItemSizeDatabase(dbFile, next);
  console.log(
    JSON.stringify(
      { saved: dbFile, created, alreadyKnown: known, failed, bases: knownBaseTypes(next).size },
      null,
      2,
    ),
  );
  console.log("Database index:");
  printIndex(next);
} finally {
  await host.close();
}
