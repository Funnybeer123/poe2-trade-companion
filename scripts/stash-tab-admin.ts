/**
 * Stash tab administration CLI.
 *
 *   --survey              read the tab strip + the open folder row, visiting
 *                         each editable tab to record grid size and occupancy
 *   --plan                build the gear-slot plan from the survey
 *   --apply               execute the plan (rename + recolour) in the game
 *   --dry-run             with --apply: open each dialog, verify, change nothing
 *   --allow-priced        opt in to rewriting ~price tabs (removes their public
 *                         price). Remove-only tabs are refused regardless.
 *   --strip               print the current tab strip and exit (diagnostic)
 *   --list-top            enumerate every top-level tab label by scrolling
 *   --probe=<label>       right-click one top-row header and dump its dialog
 *   --list                read the tab-list dropdown (rows + click points)
 *   --probe-row=<n>       right-click dropdown row n and dump its dialog
 *   --rename-one=F:T[:C]  rename the single tab matching F to name T, colour C
 *   --finish-gear         walk the Gear folder; any tab not already named as a
 *                         gear slot becomes the next unassigned slot
 *   --renumber            rename every top-level tab to T1, T2, T3 … in order
 *   --prefix=<P>          prefix for --renumber (default "T")
 *   --skip-folders=A,B    folder headers to leave alone (default "Gear,AFFINITIES")
 *   --by-strip            renumber via the horizontal strip (legacy; the tab
 *                         list dropdown is more reliable and is the default)
 *   --by-label            address tabs by strip label instead of walking the row
 *   --folder=<name>       which folder row to treat as editable (default "Gear")
 *
 * Priced (`~price ...`) and Remove-only tabs are refused at three layers: the
 * planner, the plan validator, and the executor's read-back of the live dialog.
 */
import fs from "node:fs";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StashTabKit, type StripEntry } from "../src/adapters/stashTabKit.js";
import { DrainKit } from "../src/adapters/drainKit.js";
import { startWinHost } from "../src/adapters/winHost.js";
import {
  GEAR_SLOT_TABS,
  buildGearTabPlan,
  colourByName,
  isFolderLabel,
  isRemoveOnlyTabLabel,
  looksPricedTabLabel,
  sequentialTabName,
  validateStashTabPlan,
  type StashTabPlan,
  type StashTabState,
} from "../src/core/stashTabAdmin.js";
import { labelsEqualFolded, labelsSimilar } from "../src/core/tabList.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "tab-admin");
mkdirSync(outDir, { recursive: true });
const surveyFile = path.join(outDir, "tab-admin-survey.json");
const planFile = path.join(outDir, "tab-admin-plan.json");

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const folderName = argv.find((arg) => arg.startsWith("--folder="))?.slice(9) ?? "Gear";
const allowPricedTabs = has("--allow-priced");
const renamePrefix = argv.find((arg) => arg.startsWith("--prefix="))?.slice(9) ?? "T";
const SKIP_FOLDERS = (
  argv.find((arg) => arg.startsWith("--skip-folders="))?.slice(15) ?? "Gear,AFFINITIES"
)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const host = startWinHost({ requestTimeoutMs: 30_000 });
const kit = new StashTabKit(host);
const drain = new DrainKit(host, root, templateDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SurveyedTab extends StashTabState {
  priced: boolean;
  removeOnly: boolean;
  editable: boolean;
}

/** Visit a tab and read its grid geometry; never visits Remove-only tabs. */
async function inspect(entry: StripEntry, index: number, folder?: string): Promise<SurveyedTab> {
  const priced = looksPricedTabLabel(entry.label);
  const removeOnly = isRemoveOnlyTabLabel(entry.label);
  const base: SurveyedTab = {
    index,
    label: entry.label,
    ...(folder ? { folder } : {}),
    priced,
    removeOnly,
    editable: !priced && !removeOnly,
  };
  // Standing rule: never select a Remove-only tab. Report it and move on.
  if (removeOnly) return base;
  await host.send({ op: "click", x: entry.point.x, y: entry.point.y });
  await sleep(650);
  try {
    const snap = await drain.snapshot();
    return {
      ...base,
      ...(snap.facts.stashGridSize ? { gridCols: snap.facts.stashGridSize.cols } : {}),
      occupiedCells: snap.facts.occupiedStash.length,
    };
  } catch (error) {
    console.error(`  ! ${entry.label}: ${String(error)}`);
    return base;
  }
}

async function survey(): Promise<SurveyedTab[]> {
  if (!(await kit.openFolder(folderName))) {
    console.error(`Could not open the "${folderName}" folder from the tab strip.`);
    return [];
  }
  const opening = await kit.readStrip();
  console.log(`top row:    ${opening.top.map((entry) => `"${entry.label}"`).join("  ")}`);
  // The folder row scrolls horizontally: rewind it, then walk right, visiting
  // each label the first time it comes into view.
  for (let i = 0; i < 16; i += 1) await kit.scrollStrip("folder", "left");

  const tabs: SurveyedTab[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < 16; step += 1) {
    const strip = await kit.readStrip();
    let added = 0;
    for (const entry of strip.folder) {
      // OCR clips labels differently at each scroll offset, so the same tab
      // arrives as "~price 5 exalted", "rice 5 exalted" and bare "exalted".
      // Skip anything that reads like a tab we already visited.
      if (!entry.label || seen.has(entry.label)) continue;
      if (tabs.some((known) => labelsSimilar(known.label, entry.label))) {
        seen.add(entry.label);
        continue;
      }
      seen.add(entry.label);
      added += 1;
      const result = await inspect(entry, tabs.length, folderName);
      // Second dedupe pass: identical geometry and occupancy means we just
      // re-visited a tab under a differently-garbled label.
      const twin = tabs.find(
        (known) =>
          known.gridCols !== undefined &&
          known.gridCols === result.gridCols &&
          known.occupiedCells === result.occupiedCells,
      );
      if (twin) {
        console.log(`  (duplicate read of "${twin.label}" as "${result.label}" — ignored)`);
        continue;
      }
      tabs.push(result);
      const kind = result.priced ? "[PRICED]" : result.removeOnly ? "[REMOVE-ONLY]" : "[editable]";
      console.log(
        `  #${result.index} "${result.label}" ${kind}` +
          ` grid=${result.gridCols ?? "?"} occupied=${result.occupiedCells ?? "?"}`,
      );
    }
    if (step > 0 && added === 0) break;
    await kit.scrollStrip("folder", "right");
  }
  writeFileSync(surveyFile, JSON.stringify({ surveyedAt: new Date().toISOString(), folderName, tabs }, null, 2));
  console.log(`\nsurvey written: ${surveyFile}`);
  return tabs;
}

function loadSurvey(): SurveyedTab[] {
  if (!existsSync(surveyFile)) {
    console.error("No survey yet — run with --survey first.");
    process.exit(1);
  }
  return (JSON.parse(readFileSync(surveyFile, "utf8")) as { tabs: SurveyedTab[] }).tabs;
}

function plan(tabs: SurveyedTab[]): StashTabPlan {
  const editable = tabs
    .filter((entry) => (allowPricedTabs ? !entry.removeOnly : entry.editable))
    .map((entry) => entry.label);
  const built = buildGearTabPlan(tabs, { editableLabels: editable, allowPricedTabs });
  const errors = validateStashTabPlan(built, { allowPricedTabs });
  console.log(`\nplan: ${built.assignments.length} assigned, ${built.unassigned.length} unassigned`);
  for (const { slot, targetLabel } of built.assignments) {
    const colour = colourByName(slot.colour)!;
    console.log(`  "${targetLabel}"  ->  "${slot.tabName}"  colour=${colour.name} (${colour.hex})`);
  }
  for (const slot of built.unassigned) {
    console.log(`  (no tab available)  ->  "${slot.tabName}"`);
  }
  if (errors.length) {
    console.error("\nplan invalid:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  writeFileSync(planFile, JSON.stringify(built, null, 2));
  console.log(`\nplan written: ${planFile}`);
  return built;
}

/**
 * Rename every top-level tab to T1, T2, T3 … in strip order.
 *
 * Folder headers are skipped by exact name (never right-clicked), Remove-only
 * tabs are left alone, and a tab that is still Public is skipped unless
 * --allow-priced is passed — the dialog's own price controls decide that, not
 * the tab's name.
 */
/**
 * Renumber every top-level tab to T1, T2, T3 … driven from the tab-list
 * dropdown rather than the horizontal strip.
 *
 * The dropdown is the reliable addressing surface: it renders labels in full
 * (the strip clips "~price 5 exalted" down to "exalted"), its rows keep their
 * order across renames so they can be walked by index, and it does not scroll
 * sideways when a tab is selected.
 */
/**
 * Open the dropdown, riding out transient failures: a blanked frame after a
 * focus call, the post-rename close animation, or the stash panel itself
 * having been closed by a stray click (reopened via the chest).
 */
async function openList() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await kit.ensureTabListOpen();
    } catch (error) {
      lastError = error;
      if (String(error).includes("stash-panel-closed")) {
        console.log("  (stash closed — reopening via the chest)");
        await drain.ensurePanelsOpen();
      } else {
        console.log(`  (list read failed: ${String(error)} — retrying)`);
        await sleep(1200);
      }
    }
  }
  throw lastError;
}

/**
 * Rename one tab, located in the dropdown by (loose) label match.
 * Used to repair individual tabs — e.g. when OCR misread "T10" as "TIO" and
 * the numbered-tab skip failed to protect it.
 */
async function renameOne(fromLabel: string, toName: string, colour?: string): Promise<void> {
  // With --in-folder the caller says the tab is a folder child: go straight
  // to the strip, whose loose dropdown matching once grabbed the wrong row.
  if (!has("--in-folder")) {
    const rows = await openList();
    const row = rows.find(
      (candidate) =>
        candidate.readable &&
        !isFolderLabel(candidate.label, SKIP_FOLDERS) &&
        !isRemoveOnlyTabLabel(candidate.label) &&
        (candidate.label.trim() === fromLabel || labelsSimilar(candidate.label, fromLabel)),
    );
    if (row) {
      await renameRow(row, toName, colour);
      return;
    }
  }
  // The combined dropdown often opens scrolled so the folder children sit
  // out of view — fall back to the folder STRIP row, which always shows them
  // while the folder is open. The stash must actually BE open first: with the
  // panel closed, "strip reads" are world pixels and the scroll-arrow clicks
  // land uselessly at the screen's top-left (watched live).
  console.log(`"${fromLabel}" not in the dropdown — trying the ${folderName} folder strip`);
  await drain.ensurePanelsOpen();
  if (!(await kit.openFolder(folderName))) {
    console.error(`could not open the ${folderName} folder`);
    return;
  }
  // Folder-anchored dropdown first: its rows render FULL labels (the strip
  // clips and merges), and openSettingsViaList verifies the dialog's own
  // Name field, so it is the safest write path.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await kit.readTabList();
    const hit = rows.find(
      (candidate) => candidate.readable && labelsEqualFolded(candidate.label, fromLabel),
    );
    if (hit) {
      await renameRow(hit, toName, colour);
      return;
    }
    await host.send({ op: "focus" });
    await sleep(200);
    await host.send({ op: "click", x: 1287, y: 278 }); // folder chevron toggle
    await sleep(900);
  }
  const entry = await kit.locate(fromLabel, ["folder"], 16, true);
  if (!entry) {
    console.error(`"${fromLabel}" not found in the folder strip either`);
    return;
  }
  // Renames demand EXACT (confusable-folded) matches: loose containment once
  // picked QuarterStaff for "Staff" and renamed the wrong tab. Adjacent
  // headers OCR as ONE merged line ("Staves Crossbows"), so an exact match on
  // a leading word-prefix also counts — with the right-click biased into the
  // left segment. The dialog's own exact-name check below stays the hard gate.
  const exact = labelsEqualFolded(entry.label, fromLabel);
  let prefixMatch = false;
  if (!exact) {
    let acc = "";
    for (const word of entry.label.trim().split(/\s+/)) {
      acc = acc ? `${acc} ${word}` : word;
      if (labelsEqualFolded(acc, fromLabel)) {
        prefixMatch = true;
        break;
      }
    }
  }
  if (!exact && !prefixMatch) {
    console.error(`strip header reads "${entry.label}", wanted exactly "${fromLabel}" — aborting`);
    return;
  }
  const point = exact
    ? entry.point
    : { x: Math.round(entry.point.x - entry.width / 2 + 40), y: entry.point.y };
  const state = await kit.openSettings({ ...entry, point });
  // The dialog names the tab it actually belongs to — same exactness there.
  if (state.open && state.name && !labelsEqualFolded(state.name, fromLabel)) {
    console.error(`dialog shows "${state.name}", wanted "${fromLabel}" — aborting`);
    await kit.closeSettings(state);
    return;
  }
  await renameViaState(state, entry.label, toName, colour);
}

/** Shared write path: dialog-level guards, then name (and optional colour). */
async function renameRow(
  row: { label: string; clickY: number; index: number },
  toName: string,
  colour?: string,
): Promise<void> {
  const { state, mismatch } = await kit.openSettingsViaList(row as never);
  if (mismatch && !state.open) {
    console.error(`could not open settings for "${row.label}" (${mismatch})`);
    return;
  }
  await renameViaState(state, row.label, toName, colour);
}

async function renameViaState(
  state: Awaited<ReturnType<StashTabKit["openSettings"]>>,
  sourceLabel: string,
  toName: string,
  colour?: string,
): Promise<void> {
  if (!state.open || !state.confirmPoint) {
    console.error(`no settings dialog for "${sourceLabel}" — folder or unknown row`);
    if (state.open) await kit.closeSettings(state);
    return;
  }
  const actual = state.name ?? sourceLabel;
  if (isRemoveOnlyTabLabel(actual)) {
    console.error(`"${actual}" is Remove-only — left alone`);
    await kit.closeSettings(state);
    return;
  }
  if (state.publiclyListed && !allowPricedTabs) {
    console.error(`"${actual}" is still Public — pass --allow-priced to rename it`);
    await kit.closeSettings(state);
    return;
  }
  await kit.setName(toName, state);
  if (colour) {
    const swatch = colourByName(colour);
    if (!swatch) {
      console.error(`unknown colour "${colour}" — name only`);
    } else {
      await kit.setColour(swatch, state);
    }
  }
  await kit.confirmSettings(state);
  console.log(`"${actual}" -> "${toName}"${colour ? ` [${colour}]` : ""}`);
}

/**
 * Finish the Gear folder: walk its strip row, leave tabs already named as a
 * gear slot alone, and give every other tab the next unassigned slot name and
 * colour. No label addressing — the dialog itself identifies each tab.
 */
async function finishGearFolder(): Promise<void> {
  await drain.ensurePanelsOpen();
  if (!(await kit.openFolder(folderName))) {
    console.error(`could not open the ${folderName} folder`);
    return;
  }
  const slotNames = GEAR_SLOT_TABS.map((slot) => slot.tabName);
  const taken = new Set<string>();
  // First walk: learn which slot names are already in use.
  const visited: string[] = [];
  await kit.walkTabs(
    "folder",
    async (name) => {
      const hit = slotNames.find((slot) => labelsSimilar(slot, name));
      if (hit) taken.add(hit);
      return "skip";
    },
    { visited },
  );
  const remaining = GEAR_SLOT_TABS.filter((slot) => !taken.has(slot.tabName));
  console.log(`slots in use: ${[...taken].join(", ") || "none"}`);
  console.log(`slots to assign: ${remaining.map((slot) => slot.tabName).join(", ")}`);

  const queue = [...remaining];
  await kit.walkTabs(
    "folder",
    async (name, _entry, state) => {
      if (queue.length === 0) return "skip";
      if (slotNames.some((slot) => labelsSimilar(slot, name))) return "skip";
      if (isRemoveOnlyTabLabel(name)) return "skip";
      if (state.publiclyListed && !allowPricedTabs) {
        console.log(`  "${name}": still Public — skipped`);
        return "skip";
      }
      const slot = queue.shift()!;
      await kit.setName(slot.tabName, state);
      await kit.setColour(colourByName(slot.colour)!, state);
      await kit.confirmSettings(state);
      console.log(`  "${name}" -> "${slot.tabName}" [${slot.colour}]`);
      return "applied";
    },
    { visited: [] },
  );
  if (queue.length) console.log(`slots left unassigned: ${queue.map((slot) => slot.tabName).join(", ")}`);
}

async function renumberViaList(dryRun: boolean): Promise<void> {
  console.log(
    `\n${dryRun ? "DRY RUN" : "APPLYING"} sequential rename of top-level tabs` +
      (allowPricedTabs ? " (public tabs opted in)" : ""),
  );
  const first = await openList();
  console.log(`tab list: ${first.length} rows`);
  const skipped: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  // Names we have already written. A row still carrying one of these is done.
  const assigned = new Set<string>();
  // Rows we deliberately passed over, so they are not retried forever.
  const passedOver = new Set<string>();

  // A tab already named T<n> (a previous partial run, or the user's own T16)
  // is left as it is; its number is reserved so no duplicate is ever created.
  // OCR sometimes inserts a space ("T 16"), hence the optional gap.
  const alreadyNumbered = new RegExp(`^${renamePrefix}\\s?(\\d+)$`);
  const usedNumbers = new Set<number>();
  // OCR reliably drops very short labels — "T1" and "T2" vanish from reads
  // while "T16" survives — so numbers already spent can be invisible here.
  // --reserve=1,2 declares them explicitly and prevents duplicate names.
  for (const part of (argv.find((a) => a.startsWith("--reserve="))?.slice(10) ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) usedNumbers.add(n);
  }
  for (const row of first) {
    const match = alreadyNumbered.exec(row.label.trim());
    if (match) usedNumbers.add(Number(match[1]));
  }
  if (usedNumbers.size > 0) {
    console.log(`  keeping existing: ${[...usedNumbers].sort((a, b) => a - b).map((n) => renamePrefix + n).join(", ")}`);
  }
  const nextNumber = () => {
    let n = 1;
    while (usedNumbers.has(n)) n += 1;
    usedNumbers.add(n);
    return n;
  };

  // Only rows seen in the first full list read are ever click targets. World
  // text (an NPC nameplate drifting into the crop mid-run) can then never
  // become a phantom row that walks the character out of the stash.
  const canonical = first.filter((row) => row.readable).map((row) => row.label);
  const inCanonical = (label: string) =>
    canonical.some((known) => known === label.trim() || labelsSimilar(known, label));

  for (let pass = 0; pass < first.length * 2 + 8; pass += 1) {
    const rows = await openList();
    // Compare loosely: the same tab is read as "-price 55 exalted" one pass and
    // "rice 55 exalted" the next, and an exact-string check would treat the
    // second read as a fresh tab and rename the same one twice. `labelsSimilar`
    // still keeps "~price 55 exalted" and "~price 150 exalted" apart.
    const handled = (label: string) =>
      [...assigned, ...passedOver].some(
        (known) => known === label.trim() || labelsSimilar(known, label),
      );
    const row = rows.find(
      (candidate) =>
        candidate.readable &&
        !isFolderLabel(candidate.label, SKIP_FOLDERS) &&
        !isRemoveOnlyTabLabel(candidate.label) &&
        !alreadyNumbered.test(candidate.label.trim()) &&
        inCanonical(candidate.label) &&
        !handled(candidate.label),
    );
    if (!row) break;
    if (isRemoveOnlyTabLabel(row.label)) {
      skipped.push(`${row.label} (Remove-only)`);
      passedOver.add(row.label.trim());
      continue;
    }

    const { state, mismatch } = await kit.openSettingsViaList(row);
    if (mismatch || !state.open) passedOver.add(row.label.trim());
    if (mismatch || !state.open) {
      skipped.push(`${row.label} (${mismatch ?? "dialog-did-not-open"})`);
      if (state.open) await kit.closeSettings(state);
      continue;
    }
    if (!state.confirmPoint) {
      // No affinity footer: this is a folder, not a tab.
      passedOver.add(row.label.trim());
      await kit.closeSettings(state);
      continue;
    }
    // Report the dropdown's label, not the dialog's: the dialog Name field
    // renders a text caret that OCR reads as a trailing character ("T16" comes
    // back as "T161"). The dialog name is still the safety check above.
    const actual = row.label;
    if (state.publiclyListed && !allowPricedTabs) {
      skipped.push(`${actual} (still Public — pass --allow-priced)`);
      passedOver.add(row.label.trim());
      await kit.closeSettings(state);
      continue;
    }

    const newName = sequentialTabName(nextNumber(), renamePrefix);
    if (dryRun) {
      console.log(`  "${actual}" -> "${newName}"`);
      // Nothing changes, so the row keeps its label — mark it done by hand.
      passedOver.add(row.label.trim());
      assigned.add(newName);
      await kit.closeSettings(state);
      continue;
    }
    await kit.setName(newName, state);
    // The dialog holds its position while open, so the confirm point measured
    // at open time is still valid — no need for a second OCR pass.
    await kit.confirmSettings(state);
    assigned.add(newName);
    renamed.push({ from: actual, to: newName });
    console.log(`  "${actual}" -> "${newName}"`);
  }

  console.log(`\n${dryRun ? "would rename" : "renamed"} ${dryRun ? assigned.size : renamed.length} tabs`);
  for (const note of skipped) console.log(`  skipped: ${note}`);
}

async function renameSequential(dryRun: boolean): Promise<void> {
  console.log(
    `\n${dryRun ? "DRY RUN" : "APPLYING"} sequential rename of top-level tabs` +
      (allowPricedTabs ? " (public tabs opted in)" : ""),
  );
  let counter = 0;
  const skipped: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const visited: string[] = [];

  await kit.walkTabs(
    "top",
    async (name, _entry, state) => {
      if (isFolderLabel(name, SKIP_FOLDERS)) return "skip";
      if (isRemoveOnlyTabLabel(name)) {
        skipped.push(`${name} (Remove-only)`);
        return "skip";
      }
      if (state.publiclyListed && !allowPricedTabs) {
        skipped.push(`${name} (still Public — pass --allow-priced)`);
        return "skip";
      }
      counter += 1;
      const newName = sequentialTabName(counter, renamePrefix);
      if (dryRun) {
        console.log(`  "${name}" -> "${newName}"${state.publiclyListed ? "  [PUBLIC]" : ""}`);
        return "skip";
      }
      await kit.setName(newName, state);
      // Re-read so the tick is clicked where it actually is now.
      const saved = await kit.readDialog();
      await kit.confirmSettings(saved.confirmPoint ? saved : state);
      // Record the new name too, or the walk meets this tab again and renumbers it.
      visited.push(newName);
      renamed.push({ from: name, to: newName });
      console.log(`  "${name}" -> "${newName}"`);
      return "applied";
    },
    // No label pre-filter: OCR clips "Great Gear" down to "Gear", so filtering
    // on the strip label silently drops real tabs. Folders are rejected
    // structurally instead — their dialog has no affinity footer, hence no
    // confirm tick — and by name inside the callback.
    { visited },
  );

  console.log(`\n${dryRun ? "would rename" : "renamed"} ${dryRun ? counter : renamed.length} tabs`);
  for (const note of skipped) console.log(`  skipped: ${note}`);
}

/**
 * Execute by walking the folder row once, matching each tab's true dialog name
 * against the plan. Strip labels are clipped and near-identical between priced
 * tabs, so they cannot be used to address a rename.
 */
async function applyByWalk(built: StashTabPlan, dryRun: boolean): Promise<void> {
  if (!(await kit.openFolder(folderName))) {
    console.error(`Could not open the "${folderName}" folder from the tab strip.`);
    return;
  }
  console.log(
    `\n${dryRun ? "DRY RUN" : "APPLYING"} ${built.assignments.length} tab rewrites` +
      (allowPricedTabs ? " (priced tabs opted in)" : ""),
  );
  const pending = new Map(built.assignments.map((entry) => [entry.targetLabel, entry.slot]));
  const done: string[] = [];

  await kit.walkTabs("folder", async (name, _entry, state) => {
    if (isRemoveOnlyTabLabel(name)) {
      console.log(`  "${name}": Remove-only — left alone`);
      return "skip";
    }
    // Match this tab against a still-pending assignment by its real name.
    const key = [...pending.keys()].find((label) => labelsSimilar(label, name));
    if (key === undefined) return "skip";
    const slot = pending.get(key)!;
    if (!allowPricedTabs && looksPricedTabLabel(name)) {
      console.log(`  "${name}": priced — skipped (pass --allow-priced to rewrite it)`);
      return "skip";
    }
    pending.delete(key);
    if (dryRun) {
      console.log(`  "${name}" -> "${slot.tabName}" [${slot.colour}]: would rewrite`);
      return "skip";
    }
    await kit.setName(slot.tabName, state);
    await kit.setColour(colourByName(slot.colour)!, state);
    const saved = await kit.readDialog();
    await kit.confirmSettings(saved.confirmPoint ? saved : state);
    done.push(slot.tabName);
    console.log(`  "${name}" -> "${slot.tabName}" [${slot.colour}]: applied`);
    return "applied";
  });

  for (const [label, slot] of pending) {
    console.log(`  ! "${label}" -> "${slot.tabName}": tab never seen in the folder row`);
  }
  if (!dryRun) console.log(`\nrenamed ${done.length}: ${done.join(", ")}`);
}

async function applyByLabel(built: StashTabPlan, dryRun: boolean): Promise<void> {
  console.log(`\n${dryRun ? "DRY RUN" : "APPLYING"} ${built.assignments.length} tab rewrites`);
  for (const { slot, targetLabel } of built.assignments) {
    const entry = await kit.locate(targetLabel);
    if (!entry) {
      console.error(`  ! "${targetLabel}" not found in the strip — skipped`);
      continue;
    }
    const result = await kit.applyTabIdentity(entry, slot.tabName, slot.colour, {
      dryRun,
      allowPricedTabs,
      expectedLabel: targetLabel,
    });
    console.log(
      `  "${result.before ?? targetLabel}" -> "${slot.tabName}" [${slot.colour}]: ` +
        `${result.applied ? "ok" : `skipped (${result.reason ?? "not-verified"})`}`,
    );
  }
}

try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("PoE window not found");

  if (has("--strip")) {
    const strip = await kit.readStrip();
    console.log(`top row (${strip.top.length}):    ${strip.top.map((e) => `"${e.label}"@${e.point.x},${e.point.y}`).join("  ")}`);
    console.log(`folder row (${strip.folder.length}): ${strip.folder.map((e) => `"${e.label}"@${e.point.x},${e.point.y}`).join("  ")}`);
  }

  if (has("--list-top")) {
    const labels = await kit.enumerateRow("top");
    console.log(`top-level tabs (${labels.length}):`);
    for (const [i, label] of labels.entries()) console.log(`  ${i}: "${label}"`);
  }

  if (has("--list")) {
    const rows = await kit.ensureTabListOpen();
    console.log(`tab-list rows (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.index}: y=${r.clickY} ${r.readable ? "" : "[unreadable] "}"${r.label}"`);
  }

  const probeRow = argv.find((a) => a.startsWith("--probe-row="))?.slice(12);
  if (probeRow !== undefined) {
    const rows = await kit.ensureTabListOpen();
    const row = rows[Number(probeRow)];
    if (!row) console.error(`row ${probeRow} not present (${rows.length} rows)`);
    else {
      const { state } = await kit.openSettingsViaList(row);
      console.log(`row ${row.index} "${row.label}" ->`, JSON.stringify(state));
      if (state.open) await kit.closeSettings(state);
    }
  }

  const probe = argv.find((a) => a.startsWith("--probe="))?.slice(8);
  if (probe) {
    const entry = await kit.locate(probe, ["top"]);
    if (!entry) console.error(`"${probe}" not found in the top row`);
    else {
      const state = await kit.openSettings(entry);
      console.log(`probe "${probe}" @${entry.point.x},${entry.point.y}:`, JSON.stringify(state));
      const lines = await kit.settledOcr();
      for (const l of lines.filter((l) => l.x < 1700 && l.y > 250 && l.y < 1900).sort((a,b)=>a.y-b.y)) {
        console.log(`   OCR ${l.x},${l.y} ${l.w}x${l.h} "${l.text}"`);
      }
      const bmp = path.join(outDir, "probe.bmp");
      const cap = await host.send({ op: "capture", path: bmp });
      if (cap.ok) {
        const { readBmpBgr } = await import("../src/adapters/bmp.js");
        const { encodeBgrPng } = await import("../src/core/pngWrite.js");
        const bgr = readBmpBgr(bmp);
        fs.rmSync(bmp, { force: true });
        writeFileSync(path.join(outDir, "probe-full.png"), encodeBgrPng(bgr));
        console.log("wrote artifacts/tab-admin/probe-full.png");
      }
      if (state.open) await kit.closeSettings(state);
    }
  }

  if (argv.some((a) => a.startsWith("--rename-one="))) {
    // The stash must be open before ANY strip/list interaction: with the
    // panel closed, strip reads are world pixels and scroll-arrow clicks
    // land at the screen's top-left (watched live, twice).
    await drain.ensurePanelsOpen();
    if (has("--in-folder")) await kit.openFolder(folderName);
  }
  for (const arg of argv.filter((a) => a.startsWith("--rename-one="))) {
    const parts = arg.slice(13).split(":");
    if (parts.length < 2) console.error("--rename-one wants FROM:TO[:COLOUR]");
    else await renameOne(parts[0]!, parts[1]!, parts[2]);
  }

  if (has("--finish-gear")) {
    await finishGearFolder();
  }

  if (has("--renumber")) {
    await (has("--by-strip") ? renameSequential : renumberViaList)(has("--dry-run"));
  }

  let tabs: SurveyedTab[] = [];
  if (has("--survey")) tabs = await survey();

  if (has("--plan") || has("--apply")) {
    if (tabs.length === 0) tabs = loadSurvey();
    const built = existsSync(planFile) && !has("--plan")
      ? (JSON.parse(readFileSync(planFile, "utf8")) as StashTabPlan)
      : plan(tabs);
    if (has("--apply")) {
      await (has("--by-label") ? applyByLabel : applyByWalk)(built, has("--dry-run"));
    }
  }

  if (!has("--survey") && !has("--plan") && !has("--apply") && !has("--renumber") && !has("--strip") && !has("--list-top") && !has("--list") && probeRow === undefined && !probe) {
    console.log("nothing to do — pass --survey, --plan, or --apply (see the file header)");
    console.log(`slots: ${GEAR_SLOT_TABS.map((slot) => slot.tabName).join(", ")}`);
  }
} finally {
  await host.close();
}
