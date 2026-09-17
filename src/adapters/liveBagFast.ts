import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cellKey, type BagPosition } from "../core/bagAssessment.js";
import type { FastBagPorts, FastLogEntry, FastLook, FastRead, FastSafety } from "../core/bagFastRun.js";
import { bagArtMask, bagCursorLook, bagFootprintLook, bagProbeDelta, emptyBagCell, type BagArtMask, type BagView } from "../core/bagFastVision.js";
import { obstructingBagUi, visibleLife, visibleLifeInHud } from "../core/bagPixels.js";
import type { BagSession } from "../core/bagSession.js";
import { type CalibrationProfile, type ClientBox, matchChrome } from "../core/calibrationProfile.js";
import { GameInputController } from "../core/gameInputController.js";
import type { InputBatchOptions, InputSink } from "../core/inputSink.js";
import { KillSwitch } from "../core/killSwitch.js";
import { scenario } from "../core/scenarios.js";
import type { InputAction } from "../core/types.js";
import { createBagMapContext } from "./bagMapContext.js";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import { readBagLivePerception } from "./liveBag.js";
import { startWinHost, type WinReply } from "./bagWinHost.js";

/** Milliseconds; each value is a bounded native wait (the host rejects > 250). */
export interface FastBagTuning {
  scanHoverMs: number; carefulHoverMs: number; readTimeoutMs: number; probeSettleMs: number; armSettleMs: number;
  chainSettleMs: number; chainGapMs: number; chainAfterMs: number; heldSettleMs: number; dropGapMs: number;
}
export const DEFAULT_FAST_TUNING: FastBagTuning = { scanHoverMs: 110, carefulHoverMs: 250, readTimeoutMs: 160, probeSettleMs: 120,
  armSettleMs: 180, chainSettleMs: 45, chainGapMs: 70, chainAfterMs: 140, heldSettleMs: 110, dropGapMs: 200 };
export interface LiveBagFastOptions {
  directory: string;
  calibration: CalibrationProfile;
  perceptionFile: string;
  clientLog: string;
  tuning?: Partial<FastBagTuning>;
  record(entry: FastLogEntry): void;
  saveSession(session: BagSession): void;
  progress?(message: string): void;
}
const allowedProcesses = ["pathofexilesteam", "pathofexile", "pathofexile_x64", "pathofexile_x64steam"];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function fastBagTuning(overrides: Partial<FastBagTuning> = {}): FastBagTuning {
  const tuning = { ...DEFAULT_FAST_TUNING };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in tuning) || !Number.isInteger(value) || value! < 0 || value! > (key === "readTimeoutMs" ? 500 : 250) || key === "readTimeoutMs" && value! < 10)
      throw new Error("Fast bag timing is unknown or outside the bounded native range: " + key);
    tuning[key as keyof FastBagTuning] = value!;
  }
  return tuning;
}

/** Native transport for the one-action workflow. Every input still passes the
 * GameInputController trace and the native per-event interlock; what changes is
 * batching (one reply per item read, one Shift-held chain) and small region
 * captures compared against this run's own proven-empty baseline. */
export function openLiveBagFast(options: LiveBagFastOptions) {
  const perception = readBagLivePerception(options.perceptionFile, options.calibration);
  const tuning = fastBagTuning({ ...(perception as { fastTiming?: Partial<FastBagTuning> }).fastTiming, ...options.tuning });
  const grid = options.calibration.bagGrid!, client = options.calibration.client;
  const payload = { w: Math.max(96, Math.ceil(grid.w / 12 * 2 + 48)), h: Math.max(144, Math.ceil(grid.h / 5 * 4 + 48)) };
  if (!perception.cursorProbes) throw new Error("Live bag perception needs two calibrated cursor probes over static inventory artwork.");
  const probes = perception.cursorProbes;
  const regions = probes.map(p => ({ x: Math.floor(p.x - payload.w / 2), y: Math.floor(p.y - payload.h / 2), w: payload.w, h: payload.h })) as [ClientBox, ClientBox];
  const gridBox: ClientBox = { x: Math.floor(grid.x), y: Math.floor(grid.y), w: Math.ceil(grid.x + grid.w) - Math.floor(grid.x), h: Math.ceil(grid.y + grid.h) - Math.floor(grid.y) };
  const chrome = perception.inventoryChrome.box;
  const calibrationHash = hash(JSON.stringify({ calibration: options.calibration, ground: perception.ground, chrome: perception.inventoryChrome, cursorProbes: probes, fast: true }));
  const context = createBagMapContext(options.clientLog);
  mkdirSync(options.directory, { recursive: true });
  const traceFile = path.join(options.directory, "input-trace.jsonl");
  appendFileSync(traceFile, ""); // Fail writable-path setup before creating a native process.
  const host = startWinHost({ scriptName: "win-bag-host.ps1", requestTimeoutMs: 20000, bagStopFile: process.env.POE2_BAG_STOP_FILE });
  const kill = new KillSwitch();
  const must = (reply: WinReply): WinReply => { if (!reply.ok) throw new Error(String(reply.error ?? "Native bag host failed.")); return reply; };
  let hwnd = "", pinnedMap: string | undefined, lastRead: WinReply | undefined, readTiming = { hoverMs: tuning.scanHoverMs };
  let oldClipboard: string | undefined, lastCopied: string | undefined;

  const sink: InputSink = {
    async emit(action: InputAction) {
      if (action.kind === "focus") { must(await host.send({ op: "focus", expectedHwnd: hwnd })); return; }
      if (action.kind === "move") { must(await host.send({ op: "move", x: action.x, y: action.y, expectedHwnd: hwnd })); return; }
      if (action.kind === "click") { must(await host.send({ op: action.button === "right" ? "rightclick" : "click", x: action.x, y: action.y, expectedHwnd: hwnd })); return; }
      throw new Error("Unsupported fast bag input: " + action.kind);
    },
    async emitBatch(actions: InputAction[], batch: InputBatchOptions = {}) {
      const [first, second] = actions;
      if (actions.length === 2 && first!.kind === "move" && second!.kind === "key" && second!.key === "ctrlaltc" && first!.x === second!.x && first!.y === second!.y) {
        lastRead = must(await host.send({ op: "readitem", x: first!.x, y: first!.y, hoverMs: readTiming.hoverMs, timeoutMs: tuning.readTimeoutMs, expectedHwnd: hwnd })); return;
      }
      if (batch.shift && actions.length && actions.every(a => a.kind === "click" && a.button !== "right")) {
        must(await host.send({ op: "clickchain", shift: true, points: actions.map(a => ({ x: a.x, y: a.y })), settleMs: tuning.chainSettleMs, gapMs: tuning.chainGapMs, expectedHwnd: hwnd })); return;
      }
      throw new Error("Unsupported fast bag input batch.");
    },
    clear() { /* The native host has no queue. */ },
  };
  const controller = new GameInputController(sink, kill, "authorized-qa");
  const policy = scenario({ id: "bag-triage", name: "One-action inventory identification and triage", enabledModules: ["stash"], dryRun: false,
    actionsPerMinute: 2400, confidenceThreshold: .98, retryLimit: 0, timingProfile: "tight" });
  let frames = 0, lastEvidence = "start", pickedAt = 0;

  async function checkpoint(requireForeground = true): Promise<WinReply> {
    if (kill.isLatched()) throw new Error("Bag emergency stop latched.");
    let reply = must(await host.send({ op: "state" }));
    if (reply.stopped) { kill.trip(); throw new Error("Native bag emergency stop latched."); }
    while (reply.paused) {
      options.progress?.("Bag paused (Num5 resumes; Num0 or Ctrl+Shift+Esc stops).");
      await sleep(250); reply = must(await host.send({ op: "state" }));
      if (reply.stopped) { kill.trip(); throw new Error("Native bag emergency stop latched."); }
    }
    const process = String(reply.process ?? "").replace(/\.exe$/i, "").toLowerCase();
    if (!allowedProcesses.includes(process) || !reply.hwnd || hwnd && String(reply.hwnd) !== hwnd) throw new Error("Target window is missing, changed or not an allowed Path of Exile 2 client.");
    hwnd = String(reply.hwnd);
    if (requireForeground && !reply.foregroundIsPoe) throw new Error("Game focus lost; no further bag input.");
    const map = context.read();
    if (map.context !== "map" || map.loading || !map.mapInstance || map.processId !== Number(reply.pid) || pinnedMap && pinnedMap !== map.mapInstance) throw new Error("Current client log does not prove the same loaded map instance.");
    pinnedMap ??= map.mapInstance;
    return reply;
  }
  /** `at` maps client points through the SAME window rectangle the pre-input checkpoint just
   * observed, so one native state read guards and positions each input. */
  async function input(at: (state: WinReply) => InputAction[], reason: string, batch?: InputBatchOptions) {
    const probe = at({ left: 0, top: 0 }), state = await checkpoint(probe[0]!.kind !== "focus"), actions = at(state);
    // Intent reaches the trace before the native event; the action log owns mutation intent.
    appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), pending: actions, reason, evidence: lastEvidence, hwnd: state.hwnd }) + "\n");
    const decision = { module: "stash" as const, confidence: 1, rule: "fast-bag-workflow", reason, intended: actions };
    const traces = batch || actions.length > 1
      ? await controller.executeBatch(decision, policy, String(state.process), lastEvidence, true, batch)
      : await controller.execute(decision, policy, String(state.process), lastEvidence, true);
    appendFileSync(traceFile, traces.map(t => JSON.stringify(t)).join("\n") + "\n");
    if (traces.some(t => t.result !== "emitted")) throw new Error(traces.map(t => t.reason).join("; "));
    return state;
  }
  const screenPoint = (state: WinReply, p: { x: number; y: number }) => ({ x: Math.round(Number(state.left) + p.x), y: Math.round(Number(state.top) + p.y) });
  const cellPoint = (cell: BagPosition) => ({ x: grid.x + (cell.col + .5) * grid.w / 12, y: grid.y + (cell.row + .5) * grid.h / 5 });

  async function capture(rects: ClientBox[], pointer: { x: number; y: number }, cursorArt = false): Promise<{ view: BagView; reply: WinReply }> {
    const state = await checkpoint();
    const base = path.join(options.directory, `fast-${String(frames++).padStart(5, "0")}-${randomUUID().slice(0, 8)}`);
    const reply = must(await host.send({ op: "regions", path: base, rects, cursorArt, expectedHwnd: state.hwnd }));
    const files = Array.isArray(reply.files) ? reply.files as Array<Record<string, unknown>> : [];
    if (Number(reply.width) !== client.width || Number(reply.height) !== client.height) throw new Error("Client dimensions differ from inventory calibration.");
    if (files.length !== rects.length || !Number.isFinite(Date.parse(String(reply.capturedAt ?? "")))) throw new Error("Native region capture is incomplete or has no trustworthy timestamp.");
    const cursor = (reply.cursor ?? {}) as Record<string, unknown>, observed = { x: Number(cursor.clientX), y: Number(cursor.clientY) };
    if (Math.abs(observed.x - pointer.x) > 1 || Math.abs(observed.y - pointer.y) > 1) throw new Error("Cursor moved away from its requested observation position; no further bag input.");
    const parts = files.map((file, i) => {
      const image = readBmpBgr(String(file.path)), rect = rects[i]!;
      if (image.width !== rect.w || image.height !== rect.h) throw new Error("Native region capture has unexpected dimensions.");
      return { ...rect, image };
    });
    lastEvidence = base;
    writeFileSync(base + ".json", JSON.stringify({ at: reply.capturedAt, pointer: observed, cursor: { sha256: cursor.sha256, visible: cursor.visible }, files: files.map(f => ({ path: f.path, sha256: f.sha256, x: f.x, y: f.y, w: f.w, h: f.h })) }));
    return { view: { at: String(reply.capturedAt), evidence: base, pointer: observed, parts }, reply };
  }
  async function moveTo(point: { x: number; y: number }, reason: string, settleMs: number) {
    await input(state => [{ kind: "move", ...screenPoint(state, point) }], reason);
    await sleep(settleMs);
  }

  let baselineView: BagView | undefined, maskSource: BagView | undefined;
  const masks = new Map<string, BagArtMask>();
  const emptyKeys = (view: BagView) => {
    const keys: string[] = [];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) if (emptyBagCell(view, grid, { row, col })) keys.push(cellKey({ row, col }));
    return keys;
  };
  function describe(view: BagView, pointer: "probe" | "ground"): FastLook {
    if (!baselineView) throw new Error("No empty-cursor baseline for this run.");
    const others = (pointer === "probe" ? [regions[1]] : regions).map(region => bagProbeDelta(baselineView!, view, region).changed);
    const cursor = pointer === "probe" ? bagCursorLook(baselineView, view, regions[0]) : undefined;
    const footprints: FastLook["footprints"] = {};
    for (const [id, mask] of masks) footprints[id] = bagFootprintLook(view, grid, mask);
    const look: FastLook = { at: view.at, evidence: view.evidence, inventoryOpen: others.every(changed => changed <= 4), cursor: cursor?.look ?? "unobserved", footprints, emptyCells: emptyKeys(view) };
    writeFileSync(view.evidence + ".look.json", JSON.stringify({ pointer, look, probeDelta: cursor?.delta, panelDelta: others }));
    return look;
  }

  const ports: FastBagPorts = {
    now: () => new Date().toISOString(),
    checkpoint: async () => { await checkpoint(); },
    record: options.record, saveSession: options.saveSession, progress: options.progress,
    async safety(scope): Promise<FastSafety> {
      const state = await checkpoint(), map = context.read(), W = client.width, H = client.height;
      const ocr = (box: ClientBox, extra: Record<string, unknown>) => host.send({ op: "ocr", left: Number(state.left) + box.x, top: Number(state.top) + box.y, width: box.w, height: box.h, ...extra }).then(must);
      const toClient = (reply: WinReply): Array<Record<string, unknown>> => (Array.isArray(reply.lines) ? reply.lines as Array<Record<string, unknown>> : []).map(line =>
        ({ ...line, x: Number(line.x) - Number(state.left), y: Number(line.y) - Number(state.top) }));
      let text = "", lines: Array<Record<string, unknown>> = [], alive = false;
      if (scope === "full") {
        const whole = await ocr({ x: 0, y: 0, w: W, h: H }, { downscale: 2 });
        text = String(whole.text ?? ""); lines = toClient(whole);
        alive = visibleLife(text) || visibleLifeInHud(lines, client);
      }
      if (!alive) {
        // Same HUD crops the staged adapter validated against seven saved live frames.
        const label = await ocr({ x: Math.round(W * 85 / 3840), y: Math.round(H * 1580 / 2160), w: Math.round(W * 75 / 3840), h: Math.round(H * 47 / 2160) }, { scale: 2 });
        const value = await ocr({ x: Math.round(W * 70 / 3840), y: Math.round(H * 1570 / 2160), w: Math.round(W * 440 / 3840), h: Math.round(H * 60 / 2160) }, { scale: 1 });
        alive = visibleLife(String(value.text ?? "")) || visibleLifeInHud([...toClient(label),
          ...toClient(value).filter(line => /^\s*[\d,]+\s*\/\s*[\d,]+\s*$/.test(String(line.text ?? "")))], client);
      }
      const after = must(await host.send({ op: "state" }));
      const evidence = path.join(options.directory, `safety-${String(frames++).padStart(5, "0")}.json`);
      const result: FastSafety = { at: String(after.at ?? new Date().toISOString()), evidence, mapInstance: map.mapInstance, context: map.context, loading: map.loading,
        foreground: !!after.foregroundIsPoe, inventoryOpen: true, obstructed: scope === "full" ? obstructingBagUi(text, lines.map(line => String(line.text ?? ""))) : false,
        alive, calibration: calibrationHash, ground: { ...perception.ground } };
      writeFileSync(evidence, JSON.stringify({ scope, result, text, map: map.evidence }));
      return result;
    },
    async baseline(): Promise<FastLook> {
      const rects = [chrome, regions[0], regions[1], gridBox];
      await moveTo(probes[0], "Park pointer at the first static observation position", tuning.probeSettleMs);
      const a = await capture(rects, probes[0], true);
      await moveTo(probes[1], "Park pointer at the second static observation position", tuning.probeSettleMs);
      const b = await capture(rects, probes[1], true);
      const known = [a, b].every(frame => { const c = (frame.reply.cursor ?? {}) as Record<string, unknown>; return c.visible && perception.emptyCursorHashes.includes(String(c.sha256 ?? "")); });
      // A software payload follows the pointer, so it would differ in the region the pointer left.
      const moved = regions.map(region => bagProbeDelta(a.view, b.view, region).changed);
      const chromePart = b.view.parts[0]!;
      const open = matchChrome(bgrToGray(chromePart.image), { left: 0, top: 0, width: chrome.w, height: chrome.h }, { box: { x: 0, y: 0, w: chrome.w, h: chrome.h }, patch: perception.inventoryChrome.patch }) >= .9;
      const emptyA = emptyKeys(a.view), emptyB = emptyKeys(b.view), steady = emptyA.join(";") === emptyB.join(";");
      const clean = known && moved.every(changed => changed <= 4) && steady;
      baselineView = b.view; maskSource = b.view; masks.clear();
      const look: FastLook = { at: b.view.at, evidence: b.view.evidence, inventoryOpen: open, cursor: clean ? "clean" : "unknown", footprints: {}, emptyCells: emptyB };
      writeFileSync(b.view.evidence + ".look.json", JSON.stringify({ pointer: "baseline", look, known, moved, steady, first: a.view.evidence }));
      return look;
    },
    track(items) {
      if (!maskSource) throw new Error("No bag view to take item art from.");
      for (const item of items) masks.set(item.id, bagArtMask(maskSource, grid, item.cells, { excludeCount: item.excludeCount }));
    },
    async look(pointer): Promise<FastLook> {
      const point = pointer === "probe" ? probes[0] : perception.ground;
      await moveTo(point, pointer === "probe" ? "Park pointer at the static observation position" : "Carry the held item to the verified map ground point", pointer === "probe" ? tuning.probeSettleMs : tuning.heldSettleMs);
      const { view } = await capture([regions[0], regions[1], gridBox], point);
      maskSource = view;
      return describe(view, pointer);
    },
    async read(cell, mode): Promise<FastRead> {
      const started = Date.now();
      if (oldClipboard === undefined) oldClipboard = String(must(await host.send({ op: "clipboard" })).text ?? "");
      readTiming = { hoverMs: mode === "scan" ? tuning.scanHoverMs : tuning.carefulHoverMs }; lastRead = undefined;
      await input(state => { const point = screenPoint(state, cellPoint(cell)); return [{ kind: "move", ...point }, { kind: "key", key: "ctrlaltc", ...point }]; }, `Read bag item at ${cellKey(cell)}`, {});
      const reply = lastRead as WinReply | undefined, text = reply?.copied ? String(reply.text ?? "") : "";
      if (text) lastCopied = text;
      return { text, copied: !!reply?.copied, ms: Date.now() - started };
    },
    async arm(cell) {
      await input(state => [{ kind: "click", button: "right", ...screenPoint(state, cellPoint(cell)) }], "Arm the verified Scroll of Wisdom stack");
      await sleep(tuning.armSettleMs);
    },
    async chain(cells) {
      await input(state => cells.map(cell => ({ kind: "click" as const, ...screenPoint(state, cellPoint(cell)) })), `Identify ${cells.length} captured unidentified item(s) in one Shift-held Wisdom chain`, { shift: true });
      await sleep(tuning.chainAfterMs);
    },
    async pickup(cell) {
      await input(state => [{ kind: "click", ...screenPoint(state, cellPoint(cell)) }], `Pick up verified low-priority item at ${cellKey(cell)}`);
      pickedAt = Date.now();
    },
    async release() {
      const wait = tuning.dropGapMs - (Date.now() - pickedAt);
      if (wait > 0) await sleep(wait);
      await input(state => [{ kind: "click", ...screenPoint(state, perception.ground) }], "Release the verified held item onto map ground");
    },
  };
  return { ports, tuning,
    get inputCount() { return controller.actionTraces.filter(t => t.result === "emitted").length; },
    async activate() { await input(() => [{ kind: "focus" }], "Bring the user-requested bag workflow to the foreground"); },
    async close() {
      try {
        // Never overwrite a clipboard change made by the user during the run.
        if (oldClipboard !== undefined && lastCopied !== undefined && String((await host.send({ op: "clipboard" })).text ?? "") === lastCopied) {
          const state = await host.send({ op: "state" });
          if (state.ok && !state.stopped && !state.paused && state.foregroundIsPoe) await host.send({ op: "setclipboard", text: oldClipboard, expectedHwnd: state.hwnd });
        }
      } finally { await host.close(); }
    } };
}
