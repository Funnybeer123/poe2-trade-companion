import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bmpToGray } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { activeStashGrid } from "../src/core/calibrationProfile.js";
import { loadProfile, saveProfile } from "../src/core/calibrationStore.js";
import { crop, downsample, grayToJson } from "../src/core/grayImage.js";
import { isStashSearchClick, stashSearchClick } from "../src/core/stashSearch.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const labelIndex = process.argv.indexOf("--label");
const label = (labelIndex >= 0 ? process.argv[labelIndex + 1] : process.argv[2]) ?? "stash-open";
const liveDir = path.join(root, "fixtures", "perception", "live");
const templateDir = path.join(root, "fixtures", "perception", "templates");

mkdirSync(liveDir, { recursive: true });
mkdirSync(templateDir, { recursive: true });

const searchBoxArg = process.argv.find((arg) => arg.startsWith("--search-box="))?.slice(13);
if (searchBoxArg) {
  const [x = Number.NaN, y = Number.NaN, w = Number.NaN, h = Number.NaN] = searchBoxArg
    .split(",")
    .map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 4 || h <= 4) {
    throw new Error("invalid-search-box-use-x,y,w,h");
  }
  const profile = loadProfile(templateDir);
  const stash = activeStashGrid(profile);
  if (!stash) throw new Error("stash-grid-calibration-required");
  const stashSearch = { x, y, w, h };
  if (!isStashSearchClick(stashSearchClick(stashSearch), stashSearch, stash)) {
    throw new Error("stash-search-calibration-outside-stash-chrome");
  }
  profile.stashSearch = stashSearch;
  profile.updatedAt = new Date().toISOString();
  saveProfile(templateDir, profile);
  console.log(JSON.stringify({ saved: "stashSearch", stashSearch }, null, 2));
  process.exit(0);
}

const host = startWinHost();
try {
  const target = await host.send({ op: "rect" });
  if (!target.ok) {
    console.error("PoE window not found");
    process.exit(1);
  }
  const bmpPath = path.join(liveDir, `${label}.bmp`);
  const previewPath = path.join(liveDir, `${label}.png`);
  const captured = await host.send({ op: "capture", path: bmpPath, previewPath });
  if (!captured.ok) {
    console.error("capture failed", captured);
    process.exit(1);
  }
  const gray = bmpToGray(bmpPath);
  const small = downsample(gray, 160, 90);
  const client = resolvePhysicalClient(
    {
      left: Number(captured.left ?? target.left),
      top: Number(captured.top ?? target.top),
      width: Number(captured.width ?? target.width),
      height: Number(captured.height ?? target.height),
    },
    Number(target.monitorWidth) || Number(captured.width),
    Number(target.monitorHeight) || Number(captured.height),
  );
  writeJson(templateDir, `${label}.json`, small);

  if (label === "stash-open" || label === "stash-and-bag") {
    writeJson(templateDir, "scene-open.json", small);
    writeJson(templateDir, "stash-panel.json", crop(small, 6, 14, 46, 64));
    writeJson(templateDir, "inventory-panel.json", crop(small, 102, 30, 50, 50));
  }
  if (label === "stash-closed") {
    writeJson(templateDir, "scene-closed.json", small);
    writeJson(templateDir, "chest.json", crop(small, 70, 45, 24, 18));
  }
  if (label === "empty-bag") {
    writeJson(templateDir, "empty-cell.json", crop(small, 112, 38, 8, 8));
  }
  if (label === "options") {
    writeJson(templateDir, "options.json", small);
  }

  const { loadPerceptionTemplates } = await import("../src/core/perceptionTemplates.js");
  const { templates } = loadPerceptionTemplates(templateDir);
  const facts = perceiveUi(gray, client, templates);
  writeFileSync(
    path.join(templateDir, `${label}.meta.json`),
    JSON.stringify({ label, client, facts, capturedAt: new Date().toISOString() }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        label,
        client,
        facts,
        bmpPath,
        previewPath,
        confirm:
          label === "stash-open"
            ? "Only keep this if YOU can see both the stash and the bag on screen right now."
            : "Leave Path of Exile 2 on this exact screen if you recapture.",
      },
      null,
      2,
    ),
  );
} finally {
  await host.close();
}

function writeJson(dir: string, name: string, image: ReturnType<typeof downsample>) {
  writeFileSync(path.join(dir, name), JSON.stringify(grayToJson(image)));
}
