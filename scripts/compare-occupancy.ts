import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bmpToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { toScreenBox } from "../src/core/calibrationProfile.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../src/core/cellOccupancy.js";
import { perceiveUi } from "../src/core/uiPerception.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = path.join(root, "fixtures", "perception", "live");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const profile = loadProfile(templateDir);
const client = { left: 0, top: 0, width: 3840, height: 2160 };

function keys(cells: Array<{ row: number; col: number }>): string[] {
  return cells.map((cell) => `${cell.row},${cell.col}`).sort();
}

function diff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: a.filter((key) => !setB.has(key)),
    onlyB: b.filter((key) => !setA.has(key)),
  };
}

function occupancyFor(file: string) {
  const bmpPath = path.isAbsolute(file) ? file : path.join(liveDir, file);
  const bgr = readBmpBgr(bmpPath);
  const gray = bmpToGray(bmpPath);
  const facts = perceiveUi(gray, client, {}, profile);
  const bagRegion = profile.bagGrid ? toScreenBox(client, profile.bagGrid) : undefined;
  const stashGrid = profile.activeStashTab === "quad" ? profile.quadStashGrid : profile.stashGrid;
  const stashRegion = stashGrid ? toScreenBox(client, stashGrid) : undefined;
  const grayBag = facts.occupiedBag;
  const grayStash = facts.occupiedStash;
  const rgbBag = bagRegion
    ? occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, bagRegion, 12, 5))
    : [];
  const rgbStash =
    stashRegion && stashGrid
      ? occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, stashRegion, stashGrid.cols, stashGrid.rows))
      : [];
  const bag = diff(keys(grayBag), keys(rgbBag));
  const stash = diff(keys(grayStash), keys(rgbStash));
  return {
    file: path.basename(bmpPath),
    reason: facts.reason,
    bag: {
      gray: grayBag.length,
      rgb: rgbBag.length,
      grayOnly: bag.onlyA,
      rgbOnly: bag.onlyB,
    },
    stash: {
      gray: grayStash.length,
      rgb: rgbStash.length,
      grayOnly: stash.onlyA.slice(0, 12),
      rgbOnly: stash.onlyB.slice(0, 12),
      grayOnlyCount: stash.onlyA.length,
      rgbOnlyCount: stash.onlyB.length,
    },
    leftoverWand: rgbBag.some((cell) => cell.col === 11 && cell.row <= 2),
    grayWand: grayBag.some((cell) => cell.col === 11 && cell.row <= 2),
  };
}

function pickFrames(): string[] {
  const asked = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (asked.length) return asked;
  const newest = readdirSync(liveDir)
    .filter((name) => /^(deposit|cycle)-.+\.bmp$/i.test(name))
    .sort()
    .slice(-8);
  const wand = "deposit-1787705758242.bmp";
  return newest.includes(wand) ? newest : [wand, ...newest];
}

const reports = pickFrames().map(occupancyFor);
for (const report of reports) {
  console.log(JSON.stringify(report));
}

const bagBetter = reports.filter((report) => report.bag.rgbOnly.length === 0 && report.bag.grayOnly.length > 0);
const wandHits = reports.filter((report) => report.leftoverWand);
console.log(
  JSON.stringify({
    frames: reports.length,
    bagGrayMean: reports.reduce((sum, report) => sum + report.bag.gray, 0) / reports.length,
    bagRgbMean: reports.reduce((sum, report) => sum + report.bag.rgb, 0) / reports.length,
    stashGrayMean: reports.reduce((sum, report) => sum + report.stash.gray, 0) / reports.length,
    stashRgbMean: reports.reduce((sum, report) => sum + report.stash.rgb, 0) / reports.length,
    wandHits: wandHits.length,
    bagRgbFewer: bagBetter.length,
  }),
);
