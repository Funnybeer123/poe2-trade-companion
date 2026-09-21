/**
 * Live Maps 12×8 + bag lattice over the Path of Exile window.
 * Pink = waystone wells juice clicks; gold = bag orb cells.
 * Numpad 4/6/8/2 nudges Maps left/right/up/down and saves.
 * Numpad 0 hides the overlay. In the companion app, Ctrl+Alt+G toggles
 * the same Maps/bag lattice. No game clicks are sent.
 *
 *   npm run juice:grids
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { applyMapsStashPanel, mapsStashGrid, nudgeGridMark } from "../src/core/calibrationProfile.js";
import { loadProfile, saveProfile } from "../src/core/calibrationStore.js";
import { hostLatticeRects, planJuiceGridOverlay } from "../src/core/gridLattice.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";

const NUDGE = 8;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userTemplateDir = path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "perception-templates");
const fixtureTemplateDir = path.join(root, "fixtures", "perception", "templates");
const templateDir =
  process.env.POE2_TEMPLATE_DIR ??
  (existsSync(path.join(userTemplateDir, "calibration.json")) ? userTemplateDir : fixtureTemplateDir);

let profile = loadProfile(templateDir);
const host = startWinHost({ requestTimeoutMs: 65_000 });

function nudgeMaps(dx: number, dy: number): void {
  const mark = mapsStashGrid(profile);
  if (!mark) return;
  const next = nudgeGridMark(mark, dx, dy);
  profile = {
    ...profile,
    mapsStashGrid: applyMapsStashPanel(next, mark.patch),
  };
  saveProfile(templateDir, profile);
}

try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  await host.send({ op: "focus" });
  const client = resolvePhysicalClient(
    {
      left: Number(rect.left),
      top: Number(rect.top),
      width: Number(rect.width),
      height: Number(rect.height),
    },
    Number(rect.monitorWidth) || Number(rect.width),
    Number(rect.monitorHeight) || Number(rect.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );

  const draw = async (): Promise<void> => {
    const plan = planJuiceGridOverlay(profile, client);
    if (plan.grids.length === 0) {
      throw new Error("No Maps or bag grid saved — open Tools → Calibration and draw them first.");
    }
    const maps = mapsStashGrid(profile);
    const rects = [
      ...hostLatticeRects(plan),
      {
        x: 1500,
        y: 30,
        w: 1400,
        h: 70,
        kind: "click" as const,
        label: `Maps nudge 4=left 6=right 8=up 2=down (${NUDGE}px) · 0=hide   [${maps ? `${maps.x},${maps.y}` : "none"}]`,
      },
    ];
    await host.send({ op: "marks", rects });
  };

  await draw();
  const maps = mapsStashGrid(profile);
  console.log(
    `juice-grids overlay · Maps 12×8 · Bag 12×5 · Maps at ${maps?.x ?? "?"},${maps?.y ?? "?"}`,
  );
  console.log("Numpad 4 slides Maps left (saves). 6 right · 8 up · 2 down · 0 hides.");
  for (;;) {
    const reply = await host.send({ op: "waitkey", timeoutMs: 60_000 });
    if (reply.ok !== true) continue;
    const key = Number(reply.key);
    if (key === 0) break;
    if (key === 4) nudgeMaps(-NUDGE, 0);
    else if (key === 6) nudgeMaps(NUDGE, 0);
    else if (key === 8) nudgeMaps(0, -NUDGE);
    else if (key === 2) nudgeMaps(0, NUDGE);
    else continue;
    const at = mapsStashGrid(profile);
    console.log(`Maps nudged to ${at?.x},${at?.y}`);
    await draw();
  }
} finally {
  await host.send({ op: "hidemark" }).catch(() => undefined);
  await host.close();
}
