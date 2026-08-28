/**
 * Label-driven remove-only drainer, immune to tab-list reordering: walks
 * every visible list row fresh (top window, then bottom window), and for any
 * row whose label matches a configured remove-only source pattern, drains
 * that tab into the first non-remove-only tab matching its destination
 * pattern. Already-exhausted tabs are recognized by content signature and
 * skipped. The bag is verifiably emptied before every new sweep.
 *
 * Usage:
 *   npx tsx scripts/assistive-drain-labels.ts \
 *     --routes "dist remove>dist;runes remove>runes;une remove>runes;maps remove>big maps" \
 *     [--fallback "great gear"] [--max-trips=90]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { DrainKit, normalizePattern } from "../src/adapters/drainKit.js";
import { signatureDistance } from "../src/core/tabRouter.js";

interface SubView {
  name: string;
  x: number;
  y: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");

const routesArg = process.argv.find((arg) => arg.startsWith("--routes"));
const routesValue = routesArg?.includes("=")
  ? routesArg.slice(routesArg.indexOf("=") + 1)
  : process.argv[process.argv.indexOf("--routes") + 1];
if (!routesValue) {
  console.error('Usage: --routes "srcPattern>destPattern;..." [--fallback destPattern] [--max-trips=N]');
  process.exit(1);
}
const routes = routesValue.split(";").map((token) => {
  const [source, dest] = token.split(">").map((part) => part.trim());
  if (!source || !dest) throw new Error(`bad route: ${token}`);
  return { source, dest };
});
const fallbackIdx = process.argv.indexOf("--fallback");
const fallback = fallbackIdx >= 0 ? process.argv[fallbackIdx + 1] : undefined;
const maxTrips = Number(process.argv.find((arg) => arg.startsWith("--max-trips="))?.slice(12) ?? 90);

const host = startWinHost({ requestTimeoutMs: 30_000 });
const kit = new DrainKit(host, root, templateDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signatures of tabs already drained to exhaustion this session. */
const exhausted: number[][] = [];
function looksExhausted(signature: number[]): boolean {
  // Animated specialty layouts (breach, delirium) shift their signature a
  // little between visits â€” allow generous drift.
  // Tight threshold: distinct full gear quads can sit within ~10 of each
  // other, which false-skipped undrained tabs. Loop control comes from the
  // per-label counters instead.
  return signature.length > 0 && exhausted.some((known) => signatureDistance(known, signature) < 3);
}

/** How many times each label was drained; a label never yields twice. */
const drainedLabels = new Map<string, number>();

function viewsForLabel(label: string): SubView[] {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(templateDir, "specialty-views.json"), "utf8"),
    ) as { layouts: Array<{ match: string; views: SubView[] }> };
    const normalized = label.toLowerCase();
    return parsed.layouts.find((layout) => normalized.includes(layout.match.toLowerCase()))?.views ?? [];
  } catch {
    return [];
  }
}

async function clickSubView(view: SubView): Promise<void> {
  const snap = await kit.snapshot();
  await host.send({ op: "click", x: snap.client.left + view.x, y: snap.client.top + view.y });
  await sleep(500);
}

let totalTrips = 0;
let totalMoved = 0;

async function emptyBagInto(destPattern: string): Promise<number> {
  const destinations = [destPattern, ...(fallback ? fallback.split(",").map((s) => s.trim()) : [])];
  let state = await kit.verifiedBag();
  for (const dest of destinations) {
    if (state.count === 0) return 0;
    const label = await kit.gotoLabel(dest, true);
    if (!label) {
      console.log(`  destination "${dest}" not found in list`);
      continue;
    }
    for (let pass = 0; pass < 3 && state.count > 0; pass += 1) {
      const previous = state.keys;
      await kit.depositBag(pass > 0);
      state = await kit.verifiedBag();
      if (
        state.count > 0 &&
        pass > 0 &&
        state.count === previous.size &&
        [...state.keys].every((key) => previous.has(key))
      ) {
        console.log(`  ${state.count} cells stuck at "${label}" â€” trying next destination`);
        break;
      }
    }
  }
  if (state.count > 0) {
    for (const key of state.keys) kit.undepositable.add(key);
    console.log(`  ${state.count} cell(s) refuse deposit everywhere â€” set aside as undepositable`);
    state = await kit.verifiedBag();
  }
  return state.count;
}

async function drainCurrentTabInto(destPattern: string, sourceLabel: string, view?: SubView): Promise<void> {
  if (view) {
    await clickSubView(view);
    const peek = await kit.snapshot();
    if (peek.facts.occupiedStash.length === 0 && peek.rgbStash.length === 0) {
      console.log(`  view "${view.name}" empty`);
      return;
    }
  }
  let latticeNoGain = 0;
  let latticePhase = 0;
  let targeted = true;
  let shiftTried = false;
  let bagAfter = (await kit.verifiedBag()).count;
  if (bagAfter > 0) {
    // A pre-loaded bag makes every sweep a silent no-op â€” deposit it first.
    console.log(`  bag starts with ${bagAfter} cells â€” emptying before sweeping`);
    bagAfter = await emptyBagInto(destPattern);
    if (!(await returnToSource(sourceLabel))) return;
  }
  for (;;) {
    if (totalTrips >= maxTrips) return;
    const wasTargeted = targeted;
    const bagCells = await kit.sweepStash(targeted, latticePhase);
    if (bagCells - bagAfter <= 0) {
      if (wasTargeted && !shiftTried) {
        shiftTried = true;
        const shifted = await kit.sweepStash(true, latticePhase, true);
        if (shifted - bagAfter > 0) {
          targeted = true;
          latticeNoGain = 0;
          totalTrips += 1;
          totalMoved += shifted - bagAfter;
          console.log(`  trip ${totalTrips}: +${shifted - bagAfter} cells (shift-ctrl)`);
          bagAfter = await emptyBagInto(destPattern);
          if (!(await returnToSource(sourceLabel))) return;
          if (view) await clickSubView(view);
          continue;
        }
      }
      if (wasTargeted) {
        targeted = false;
        continue;
      }
      latticePhase += 1;
      latticeNoGain += 1;
      if (latticeNoGain >= 2) {
        console.log("  exhausted");
        return;
      }
      continue;
    }
    targeted = true;
    latticeNoGain = 0;
    totalTrips += 1;
    totalMoved += bagCells - bagAfter;
    console.log(`  trip ${totalTrips}: +${bagCells - bagAfter} cells`);
    bagAfter = await emptyBagInto(destPattern);
    if (!(await returnToSource(sourceLabel))) return;
    if (view) await clickSubView(view);
  }
}

async function returnToSource(sourceLabel: string): Promise<boolean> {
  const found = await kit.gotoLabel(sourceLabel);
  if (!found) {
    console.log(`  source "${sourceLabel}" no longer found â€” done with it`);
    return false;
  }
  return true;
}

try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("PoE window not found");
  await kit.ensurePanelsOpen();

  const startBag = (await kit.verifiedBag()).count;
  if (startBag > 0) {
    console.log(`bag starts with ${startBag} cells â€” emptying into "${routes[0]!.dest}" first`);
    await emptyBagInto(routes[0]!.dest);
  }

  for (const route of routes) {
    console.log(`\n=== route "${route.source}" -> "${route.dest}" ===`);
    // Keep finding rows matching this source pattern until none yield items.
    for (let round = 0; round < 12; round += 1) {
      if (totalTrips >= maxTrips) break;
      await kit.ensurePanelsOpen();
      const label = await kit.gotoLabel(route.source);
      if (!label) {
        console.log("no matching source row found");
        break;
      }
      const arrival = await kit.snapshot();
      if (looksExhausted(arrival.signature)) {
        console.log(`"${label}" already exhausted â€” no more fresh matches`);
        break;
      }
      if (arrival.facts.occupiedStash.length === 0 && arrival.rgbStash.length === 0) {
        console.log(`\"${label}\" visibly empty`);
        exhausted.push(arrival.signature);
        const key = "empty:" + normalizePattern(label);
        const seen = (drainedLabels.get(key) ?? 0) + 1;
        drainedLabels.set(key, seen);
        if (seen >= 3) { console.log("  repeatedly empty - moving on"); break; }
        continue;
      }
      const normalizedLabel = normalizePattern(label);
      const emptySeen = (drainedLabels.get("empty:" + normalizedLabel) ?? 0);
      const timesDrained = drainedLabels.get(normalizedLabel) ?? 0;
      if (timesDrained >= 3) {
        console.log(`"${label}" already drained ${timesDrained}x â€” moving on`);
        break;
      }
      drainedLabels.set(normalizedLabel, timesDrained + 1);
      console.log(`draining "${label}" (${arrival.facts.occupiedStash.length} occupied-ish cells)`);
      await drainCurrentTabInto(route.dest, label);
      // Specialty layouts hide items behind nested sub-tabs — sweep each.
      for (const view of viewsForLabel(label)) {
        if (totalTrips >= maxTrips) break;
        if (!(await returnToSource(label))) break;
        console.log(`  -- sub-view "${view.name}" --`);
        await drainCurrentTabInto(route.dest, label, view);
      }
      const final = await kit.snapshot();
      if (final.signature.length) exhausted.push(final.signature);
      await sleep(300);
    }
  }
  console.log(`\n=== done: ${totalTrips} trips, ~${totalMoved} cells moved, ${kit.undepositable.size} undepositable ===`);
} finally {
  await host.close();
}
