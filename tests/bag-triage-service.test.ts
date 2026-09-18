import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BagTriageService } from "../src/main/bagTriageService.js";
import { openBagJournal } from "../src/main/bagSessionStore.js";
import { session } from "./support/bagFixtures.js";
import { registerScanIpc } from "../src/main/scanIpc.js";
import type { ScannerRuntimeService } from "../src/main/scanRuntimeService.js";
import { emptyProfile } from "../src/core/calibrationProfile.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(packaged = true) {
  vi.useFakeTimers();
  const root = mkdtempSync(path.join(os.tmpdir(), "poe2-bag-desktop-")); dirs.push(root);
  const dataRoot = path.join(root, "selected data"), templateDir = path.join(dataRoot, "perception-templates");
  mkdirSync(templateDir, { recursive: true });
  const workerFile = packaged ? path.join(root, "map-triage.cjs") : undefined;
  const entry = workerFile ?? path.join(root, "dist-electron", "map-triage.cjs");
  mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, "// fake worker, never executed");
  const outputDir = path.join(dataRoot, "artifacts", "map-triage"); mkdirSync(outputDir, { recursive: true });
  const clientLog = path.join(root, "Client.txt"); writeFileSync(clientLog, "sanitized log fixture; never used to launch a host");
  writeFileSync(path.join(templateDir, "calibration.json"), JSON.stringify({ ...emptyProfile(), bagGrid: { x: 2530, y: 1173, w: 1289, h: 541, cols: 12, rows: 5 } }));
  writeFileSync(path.join(outputDir, "live-perception.json"), JSON.stringify({ version: 1, client: { width: 3840, height: 2160 },
    emptyCursorHashes: ["a".repeat(64)], wisdomCursorHashes: [], inventoryChrome: { box: { x: 2700, y: 120, w: 20, h: 20 }, patch: { width: 2, height: 2, pixels: [12, 130, 30, 250] } },
    ground: { x: 1500, y: 800 }, evidence: "synthetic:desktop-test" }));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: 4321 });
  const spawnMock = vi.fn(() => child), emit = vi.fn(), blocked = vi.fn<() => string | undefined>(() => undefined);
  const options = { root, dataRoot, templateDir, workerFile, clientLog, spawn: spawnMock as unknown as typeof spawn, emit, blocked };
  const service = new BagTriageService(options);
  const save = (name = "saved.jsonl", origin: "live" | "replay" = "live") => {
    const file = path.join(dataRoot, "artifacts", "map-triage", name), journal = openBagJournal(file), saved = session([]);
    saved.origin = origin; journal.save(saved); journal.close(); return file;
  };
  const started = () => spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; shell: boolean; cwd: string }];
  return { root, dataRoot, templateDir, workerFile, options, child, spawnMock, blocked, emit, service, save, started };
}

describe("desktop staged bag worker", () => {
  it.each(["gamble", "cleanup"] as const)("uses the existing no-input preview for %s", async stage => {
    const f = setup(); writeFileSync(path.join(f.root, "ring-gamble.cjs"), "// fake");
    f.service.start(stage, { dryRun: true }); await vi.advanceTimersByTimeAsync(3000);
    expect(f.started()[1]).not.toContain("--run");
    expect(f.started()[1].includes("--rescan")).toBe(stage === "cleanup");
    f.child.emit("exit", 0);
  });
  it.each(["gamble", "cleanup"] as const)("launches the bundled ring worker for %s with native cancellation", async stage => {
    const f = setup();
    writeFileSync(path.join(f.root, "ring-gamble.cjs"), "// fake");
    const calibrationFile = path.join(f.templateDir, "calibration.json");
    const calibration = JSON.parse(readFileSync(calibrationFile, "utf8"));
    calibration.ventorBagGrid = { x: 100, y: 200, w: 1200, h: 500, cols: 12, rows: 5 };
    writeFileSync(calibrationFile, JSON.stringify(calibration));
    rmSync(f.options.clientLog);
    expect(f.service.refresh().gambleReadiness).toEqual([]);
    if (stage === "cleanup") {
      f.service.setCleanupHotkey(true);
      f.service.startCleanupFromHotkey(); f.service.startCleanupFromHotkey();
      expect(f.service.status.cleanupHotkey).toBe("Ctrl+Alt+V");
    } else f.service.start(stage);
    await vi.advanceTimersByTimeAsync(3000);
    const [, args, options] = f.started();
    expect(args[0]).toBe(path.join(f.root, "ring-gamble.cjs")); expect(args).toContain("--run");
    expect(args.includes("--rescan")).toBe(stage === "cleanup");
    expect(f.spawnMock).toHaveBeenCalledOnce();
    expect(options.env.POE2_BAG_STOP_FILE).toContain("desktop-stop-");
    f.child.stdout.write('{"purchased":4,"sold":2,"retained":2}\n'); f.child.emit("exit", 0);
    expect(f.service.status).toMatchObject({ running: false, purchased: 4, sold: 2, retained: 2, journal: undefined });
  });

  it.each([false, true])("starts the full workflow with a fresh journal even when a saved bag is selected: %s", async selected => {
    const f = setup();
    if (selected) { f.save(); f.service.select("saved.jsonl"); }
    const status = f.service.start("workflow");
    expect(status).toMatchObject({ running: true, phase: "countdown", stage: "workflow" });
    expect(status.journal).toMatch(/^bag-.*\.jsonl$/); expect(status.journal).not.toBe("saved.jsonl");
    expect(status.physicalItems).toBeUndefined(); expect(status.verifiedDrops).toBeUndefined();
    expect(f.spawnMock).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "countdown", stage: "workflow" }));
    await vi.advanceTimersByTimeAsync(3000);
    const [, args, options] = f.started();
    expect(args).toContain("--stage=workflow"); expect(args).toContain("--run");
    expect(args).toContain("--journal=" + path.join(f.dataRoot, "artifacts", "map-triage", status.journal!));
    expect(args.some(arg => arg.startsWith("--max-identifications=") || arg.startsWith("--max-drops="))).toBe(false);
    expect(options.env.POE2_BAG_STOP_FILE).toContain("desktop-stop-");
    expect(f.service.status.message).toBe("Identifying your bag and dropping low-priority items…");
    f.child.stdout.write('{"physicalItems":20,"unreadCells":0,"verifiedIdentifications":8,"verifiedDrops":6}\n');
    f.child.emit("exit", 0);
    expect(f.service.status).toMatchObject({ running: false, phase: "complete", physicalItems: 20, verifiedIdentifications: 8, verifiedDrops: 6 });
    expect(f.spawnMock).toHaveBeenCalledOnce();
  });
  it("starts capture explicitly after a cancellable countdown, with selected data and calibration", async () => {
    const f = setup(); const status = f.service.start("capture");
    expect(status).toMatchObject({ running: true, phase: "countdown", stage: "capture" });
    expect(f.spawnMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    const [, args, options] = f.started();
    expect(args).toContain(f.workerFile);
    expect(args).toContain("--stage=capture"); expect(args).not.toContain("--run");
    expect(args).toContain("--calibration=" + path.join(f.templateDir, "calibration.json"));
    expect(options).toMatchObject({ shell: false, cwd: f.dataRoot, env: { ELECTRON_RUN_AS_NODE: "1", POE2_BAG_DATA_ROOT: f.dataRoot, POE2_STASH_DATA_ROOT: f.dataRoot } });
    expect(options.env.POE2_BAG_STOP_FILE).toContain("desktop-stop-"); expect(existsSync(options.env.POE2_BAG_STOP_FILE!)).toBe(false);
    expect(args.some(arg => arg.startsWith("--journal=") && arg.endsWith(".jsonl"))).toBe(true);
    f.child.stdout.write('{"physicalItems":'); f.child.stdout.write('17,"unreadCells":0}\n');
    f.child.stdout.write('{"verifiedIdentifications":0,"verifiedDrops":0}\n'); f.child.emit("exit", 0);
    expect(f.service.status).toMatchObject({ running: false, phase: "complete", physicalItems: 17, unreadCells: 0 });
    expect(f.spawnMock).toHaveBeenCalledOnce();
  });
  it.each(["identify", "drop", "reconcile"] as const)("runs only the requested %s stage against a selected live journal", async stage => {
    const f = setup(); const file = f.save("live-adapter/bag-01.jsonl"); f.service.select("live-adapter/bag-01.jsonl");
    f.service.start(stage); await vi.advanceTimersByTimeAsync(3000);
    const [, args] = f.started();
    expect(args).toContain("--journal=" + file); expect(args).toContain("--stage=" + stage);
    if (stage === "identify") { expect(args).toContain("--max-identifications=1"); expect(args).toContain("--run"); expect(args).not.toContain("--max-drops=1"); }
    if (stage === "drop") { expect(args).toContain("--max-drops=1"); expect(args).toContain("--run"); }
    if (stage === "reconcile") expect(args).not.toContain("--run");
    f.child.emit("exit", 0);
    expect(new BagTriageService(f.options).status.journal).toBe("live-adapter/bag-01.jsonl");
  });
  it("uses the built worker in development without tsx, npx or a shell", async () => {
    const f = setup(false); f.service.start("capture"); await vi.advanceTimersByTimeAsync(3000);
    const [, args, options] = f.started();
    expect(args.slice(0, 2)).toEqual([path.join(f.root, "dist-electron", "map-triage.cjs"), "--stage=capture"]);
    expect(args.some(arg => /(?:tsx|npx|map-triage\.ts)/.test(arg))).toBe(false);
    expect(options.shell).toBe(false); f.child.emit("exit", 0);
  });
  it("rejects unsupported stages, replay sessions, escaped paths and concurrent starts without spawning", () => {
    const f = setup(); f.save("replay.jsonl", "replay");
    expect(() => f.service.start("all" as never)).toThrow("Unknown");
    expect(() => f.service.start("identify")).toThrow("Capture or select");
    expect(() => f.service.select("replay.jsonl")).toThrow("live");
    expect(() => f.service.select("../outside.jsonl")).toThrow("saved");
    f.service.start("capture"); expect(() => f.service.start("capture")).toThrow("already running"); f.service.stop();
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it("rechecks the global interlock after the countdown and cancels without spawning", async () => {
    const f = setup(); f.service.start("capture"); f.blocked.mockReturnValue("Emergency stop latched.");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.service.status).toMatchObject({ running: false, phase: "error", message: "Emergency stop latched." });
    expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it.each(["capture", "workflow"] as const)("cancels %s countdown before any process starts", async stage => {
    const f = setup(); f.service.start(stage); f.service.stop(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.spawnMock).not.toHaveBeenCalled(); expect(f.service.status.running).toBe(false);
  });
  it.each(["capture", "workflow"] as const)("signals %s cancellation and waits for native release acknowledgement before termination", async stage => {
    const f = setup(); f.service.start(stage); await vi.advanceTimersByTimeAsync(3000);
    const latch = f.started()[2].env.POE2_BAG_STOP_FILE!;
    f.service.stop(); expect(readFileSync(latch, "utf8")).toBe("stop");
    await vi.advanceTimersByTimeAsync(2000); expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.service.status).toMatchObject({ running: true, phase: "stopping" });
    writeFileSync(latch + ".ack", "released"); await vi.advanceTimersByTimeAsync(50);
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.service.status.running).toBe(true);
    f.child.emit("exit", null); expect(f.service.status.running).toBe(false);
    expect(existsSync(latch)).toBe(false); expect(existsSync(latch + ".ack")).toBe(false);
  });
  it("reports actual worker failures and never chains another stage", async () => {
    const f = setup(); f.service.start("capture"); await vi.advanceTimersByTimeAsync(3000);
    f.child.stderr.write("Game focus lost; no further bag input.\n"); f.child.emit("exit", 1);
    expect(f.service.status).toMatchObject({ phase: "error", running: false, message: "Game focus lost; no further bag input." });
    expect(f.spawnMock).toHaveBeenCalledOnce();
  });
  it("blocks scanner IPC before invoking a competing input service", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>(), start = vi.fn();
    registerScanIpc({ handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => { handlers.delete(channel); } },
      { start } as unknown as ScannerRuntimeService, () => { throw new Error("Bag stage is running."); });
    await expect(handlers.get("scanner:start")!({}, {})).rejects.toThrow("Bag stage"); expect(start).not.toHaveBeenCalled();
  });
  it("reports missing calibration before countdown or process startup", () => {
    const f = setup(); rmSync(path.join(f.templateDir, "calibration.json"));
    expect(f.service.refresh().readiness).toContain("Inventory calibration is missing. Open Calibration and mark the bag grid.");
    expect(() => f.service.start("capture")).toThrow("Inventory calibration is missing");
    expect(f.service.status.running).toBe(false); expect(f.spawnMock).not.toHaveBeenCalled();
  });
  it("requests a local build when the development worker is absent, without bootstrapping dependencies", () => {
    const f = setup(false); rmSync(path.join(f.root, "dist-electron", "map-triage.cjs"));
    expect(f.service.refresh().readiness).toContain("Build the bag worker with npm run build, then refresh setup.");
    expect(() => f.service.start("capture")).toThrow("npm run build"); expect(f.spawnMock).not.toHaveBeenCalled();
  });
});
