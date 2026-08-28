/**
 * Read-only perception probe: captures a burst of frames from the running
 * game, runs every occupancy classifier side by side, votes across frames,
 * learns/updates the empty-cell baseline model, and writes annotated PNGs
 * plus a JSON report showing exactly where and why detection disagrees.
 *
 * Usage: npx tsx scripts/perception-probe.ts [--frames=4] [--interval=300] [--out=dir]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBmpBgr, bgrToGray } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import {
  baselineCoverage,
  emptyBaseline,
  learnBaseline,
  occupiedFromBaseline,
  scoreAgainstBaseline,
  type BaselineModel,
} from "../src/core/cellBaseline.js";
import type { BgrImage } from "../src/core/cellOccupancy.js";
import { voteOccupancy } from "../src/core/occupancyVoting.js";
import {
  analyzeFrame,
  annotateGrid,
  cloneBgr,
  cropBgr,
  type FrameAnalysis,
  type GridSnapshot,
} from "../src/core/perceptionProbe.js";
import { encodeBgrPng } from "../src/core/pngWrite.js";
import { resolvePhysicalClient, type ScreenRect } from "../src/core/screenLayout.js";
import { perceiveUi } from "../src/core/uiPerception.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const frameCount = Math.max(1, Number(arg("frames", "4")));
const intervalMs = Math.max(0, Number(arg("interval", "300")));
const outDir = arg("out", path.join(os.tmpdir(), "poe2-perception-probe", `${Date.now()}`));
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CapturedFrame {
  bgr: BgrImage;
  gray: ReturnType<typeof bgrToGray>;
  analysis: FrameAnalysis;
  captureMs: number;
  decodeMs: number;
}

function gridKey(snapshot: GridSnapshot): string {
  return `${snapshot.cols}x${snapshot.rows}`;
}

function baselinePath(name: string): string {
  return path.join(templateDir, `baseline-${name}.json`);
}

function loadBaseline(name: string, cols: number, rows: number): BaselineModel {
  const file = baselinePath(name);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as BaselineModel;
      if (parsed.version === 1 && parsed.cols === cols && parsed.rows === rows) return parsed;
    } catch {
      /* corrupted model — rebuild */
    }
  }
  return emptyBaseline(cols, rows);
}

const profile = loadProfile(templateDir);
const host = startWinHost();
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) {
    console.error("PoE2 window not found — is the game running?", rect.error ?? "");
    process.exit(1);
  }
  console.log(
    `target: ${String(rect.process)} "${String(rect.title)}" mode=${String(rect.displayMode)} monitor=${String(rect.monitorLabel)}`,
  );

  const frames: CapturedFrame[] = [];
  let client: ScreenRect | undefined;
  for (let i = 0; i < frameCount; i += 1) {
    if (i > 0) await sleep(intervalMs);
    const bmpPath = path.join(outDir, `frame-${i}.bmp`);
    const t0 = performance.now();
    const captured = await host.send({ op: "capture", path: bmpPath });
    const t1 = performance.now();
    if (!captured.ok) {
      console.error(`capture ${i} failed:`, captured.error ?? captured);
      process.exit(1);
    }
    client ??= resolvePhysicalClient(
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
    const bgr = readBmpBgr(bmpPath);
    const gray = bgrToGray(bgr);
    const t2 = performance.now();
    const analysis = analyzeFrame(() => perceiveUi(gray, client!, {}, profile, bgr), gray, bgr, client);
    frames.push({ bgr, gray, analysis, captureMs: t1 - t0, decodeMs: t2 - t1 });
    rmSync(bmpPath, { force: true });
    console.log(
      `frame ${i}: reason=${analysis.facts.reason} conf=${analysis.facts.confidence} ` +
        `stash=${analysis.facts.occupiedStash.length} bag=${analysis.facts.occupiedBag.length} ` +
        `capture=${Math.round(t1 - t0)}ms decode=${Math.round(t2 - t1)}ms ` +
        `perceive=${Math.round(analysis.timings.perceiveMs)}ms classifiers=${Math.round(analysis.timings.classifiersMs)}ms`,
    );
  }

  const last = frames.at(-1)!;
  const annotated = cloneBgr(last.bgr);
  const report: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    client,
    displayMode: rect.displayMode,
    frames: frames.map((frame, i) => ({
      index: i,
      reason: frame.analysis.facts.reason,
      confidence: frame.analysis.facts.confidence,
      captureMs: Math.round(frame.captureMs),
      decodeMs: Math.round(frame.decodeMs),
      perceiveMs: Math.round(frame.analysis.timings.perceiveMs),
      classifiersMs: Math.round(frame.analysis.timings.classifiersMs),
    })),
    grids: {} as Record<string, unknown>,
  };

  for (const kind of ["stash", "bag"] as const) {
    const snapshots = frames
      .map((frame) => frame.analysis[kind])
      .filter((snapshot): snapshot is GridSnapshot => Boolean(snapshot));
    if (snapshots.length === 0) {
      (report.grids as Record<string, unknown>)[kind] = { detected: false };
      console.log(`${kind}: grid not detected in any frame`);
      continue;
    }
    const lastSnap = snapshots.at(-1)!;
    const sameShape = snapshots.every((snapshot) => gridKey(snapshot) === gridKey(lastSnap));
    const grayVote = voteOccupancy(snapshots.map((snapshot) => snapshot.gray));
    const rgbVote = voteOccupancy(snapshots.map((snapshot) => snapshot.rgb));
    const flicker = [...grayVote.flicker, ...rgbVote.flicker];

    // Learn baseline only from cells both classifiers call empty in every frame.
    const total = lastSnap.cols * lastSnap.rows;
    const everOccupied = new Set<string>();
    for (const snapshot of snapshots) {
      for (const cell of [...snapshot.gray, ...snapshot.rgb]) everOccupied.add(`${cell.row},${cell.col}`);
    }
    const agreedEmpty: Array<{ row: number; col: number }> = [];
    for (let row = 0; row < lastSnap.rows; row += 1) {
      for (let col = 0; col < lastSnap.cols; col += 1) {
        if (!everOccupied.has(`${row},${col}`)) agreedEmpty.push({ row, col });
      }
    }
    const modelName = kind === "bag" ? "bag" : `stash-${gridKey(lastSnap)}`;
    let model = loadBaseline(modelName, lastSnap.cols, lastSnap.rows);
    let baselineOccupied: Array<{ row: number; col: number }> = [];
    let baselineAgreement: Record<string, unknown> = {};
    if (sameShape && snapshots.length === frames.length && client) {
      model = learnBaseline(model, last.bgr, client, lastSnap.region, agreedEmpty);
      writeFileSync(baselinePath(modelName), JSON.stringify(model));
      const scores = scoreAgainstBaseline(model, last.bgr, client, lastSnap.region);
      baselineOccupied = occupiedFromBaseline(scores);
      const rgbSet = new Set(lastSnap.rgb.map((cell) => `${cell.row},${cell.col}`));
      const baseSet = new Set(baselineOccupied.map((cell) => `${cell.row},${cell.col}`));
      baselineAgreement = {
        coverage: baselineCoverage(model),
        occupied: baselineOccupied.length,
        onlyBaseline: baselineOccupied.filter((cell) => !rgbSet.has(`${cell.row},${cell.col}`)),
        onlyRgb: lastSnap.rgb
          .filter((cell) => !baseSet.has(`${cell.row},${cell.col}`))
          .map(({ row, col }) => ({ row, col })),
      };
    }

    annotateGrid(annotated, client!, lastSnap, { flickerCells: flicker, baselineOccupied });
    (report.grids as Record<string, unknown>)[kind] = {
      detected: true,
      shape: gridKey(lastSnap),
      framesDetected: snapshots.length,
      grayOccupied: lastSnap.gray.length,
      rgbOccupied: lastSnap.rgb.length,
      grayOnly: lastSnap.grayOnly,
      rgbOnly: lastSnap.rgbOnly,
      grayFlickerRate: grayVote.flickerRate,
      rgbFlickerRate: rgbVote.flickerRate,
      flickerCells: flicker,
      baseline: baselineAgreement,
    };
    console.log(
      `${kind} (${gridKey(lastSnap)}): gray=${lastSnap.gray.length} rgb=${lastSnap.rgb.length} ` +
        `disagree=${lastSnap.grayOnly.length + lastSnap.rgbOnly.length} ` +
        `flicker gray=${grayVote.flicker.length} rgb=${rgbVote.flicker.length} ` +
        `baseline=${baselineOccupied.length}`,
    );

    if (client) {
      const sx = annotated.width / client.width;
      const sy = annotated.height / client.height;
      const margin = 32;
      const cropImg = cropBgr(
        annotated,
        (lastSnap.region.x - client.left) * sx - margin,
        (lastSnap.region.y - client.top) * sy - margin,
        lastSnap.region.w * sx + margin * 2,
        lastSnap.region.h * sy + margin * 2,
      );
      writeFileSync(path.join(outDir, `annotated-${kind}.png`), encodeBgrPng(cropImg));
    }
  }

  writeFileSync(path.join(outDir, "annotated-full.png"), encodeBgrPng(annotated));
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const keep = arg("keep", "");
  if (keep) {
    mkdirSync(keep, { recursive: true });
    for (const file of ["annotated-full.png", "annotated-stash.png", "annotated-bag.png", "report.json"]) {
      const src = path.join(outDir, file);
      if (existsSync(src)) copyFileSync(src, path.join(keep, file));
    }
  }
  console.log(`\nlegend: green=both classifiers occupied, orange=gray-only, magenta=rgb-only,`);
  console.log(`        cyan corner=baseline-diff occupied, red corner=flickered across frames`);
  console.log(`artifacts: ${outDir}`);
} finally {
  await host.close();
}
