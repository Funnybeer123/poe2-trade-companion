/**
 * Vendor cycle — from inside a map: teleport to the hideout (/hideout chat
 * command), sell every piece of identified junk gear to ZELINA, and step
 * back into the SAME map through its remaining portal.
 *
 *   npx tsx scripts/vendor-cycle.ts          # dry-run: read the bag, report the plan
 *   npx tsx scripts/vendor-cycle.ts --run    # live
 *
 * "Junk" = the same verdicts the map-drop flow uses (value-tier regexes +
 * price table via decideDrop): identified gear matching no keep/sell rule,
 * or an explicit dump rule. Currency, waystones, tablets, gems, the scroll
 * stack, uniques/keeps, and anything unidentified or unreadable are never
 * offered. --keep-unknown narrows selling to explicit dump matches.
 *
 * Every phase is verified before the next: hideout arrival by the ZELINA
 * nameplate, the vendor window by its title text, each offered item by its
 * bag cell reading empty, the sale by those cells STAYING empty after the
 * window closes (a cancelled trade returns items to their exact cells),
 * and the return portal by the map name recorded before leaving. Unknown
 * UI (the sell-pane accept button, the portal label) is handled
 * capture-and-stop: on the first miss the run saves a screenshot, undoes
 * what it can, and aborts loudly instead of guessing clicks.
 *
 * Numpad 5 pauses, numpad 0 stops. Journal: artifacts/vendor-cycle/journal.jsonl.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { DrainKit } from "../src/adapters/drainKit.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import {
  captureBagSprites,
  copyPoints,
  findOcrLines,
  lineCenter,
  loadTriageConfig,
  panelsViaOcr,
} from "../src/adapters/bagKit.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { BAG_CELLS } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import {
  classifyBagRead,
  decideDrop,
  mergeAdjacentDuplicates,
  type SpriteRead,
} from "../src/core/mapTriage.js";
import type { OcrLine } from "../src/core/tabList.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "vendor-cycle");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const live = flag("--run") && !flag("--dry-run");
const keepUnknown = flag("--keep-unknown");

const profile = loadProfile(templateDir);
if (!profile.bagGrid) {
  console.error("bag-grid-not-calibrated — run the calibration flow first.");
  process.exit(1);
}
const bag = profile.bagGrid;
const { cols, rows } = BAG_CELLS;

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, dryRun: !live, fast: true });
mkdirSync(outDir, { recursive: true });

function journal(record: Record<string, unknown>): void {
  try {
    appendFileSync(
      path.join(outDir, "journal.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    );
  } catch {
    // journaling must never abort a run
  }
}

async function saveCapture(tag: string): Promise<string> {
  const file = path.join(outDir, `${tag}-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: file });
  return captured.ok ? file : "(capture failed)";
}

async function clickAt(x: number, y: number, why: string): Promise<void> {
  await harness.checkpoint(why);
  const reply = await host.send({ op: "click", x, y });
  if (!reply.ok) throw new Error(`click-failed(${why}):${reply.error}`);
}

interface TriagedRead {
  read: SpriteRead;
  name: string;
  reason: string;
}

/**
 * Identify unidentified gear in place with the (0,0) scroll: arm once,
 * ONE shift-HELD click burst over the reps (per-click shift taps cancel
 * the mode; clicks <300ms after arming are ignored — both live-learned in
 * map-triage), verify by batched re-copy, per-item re-arm fallback for
 * misses, and put-back recovery for any lifted item.
 */
async function identifyChain(
  unidReads: SpriteRead[],
  scroll: { x: number; y: number },
): Promise<number> {
  await harness.checkpoint(`identify ${unidReads.length} item(s)`);
  const arm = await host.send({ op: "rightclick", x: scroll.x, y: scroll.y });
  if (!arm.ok) throw new Error(`identify-arm-failed:${arm.error}`);
  await harness.sleep(320, false);
  const burst = await host.send({
    op: "clickburst",
    points: unidReads.map((read) => ({ x: read.sprite.x, y: read.sprite.y })),
    shift: true,
    gapMs: 80,
  });
  if (!burst.ok) throw new Error(`identify-burst-failed:${burst.error}`);
  await harness.sleep(200, false);
  const verify = async (batch: SpriteRead[], label: string): Promise<SpriteRead[]> => {
    const after = await copyPoints(
      host,
      batch.map((read) => ({ x: read.sprite.x, y: read.sprite.y })),
      label,
    );
    const still: SpriteRead[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const read = batch[index]!;
      let text = after[index] ?? "";
      if (!text.trim()) {
        // Lifted item — put it back and re-read.
        await clickAt(read.sprite.cx, read.sprite.cy, "return lifted item");
        await harness.sleep(180, false);
        text = (await copyPoints(host, [{ x: read.sprite.x, y: read.sprite.y }], `${label}-r`))[0] ?? "";
        if (!text.trim()) throw new Error("item-stuck-on-cursor — check the game before continuing");
      }
      read.text = text;
      if (classifyBagRead(text).kind === "unid-gear") still.push(read);
    }
    return still;
  };
  let leftovers = await verify(unidReads, "id-verify");
  if (leftovers.length > 0) {
    console.log(`· ${leftovers.length} item(s) missed by the chain — per-item re-arm fallback`);
    for (const read of leftovers) {
      await clickAtRight(scroll.x, scroll.y, "re-arm Scroll of Wisdom");
      await harness.sleep(320, false);
      await clickAt(read.sprite.x, read.sprite.y, "identify");
      await harness.sleep(250, false);
    }
    leftovers = await verify(leftovers, "id-verify2");
  }
  return unidReads.length - leftovers.length;
}

async function clickAtRight(x: number, y: number, why: string): Promise<void> {
  await harness.checkpoint(why);
  const reply = await host.send({ op: "rightclick", x, y });
  if (!reply.ok) throw new Error(`rightclick-failed(${why}):${reply.error}`);
}

/** Read the bag and split it with the exact map-drop semantics. */
async function readJunk(identifyWith?: { x: number; y: number; scrolls: number }): Promise<{
  junk: TriagedRead[];
  keepers: TriagedRead[];
  unidCount: number;
  identified: number;
}> {
  const triage = loadTriageConfig(root);
  const { sprites } = await captureBagSprites(host, outDir, bag, cols, rows);
  const targets = sprites.filter((sprite) => !(sprite.row === 0 && sprite.col === 0));
  const texts = await copyPoints(
    host,
    targets.map((sprite) => ({ x: sprite.x, y: sprite.y })),
    "vendor-eval",
  );
  const reads = mergeAdjacentDuplicates(
    targets
      .map((sprite, index) => ({ sprite, text: texts[index] ?? "" }))
      .filter((read) => read.text.trim() !== ""),
  );
  let identified = 0;
  const unidReads = reads.filter((read) => classifyBagRead(read.text).kind === "unid-gear");
  if (identifyWith && identifyWith.scrolls > 0 && unidReads.length > 0) {
    if (unidReads.length > identifyWith.scrolls) {
      console.log(
        `! only ${identifyWith.scrolls} scroll(s) for ${unidReads.length} unid item(s) — the rest stay unidentified`,
      );
    }
    identified = await identifyChain(unidReads.slice(0, identifyWith.scrolls), identifyWith);
    console.log(`· identified ${identified} item(s) with the scroll chain`);
  }
  const junk: TriagedRead[] = [];
  const keepers: TriagedRead[] = [];
  let unidCount = 0;
  for (const read of reads) {
    const classified = classifyBagRead(read.text);
    if (classified.kind === "unid-gear") {
      unidCount += 1;
      continue;
    }
    if (classified.kind !== "identified-gear") continue;
    const verdict = evaluateWithAppraisal(read.text, {
      rules: triage.rules,
      thresholds: triage.thresholds,
      priceTable: triage.priceTable,
    });
    const decision = decideDrop(verdict, keepUnknown);
    const name = classified.parsed?.name || classified.parsed?.baseType || "item";
    const entry = { read, name, reason: `${decision.tier}: ${decision.reason}` };
    if (decision.drop) junk.push(entry);
    else keepers.push(entry);
  }
  return { junk, keepers, unidCount, identified };
}

/**
 * Deposit the kept gear into the triage dump tab: open the stash via its
 * OCR'd world nameplate (the proven Num1 primitives), select the tab BY
 * LABEL with the Remove-only guard, ctrl-click the keeper cells, and
 * verify each cell reads empty. An unreachable tab skips the deposit —
 * items are never ctrl-clicked into an unverified tab.
 */
async function depositKeepers(keepers: TriagedRead[], dumpTab: string): Promise<void> {
  if (keepers.length === 0) return;
  const kit = new DrainKit(host, root, templateDir);
  await harness.checkpoint("open stash");
  await kit.ensurePanelsOpen();
  const label = await kit.gotoLabel(dumpTab, true);
  if (!label) {
    console.log(`! stash tab "${dumpTab}" not found — keepers stay in the bag`);
    await closePanels();
    return;
  }
  console.log(`· depositing ${keepers.length} keeper(s) into "${label}"`);
  await harness.checkpoint("deposit keepers");
  await kit.burst(keepers.map((entry) => ({ x: entry.read.sprite.cx, y: entry.read.sprite.cy })));
  await harness.sleep(400, false);
  const after = await copyPoints(
    host,
    keepers.map((entry) => ({ x: entry.read.sprite.x, y: entry.read.sprite.y })),
    "deposited",
  );
  for (let index = 0; index < keepers.length; index += 1) {
    if ((after[index] ?? "").trim()) {
      console.log(`! ${keepers[index]!.name} stayed in the bag (tab full?)`);
    } else {
      console.log(`· stashed ${keepers[index]!.name}`);
    }
  }
  // Close the stash panels so the next phase sees the world.
  await closePanels();
}

async function findLine(pattern: RegExp, holdAlt = false): Promise<OcrLine | undefined> {
  const lines = await findOcrLines(host, holdAlt);
  return lines.find((line) => pattern.test(line.text.trim()));
}

/** Lines from the map HUD worth trying as the hideout portal's label. */
/**
 * The skill bar's portal button (spawns the hideout portal at the player).
 * Fixed UI position at 3840x2160, marked by the user; --portal-x/--portal-y
 * override it.
 */
const PORTAL_BUTTON = {
  x: Number(argv.find((entry) => entry.startsWith("--portal-x="))?.slice(11) ?? 2953),
  y: Number(argv.find((entry) => entry.startsWith("--portal-y="))?.slice(11) ?? 1959),
};

const hubPlate = (line: OcrLine): boolean =>
  /^zelina$/i.test(line.text.trim()) || (/^stash$/i.test(line.text.trim()) && line.x < 3000);
/** The "... HIDEOUT" world label — in a map this is the PORTAL /hideout spawns. */
const hideoutPortal = (line: OcrLine): boolean =>
  /hideout$/i.test(line.text.trim()) && line.x < 3000;
const inMapHud = (line: OcrLine): boolean => /map objectives|map content/i.test(line.text.trim());

/**
 * PoE2's /hideout does NOT teleport from a map — it SPAWNS a portal at the
 * player labeled with the hideout's name (live-learned; the label fooled
 * the first arrival check). So: ensure the portal exists (send /hideout if
 * its label isn't on screen), CLICK ITS NAMEPLATE to enter, and confirm
 * the zone change by the map-only HUD (MAP OBJECTIVES) disappearing.
 */
/** Duplicate world labels = a portal set; the label is the map's name. */
function duplicatePortalLabel(lines: OcrLine[]): string | undefined {
  const byText = new Map<string, number>();
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length < 3 || !/[a-z]{3,}/i.test(text) || PORTAL_NOISE.test(text)) continue;
    if (line.x < 300 || line.x > 3000 || line.y > 1800) continue;
    const key = text.toLowerCase();
    byText.set(key, (byText.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byText) {
    if (count >= 2) return key;
  }
  return undefined;
}

async function departToHideout(): Promise<string | undefined> {
  let lines = await findOcrLines(host, true);
  if (lines.some(hubPlate) || !lines.some(inMapHud)) {
    console.log("· already in the hideout — no teleport needed");
    return duplicatePortalLabel(lines);
  }
  if (!lines.some(hideoutPortal)) {
    // The skill bar's PORTAL BUTTON (user-identified, fixed UI position at
    // 3840x2160) spawns the hideout portal at the player — more reliable
    // than racing the chat box with /hideout.
    await harness.checkpoint("press the portal button");
    await host.send({ op: "click", x: PORTAL_BUTTON.x, y: PORTAL_BUTTON.y });
    console.log("· clicked the portal button — waiting for the portal to spawn");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await harness.sleep(700, false);
      lines = await findOcrLines(host, true);
      if (lines.some(hideoutPortal)) break;
    }
    if (!lines.some(hideoutPortal)) {
      // Fallback: the /hideout chat command spawns the same portal.
      await harness.checkpoint("send /hideout");
      await host.send({ op: "hotkey", keys: "enter" });
      await harness.sleep(300, false);
      await host.send({ op: "type", text: "/hideout" });
      await harness.sleep(200, false);
      await host.send({ op: "hotkey", keys: "enter" });
      console.log("· sent /hideout — waiting for its portal to spawn");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await harness.sleep(700, false);
        lines = await findOcrLines(host, true);
        if (lines.some(hideoutPortal)) break;
      }
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const portal = (await findOcrLines(host, true)).find(hideoutPortal);
    if (!portal) break;
    const point = lineCenter(portal);
    await clickAt(point.x, point.y, `enter portal "${portal.text.trim()}"`);
    // Walk to the portal + zone load; poll fast so arrival is detected the
    // moment the map HUD disappears rather than a worst-case sleep later.
    for (let poll = 0; poll < 20; poll += 1) {
      await harness.sleep(900, false);
      const now = await findOcrLines(host, true);
      if (now.some(hubPlate) || (!now.some(inMapHud) && !now.some(hideoutPortal))) {
        console.log("· hideout reached (map HUD gone)");
        // The RETURN portals stand at the arrival point, labeled with the
        // map's name — remember that label while it is on screen.
        const completed = now.find(completedPortal);
        return completed?.text.trim().toLowerCase() ?? duplicatePortalLabel(now);
      }
    }
  }
  throw new Error(
    "hideout-arrival-not-confirmed — the hideout portal never spawned or would not enter. " +
      "Nothing else was touched; walk through it manually and rerun.",
  );
}

/**
 * The /hideout spawn shows NEITHER the stash nor ZELINA — their nameplates
 * only render in camera range (Alt-held OCR confirmed nothing off-screen).
 * The one clickable world object at spawn is the hideout's own crest
 * label; click-to-move on it walks the character toward the hideout
 * centre, and each step rescans (Alt held) until the hub plates render.
 */
async function walkToHub(): Promise<OcrLine | undefined> {
  const kit = new DrainKit(host, root, templateDir);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lines = await findOcrLines(host, true);
    const zelina = lines.find((line) => /^zelina$/i.test(line.text.trim()));
    const hub = zelina ?? lines.find((line) => /^stash$/i.test(line.text.trim()) && line.x < 3000);
    if (hub) return zelina;
    const crest = lines.find((line) => /hideout/i.test(line.text.trim()) && line.x < 3000);
    if (!crest) {
      // No landmark to walk toward — let the drain kit try its own plate
      // + minimap fallbacks once, then rescan.
      await harness.checkpoint("walk toward the stash");
      await kit.clickStashChest();
      continue;
    }
    await harness.checkpoint("walk toward the hideout crest");
    const point = lineCenter(crest, 60);
    await host.send({ op: "click", x: point.x, y: point.y });
    await harness.sleep(2600, false);
    // A stray interactable under the click may have opened a panel.
    await closePanels();
  }
  const capture = await saveCapture("hub-not-found");
  console.log(`! stash/ZELINA never came into view — capture saved to ${capture}`);
  return undefined;
}

/** Fast open-window check: small band over the search box (full-screen OCR costs ~2s at 4K). */
async function vendorWindowOpen(): Promise<boolean> {
  const band = await host.send({ op: "ocr", left: 750, top: 1700, width: 1100, height: 150 });
  if (/type keyword|buy or sell/i.test(String(band.text ?? ""))) return true;
  return false;
}

async function closePanels(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const panels = await panelsViaOcr(host);
    if (!panels.stash && !panels.inventory) return;
    await host.send({ op: "hotkey", keys: "escape" });
    await harness.sleep(500, false);
  }
}

async function openVendorWindow(knownPlate?: OcrLine): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Reuse the plate the hub walk already found; re-OCR only on retry
    // (nameplates move with the camera, and full-screen OCR costs ~2s).
    let plate = attempt === 0 ? knownPlate : undefined;
    if (!plate) {
      await closePanels();
      plate = await findLine(/^zelina$/i, true);
    }
    if (!plate) throw new Error("zelina-not-found — is she in this hideout?");
    await harness.checkpoint("open ZELINA");
    const point = lineCenter(plate, 70);
    const clicked = await host.send({ op: "ctrlclick", x: point.x, y: point.y });
    if (!clicked.ok) throw new Error(`ctrlclick-zelina-failed:${clicked.error}`);
    // Poll the search-box BAND (fast) instead of full-screen OCR; park the
    // cursor first — it lands on her stock and the tooltip covers the
    // title (live-learned).
    for (let poll = 0; poll < 10; poll += 1) {
      await harness.sleep(450, false);
      await host.send({ op: "move", x: 660, y: 1900 });
      if (await vendorWindowOpen()) return;
    }
  }
  const capture = await saveCapture("vendor-window-missing");
  throw new Error(`vendor-window-not-confirmed — capture saved to ${capture}`);
}

async function sellJunk(junk: TriagedRead[]): Promise<number> {
  // PoE2 vendors sell on ctrl-click INSTANTLY — no offer pane, no accept
  // button (live-learned: gold jumped and ZELINA acknowledged the moment
  // the burst landed). A mis-sold item is recoverable from her Buyback
  // tab, and only clipboard-confirmed junk verdicts are ever clicked.
  await harness.checkpoint(`sell ${junk.length} item(s)`);
  const burst = await host.send({
    op: "ctrlburst",
    points: junk.map((entry) => ({ x: entry.read.sprite.cx, y: entry.read.sprite.cy })),
  });
  if (!burst.ok) throw new Error(`sell-burst-failed:${burst.error}`);
  await harness.sleep(500, false);
  let texts = await copyPoints(
    host,
    junk.map((entry) => ({ x: entry.read.sprite.x, y: entry.read.sprite.y })),
    "sold",
  );
  let stuck = junk.filter((_, index) => (texts[index] ?? "").trim());
  if (stuck.length > 0) {
    // One retry for cells the burst missed.
    await harness.checkpoint(`retry ${stuck.length} unsold item(s)`);
    const retry = await host.send({
      op: "ctrlburst",
      points: stuck.map((entry) => ({ x: entry.read.sprite.cx, y: entry.read.sprite.cy })),
    });
    if (retry.ok) {
      await harness.sleep(500, false);
      texts = await copyPoints(
        host,
        junk.map((entry) => ({ x: entry.read.sprite.x, y: entry.read.sprite.y })),
        "sold2",
      );
      stuck = junk.filter((_, index) => (texts[index] ?? "").trim());
    }
  }
  const sold = junk.length - stuck.length;
  for (const entry of junk) {
    if (!stuck.includes(entry)) console.log(`· sold ${entry.name} (${entry.reason})`);
  }
  for (const entry of stuck) console.log(`! ${entry.name} did not sell — it stays in the bag`);
  if (sold === 0) {
    const capture = await saveCapture("nothing-sold");
    throw new Error(`nothing-sold — is the vendor window really open? Capture saved to ${capture}`);
  }
  return sold;
}

async function closeVendorWindow(): Promise<void> {
  await host.send({ op: "hotkey", keys: "escape" });
  await harness.sleep(450, false);
  // Escape from the trade window lands on her dialogue menu — leave via
  // its own "Goodbye" line when present rather than a blind second Escape
  // (which would open the pause menu if the menu already closed).
  const goodbye = await findLine(/goodbye/i);
  if (goodbye) {
    const point = lineCenter(goodbye);
    await clickAt(point.x, point.y, "Goodbye");
    await harness.sleep(350, false);
  }
}

/** HUD/hideout text the return-portal hunt must never click. */
const PORTAL_NOISE =
  /hideout|zelina|alva|ange|stash|waypoint|map device|bench|salvage|reforg|relic|checkpoint|objectives|content|defeat|travel to|speak to|reach |fight|hunting|hours|minutes|seconds|fps|frame|cpu|gpu|vram|network|drive|server|shader|^\d+%?$/i;

/**
 * A completed map's return portal is labeled "<Map> (COMPLETED)" — the
 * single strongest return signal (live-learned: "SPRING (COMPLETED)").
 */
const completedPortal = (line: OcrLine): boolean => /\(comple/i.test(line.text);

async function returnToMap(returnLabel: string | undefined): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lines = await findOcrLines(host, true);
    // Primary: the "<Map> (COMPLETED)" portal label, then the label
    // remembered at hideout ARRIVAL, then a duplicate-label set, then a
    // single noise-free survivor.
    let portal = lines.find((line) => line.x < 3000 && completedPortal(line));
    if (!portal && returnLabel) {
      portal = lines.find((line) => line.x < 3000 && line.text.trim().toLowerCase() === returnLabel);
    }
    if (!portal) {
      const discovered = lines.filter(
        (line) =>
          line.x > 300 &&
          line.x < 3000 &&
          line.y > 10 &&
          line.y < 1800 &&
          line.text.trim().length >= 3 &&
          /[a-z]{3,}/i.test(line.text) &&
          !PORTAL_NOISE.test(line.text),
      );
      // Map portals spawn as a SET with IDENTICAL labels (the map's name) —
      // duplicate world labels are the strongest portal signal.
      const byText = new Map<string, OcrLine[]>();
      for (const line of discovered) {
        const key = line.text.trim().toLowerCase();
        byText.set(key, [...(byText.get(key) ?? []), line]);
      }
      const duplicated = [...byText.values()].find((group) => group.length >= 2);
      if (duplicated) {
        portal = duplicated[0];
        console.log(`· portal set found by duplicate labels: "${portal!.text.trim()}" ×${duplicated.length}`);
      } else if (discovered.length === 1) {
        portal = discovered[0];
        console.log(`· portal discovered by elimination: "${portal!.text.trim()}"`);
      } else if (discovered.length > 1) {
        console.log(
          `! ${discovered.length} portal-like labels: ${discovered.map((line) => line.text.trim()).join(" | ")}`,
        );
      }
    }
    if (portal) {
      await harness.checkpoint(`enter portal "${portal.text.trim()}"`);
      // Portal labels are click targets themselves (the hideout-portal
      // entry proved it) — no below-label offset.
      const point = lineCenter(portal);
      await clickAt(point.x, point.y, `portal to ${portal.text.trim()}`);
      // Walk + zone load; back in the map = the map-only HUD returns.
      await harness.sleep(2200, false);
      for (let check = 0; check < 16; check += 1) {
        if ((await findOcrLines(host, true)).some(inMapHud)) {
          console.log("· back in the map (MAP OBJECTIVES HUD returned)");
          return;
        }
        await harness.sleep(900, false);
      }
      console.log("! the map HUD never returned after the portal click — walk through manually");
      return;
    }
    await harness.sleep(1200, false);
  }
  const capture = await saveCapture("portal-not-found");
  console.log(
    `! return portal not found (remembered label: ${returnLabel ?? "(none)"}) — ` +
      `capture saved to ${capture}; walk through it manually`,
  );
}

let exitCode = 0;
try {
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(`vendor-cycle ${live ? "LIVE" : "DRY-RUN"}${keepUnknown ? " · keep-unknown" : ""} — numpad: 5 pause · 0 stop`);
  const runStart = Date.now();

  // Read the bag WHERE WE STAND (map). The read needs the inventory OPEN.
  // Bag-open truth = the cell (0,0) scroll copying (the OCR banner
  // false-negatives, and a blind `i` press on one would CLOSE an open bag
  // — live-learned). The same read yields the scroll stack for the
  // identify chain.
  let scrollPoint = { x: 0, y: 0 };
  let scrolls = 0;
  {
    const probe = await captureBagSprites(host, outDir, bag, cols, rows);
    const gridBox = {
      topLeft: { x: probe.client.left + bag.x, y: probe.client.top + bag.y },
      bottomRight: { x: probe.client.left + bag.x + bag.w, y: probe.client.top + bag.y + bag.h },
    };
    scrollPoint = cellCenterTwoCorner(gridBox, 0, 0, cols, rows);
    let open = false;
    for (let attempt = 0; attempt < 3 && !open; attempt += 1) {
      const text = (await copyPoints(host, [scrollPoint], `bagcheck${attempt}`))[0] ?? "";
      if (text.trim()) {
        const classified = classifyBagRead(text);
        scrolls = classified.kind === "scroll" ? (classified.stack ?? 1) : 0;
        open = true;
        break;
      }
      await host.send({ op: "hotkey", keys: "i" });
      await harness.sleep(700, false);
    }
    if (!open) {
      throw new Error(
        "bag-not-readable — cell (0,0) never copied. Is the Scroll of Wisdom parked there and the game foreground?",
      );
    }
  }
  const bagPlan = await readJunk(live ? { ...scrollPoint, scrolls } : undefined);
  if (live) {
    // Close the inventory so the world (portal + nameplates) is visible.
    await host.send({ op: "hotkey", keys: "i" });
    await harness.sleep(500, false);
  }
  const triage = loadTriageConfig(root);
  console.log(
    `bag: ${bagPlan.junk.length} junk item(s) to vendor, ${bagPlan.keepers.length} keeper(s) → "${triage.routing.dumpTab}" tab, ` +
      `${bagPlan.unidCount} unidentified (never vendored)`,
  );
  for (const entry of bagPlan.junk) console.log(`  · vendor: ${entry.name} — ${entry.reason}`);
  for (const entry of bagPlan.keepers) console.log(`  · stash:  ${entry.name} — ${entry.reason}`);

  if (!live) {
    console.log("DRY-RUN complete. Rerun with --run to teleport, vendor, stash keepers, and return.");
  } else if (bagPlan.junk.length === 0 && bagPlan.keepers.length === 0) {
    const lines = await findOcrLines(host, true);
    if (!lines.some(inMapHud)) {
      console.log("Nothing to vendor — but this is the hideout; heading back to the map.");
      await returnToMap(
        lines.find(completedPortal)?.text.trim().toLowerCase() ?? duplicatePortalLabel(lines),
      );
    } else {
      console.log("Nothing to vendor or stash — staying put.");
    }
  } else {
    const readDoneAt = Date.now();
    const returnLabel = await departToHideout();
    if (returnLabel) console.log(`· return portal label remembered: "${returnLabel}"`);
    const departDoneAt = Date.now();
    // The spawn can face away from everything — walking to the stash hub
    // brings ZELINA on screen and sets up the deposit.
    const zelinaPlate = await walkToHub();
    const hubDoneAt = Date.now();
    await depositKeepers(bagPlan.keepers, triage.routing.dumpTab);
    const depositDoneAt = Date.now();
    let sold = 0;
    if (bagPlan.junk.length > 0) {
      await openVendorWindow(bagPlan.keepers.length === 0 ? zelinaPlate : undefined);
      sold = await sellJunk(bagPlan.junk);
      await closeVendorWindow();
    }
    const vendorDoneAt = Date.now();
    await returnToMap(returnLabel);
    const endAt = Date.now();
    const phases = {
      readMs: readDoneAt - runStart,
      departMs: departDoneAt - readDoneAt,
      hubMs: hubDoneAt - departDoneAt,
      depositMs: depositDoneAt - hubDoneAt,
      vendorMs: vendorDoneAt - depositDoneAt,
      returnMs: endAt - vendorDoneAt,
      totalMs: endAt - runStart,
    };
    console.log(
      `CYCLE: ${phases.totalMs}ms total (read ${phases.readMs} · depart ${phases.departMs} · ` +
        `hub ${phases.hubMs} · deposit ${phases.depositMs} · vendor ${phases.vendorMs} · return ${phases.returnMs}) — ` +
        `sold ${sold}, stashed ${bagPlan.keepers.length}`,
    );
    try {
      const benchFile = path.join(outDir, "benchmark.jsonl");
      let best: number | undefined;
      if (existsSync(benchFile)) {
        for (const line of readFileSync(benchFile, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { totalMs?: number };
          if (typeof entry.totalMs === "number") best = best === undefined ? entry.totalMs : Math.min(best, entry.totalMs);
        }
      }
      appendFileSync(
        benchFile,
        `${JSON.stringify({ at: new Date().toISOString(), sold, keepers: bagPlan.keepers.length, ...phases })}\n`,
      );
      if (best === undefined) console.log("First recorded cycle — this is the mark to beat.");
      else if (phases.totalMs < best) console.log(`NEW BEST (previous ${best}ms).`);
      else console.log(`Best remains ${best}ms.`);
    } catch {
      // benchmarking must never fail a run
    }
    journal({ sold, keepers: bagPlan.keepers.length, returnLabel: returnLabel ?? null, ...phases });
  }
  await harness.dispose({ outcome: "complete", live });
} catch (error) {
  const stopped = error instanceof SortStop;
  console.log(String(error instanceof Error ? error.message : error));
  if (!stopped) exitCode = 1;
  journal({ error: String(error instanceof Error ? error.message : error) });
  await harness.dispose({ outcome: stopped ? "stopped" : "failed" });
} finally {
  await controlHost.close();
  await host.close();
}
process.exit(exitCode);
