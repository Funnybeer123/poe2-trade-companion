import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bagCellPixels, emptyBagPixels, sameBagPixels, visibleLife, visibleLifeInHud, obstructingBagUi } from "../core/bagPixels.js";
import { proveBagCursorEmpty, proveBagCursorPayload, type BagCursorSource, type CursorVisionFrame } from "../core/bagCursorVision.js";
import { cellKey, exactText, type BagCellObservation, type BagPosition } from "../core/bagAssessment.js";
import type { BagAction, BagObservationRequest, BagScene, BagSession } from "../core/bagSession.js";
import { type CalibrationProfile, type ChromeMark, type ClientBox, matchChrome } from "../core/calibrationProfile.js";
import { GameInputController } from "../core/gameInputController.js";
import { KillSwitch } from "../core/killSwitch.js";
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import { scenario } from "../core/scenarios.js";
import type { InputAction } from "../core/types.js";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import { WinHostInputSink } from "./winHostInputSink.js";
import { startWinHost, type WinReply } from "./winHost.js";
import { createBagMapContext, validateBagCalibration } from "./bagMapContext.js";

export interface BagLivePerception {
  version: 1;
  client: { width: number; height: number };
  /** Explicitly verified cursor art; unknown art never inherits the intended action. */
  emptyCursorHashes: string[];
  /** Legacy calibration fields are accepted but never used as payload identity. */
  wisdomCursorHashes?: string[];
  heldCursorHashes?: Record<string, string[]>;
  inventoryChrome: ChromeMark;
  ground: { x: number; y: number };
  /** Observation-only positions may use static UI space above the bag grid. */
  cursorProbes?: [{ x: number; y: number }, { x: number; y: number }];
  evidence: string;
}
export interface LiveBagOptions {
  directory: string;
  calibration: CalibrationProfile;
  perceptionFile: string;
  clientLog: string;
  previous?: BagSession;
  save(session: BagSession): void;
  progress?(message: string): void;
}
type Frame = { file: string; hash: string; at: string; image: ReturnType<typeof readBmpBgr>; reply: WinReply; cursor: Record<string, unknown>; proof?: BagScene["cursor"] };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const allowedProcesses = ["PathOfExileSteam.exe", "PathOfExile.exe", "PathOfExile_x64.exe", "PathOfExile_x64Steam.exe"];
function cursorProbeLayout(perception: BagLivePerception, calibration: CalibrationProfile) {
  const grid = calibration.bagGrid!;
  const payloadSize = { width: Math.max(96, Math.ceil(grid.w / 12 * 2 + 48)), height: Math.max(144, Math.ceil(grid.h / 5 * 4 + 48)) };
  const probeB = { x: perception.ground.x - payloadSize.width - 32, y: perception.ground.y };
  if (probeB.x < payloadSize.width / 2) probeB.x = perception.ground.x + payloadSize.width + 32;
  const probes = perception.cursorProbes === undefined ? [perception.ground, probeB] : perception.cursorProbes;
  if (!Array.isArray(probes) || probes.length !== 2 || probes.some(point => !point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)))
    throw new Error("Live bag cursor probes require exactly two finite integer positions.");
  const regions = probes.map(point => ({ x: Math.floor(point.x - payloadSize.width / 2), y: Math.floor(point.y - payloadSize.height / 2),
    w: payloadSize.width, h: payloadSize.height }));
  const overlaps = (a: ClientBox, b: ClientBox) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const region of regions) {
    if (region.x < 0 || region.x + region.w > calibration.client.width || region.y < 0 || region.y + region.h > calibration.client.height ||
      overlaps(region, grid) || overlaps(region, perception.inventoryChrome.box))
      throw new Error("Live bag cursor probe regions must fit in the client without overlapping the bag grid or inventory chrome.");
  }
  if (overlaps(regions[0]!, regions[1]!)) throw new Error("Live bag cursor probe regions must not overlap each other.");
  return { payloadSize, probes: structuredClone(probes) as NonNullable<BagLivePerception["cursorProbes"]> };
}

export function readBagLivePerception(file: string, calibration: CalibrationProfile): BagLivePerception {
  const p = JSON.parse(readFileSync(file, "utf8")) as BagLivePerception;
  validateBagCalibration(calibration, { x: 0, y: 0, w: calibration.client?.width, h: calibration.client?.height });
  const g = calibration.bagGrid;
  const box = p.inventoryChrome?.box, patch = p.inventoryChrome?.patch;
  const hashes = [...(p.emptyCursorHashes ?? []), ...(p.wisdomCursorHashes ?? []), ...Object.values(p.heldCursorHashes ?? {}).flat()];
  if (p.version !== 1 || !p.evidence || !p.emptyCursorHashes?.length || hashes.some(h => !/^[a-f0-9]{64}$/.test(h)) ||
    new Set(hashes).size !== hashes.length || !box || !patch || ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
    box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 || box.x + box.w > calibration.client.width || box.y + box.h > calibration.client.height ||
    !Number.isSafeInteger(patch.width) || !Number.isSafeInteger(patch.height) || patch.width <= 0 || patch.height <= 0 ||
    !Array.isArray(patch.pixels) || patch.pixels.length !== patch.width * patch.height || patch.pixels.some(pixel => !Number.isInteger(pixel) || pixel < 0 || pixel > 255) ||
    !g || g.cols !== 12 || g.rows !== 5 || p.client?.width !== calibration.client.width || p.client.height !== calibration.client.height ||
    !Number.isFinite(p.ground?.x) || !Number.isFinite(p.ground?.y) || p.ground.x < calibration.client.width * .15 ||
    p.ground.x >= Math.min(g.x - 100, calibration.client.width * .60) || p.ground.y < calibration.client.height * .2 || p.ground.y > calibration.client.height * .7)
    throw new Error("Live bag perception calibration is missing, invalid, or outside the verified world region.");
  cursorProbeLayout(p, calibration);
  return p;
}

/** Starts only after CLI files/arguments and perception calibration have validated. */
export function openLiveBag(options: LiveBagOptions) {
  const perception = readBagLivePerception(options.perceptionFile, options.calibration);
  const { payloadSize, probes } = cursorProbeLayout(perception, options.calibration);
  const calibrationHash = hash(JSON.stringify({ calibration: options.calibration, ground: perception.ground, chrome: perception.inventoryChrome, cursorProbes: probes }));
  const context = createBagMapContext(options.clientLog);
  mkdirSync(options.directory, { recursive: true });
  const traceFile = path.join(options.directory, "input-trace.jsonl");
  // Fail writable-path setup before creating a native process.
  appendFileSync(traceFile, "");
  const host = startWinHost({ scriptName: "win-bag-host.ps1", requestTimeoutMs: 20000, bagStopFile: process.env.POE2_BAG_STOP_FILE });
  const kill = new KillSwitch();
  const sink = new WinHostInputSink(host, { allowedProcesses, requireForeground: true });
  const controller = new GameInputController(sink, kill, "authorized-qa");
  const policy = scenario({ id: "bag-triage", name: "Staged inventory identification and triage", enabledModules: ["stash"], dryRun: false, actionsPerMinute: 900, confidenceThreshold: .98, retryLimit: 0, timingProfile: "tight" });
  const framePrefix = "frame-" + randomUUID() + "-";
  let sequence = 0, current = options.previous, lastFrame: Frame | undefined;
  let baseline: Frame | undefined, cells: BagCellObservation[] = [];
  let pendingAction: BagAction | undefined;
  let pinnedMap = options.previous?.scene.mapInstance;
  let oldClipboard: string | undefined, lastCopied: string | undefined;
  let groundLabels: string[] = [];
  let groundBaselineProven = false;
  const grid = options.calibration.bagGrid!;
  const normalizeLabel = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  function worldLabels(ocr: WinReply): string[] {
    return (Array.isArray(ocr.lines) ? ocr.lines : []).filter((line: Record<string, unknown>) =>
      Number(line.x) >= 0 && Number(line.x) + Number(line.w) < grid.x - 80 &&
      Number(line.y) > options.calibration.client.height * .15 && Number(line.y) < options.calibration.client.height * .75)
      .map((line: Record<string, unknown>) => normalizeLabel(String(line.text ?? ""))).filter(Boolean);
  }
  function restoreGroundBaseline(action: BagAction) {
    groundBaselineProven = false;
    const receipt = current?.receipts.at(-1);
    if (receipt?.action.id !== action.id || receipt.action.kind !== "drop" || receipt.state !== "pending") return;
    try {
      const recorded = JSON.parse(readFileSync(receipt.before.evidence + ".scene.json", "utf8")) as { scene: BagScene; ocr: WinReply };
      if (recorded.scene.evidence !== receipt.before.evidence || recorded.scene.at !== receipt.before.at ||
        recorded.scene.mapInstance !== receipt.before.mapInstance || !recorded.ocr.ok || !Array.isArray(recorded.ocr.lines)) return;
      groundLabels = worldLabels(recorded.ocr); groundBaselineProven = true;
    } catch { /* Missing original ground evidence cannot authorize a resumed drop receipt. */ }
  }
  const log = (message: string) => options.progress?.(message);
  const must = (reply: WinReply): WinReply => { if (!reply.ok) throw new Error(String(reply.error ?? "Native bag host failed.")); return reply; };

  async function checkpoint(requireForeground = true) {
    if (kill.isLatched()) throw new Error("Bag emergency stop latched.");
    let reply = must(await host.send({ op: "state" }));
    if (reply.stopped) { kill.trip(); throw new Error("Native bag emergency stop latched."); }
    while (reply.paused) {
      log("Bag paused (Num5 resumes; Num0 or Ctrl+Shift+Esc stops).");
      await new Promise(resolve => setTimeout(resolve, 250)); reply = must(await host.send({ op: "state" }));
      if (reply.stopped) { kill.trip(); throw new Error("Native bag emergency stop latched."); }
    }
    if (requireForeground && !reply.foregroundIsPoe) throw new Error("Game focus lost; no further bag input.");
    const map = context.read();
    if (map.context !== "map" || map.loading || !map.mapInstance || map.processId !== Number(reply.pid) || pinnedMap && pinnedMap !== map.mapInstance) throw new Error("Current client log does not prove the same loaded map instance.");
    pinnedMap ??= map.mapInstance;
    return reply;
  }
  async function input(action: InputAction, reason: string) {
    const state = await checkpoint(action.kind !== "focus");
    // Append intent synchronously before input; mutation journal flush is owned by runBagStage.
    appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), pending: action, reason, evidence: lastFrame?.hash, hwnd: state.hwnd }) + "\n");
    const traces = await controller.execute({ module: "stash", confidence: 1, rule: "verified-bag-stage", reason, intended: [action] }, policy, String(state.process), lastFrame?.hash ?? "map:" + pinnedMap, true);
    appendFileSync(traceFile, traces.map(t => JSON.stringify(t)).join("\n") + "\n");
    if (traces.some(t => t.result !== "emitted")) throw new Error(traces.map(t => t.reason).join("; "));
  }
  async function capture(): Promise<Frame> {
    const state = await checkpoint();
    const file = path.join(options.directory, `${framePrefix}${String(sequence++).padStart(5, "0")}.bmp`);
    const reply = must(await host.send({ op: "capture", path: file, expectedHwnd: state.hwnd, requireForeground: true }));
    const image = readBmpBgr(file);
    if (image.width !== options.calibration.client.width || image.height !== options.calibration.client.height) throw new Error("Client dimensions differ from inventory calibration.");
    const capturedAt = String(reply.capturedAt ?? "");
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Native capture has no trustworthy frame timestamp.");
    const frame = { file, image, hash: hash(readFileSync(file)), at: capturedAt, reply, cursor: (reply.cursor ?? {}) as Record<string, unknown> };
    writeFileSync(file + ".json", JSON.stringify({ ...reply, at: frame.at, sha256: frame.hash }, null, 2));
    lastFrame = frame; return frame;
  }
  function visionFrame(frame: Frame): CursorVisionFrame {
    const c = frame.cursor, width = Number(c.width), height = Number(c.height);
    const result: CursorVisionFrame = { image: frame.image, pointer: { x: Number(c.clientX), y: Number(c.clientY) }, at: frame.at,
      evidence: frame.file, cursorHash: c.visible ? String(c.sha256 ?? "") : undefined };
    if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 512 && height <= 512 && typeof c.rgbaBase64 === "string") {
      const rgba = Buffer.from(c.rgbaBase64, "base64");
      if (rgba.length === width * height * 4) {
        const data = Buffer.alloc(width * height * 3), alpha = new Uint8Array(width * height);
        for (let i = 0; i < alpha.length; i++) { data[i * 3] = rgba[i * 4 + 2]!; data[i * 3 + 1] = rgba[i * 4 + 1]!; data[i * 3 + 2] = rgba[i * 4]!; alpha[i] = rgba[i * 4 + 3]!; }
        result.cursorSprite = { image: { width, height, data }, alpha, hotspot: { x: Number(c.hotspotX), y: Number(c.hotspotY) }, evidence: frame.file + ".json" };
      }
    }
    return result;
  }
  function cursorSource(): BagCursorSource | undefined {
    if (!pendingAction || !current) return;
    const kind = pendingAction.kind === "arm" || pendingAction.kind === "identify" ? "arm" : "pickup";
    const receipt = [...current.receipts].reverse().find(r => r.action.itemId === pendingAction!.itemId && r.action.kind === kind);
    if (!receipt) return;
    const row = current.report.rows.find(r => r.id === pendingAction!.itemId);
    const sourceCells = kind === "arm" ? [{ row: 0, col: 0 }] : row?.cells;
    if (!sourceCells?.length || !existsSync(receipt.before.evidence)) return;
    const source = receipt.before.cells.find(c => cellKey(c) === cellKey(sourceCells[0]!));
    if (source?.state !== "item" || !source.rawText || !source.confirmation) return;
    return { image: readBmpBgr(receipt.before.evidence), grid, cells: sourceCells, rawText: source.rawText,
      confirmation: source.confirmation, evidence: receipt.before.evidence + ":paired-source" };
  }
  async function park(point = probes[0]) {
    const state = await checkpoint();
    await input({ kind: "move", x: Number(state.left) + point.x, y: Number(state.top) + point.y }, "Park pointer at verified observation position for unobstructed bag evidence");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  async function capturePair(): Promise<Frame> {
    await park(); const a = await capture();
    await park(probes[1]); const b = await capture();
    const frames = [visionFrame(a), visionFrame(b)] as const, now = new Date().toISOString();
    for (const [index, point] of probes.entries()) {
      const observed = frames[index]!.pointer;
      if (!Number.isFinite(observed.x) || !Number.isFinite(observed.y) || Math.abs(observed.x - point.x) > 1 || Math.abs(observed.y - point.y) > 1)
        throw new Error("Cursor moved outside its requested probe position; no further bag input.");
    }
    const source = cursorSource();
    let proof = source ? proveBagCursorPayload({ source, frames, now }) : undefined;
    if (!proof || proof.state === "unknown") proof = proveBagCursorEmpty({ frames, knownEmptyCursorHashes: perception.emptyCursorHashes, payloadSize, now });
    const evidence = b.file + ".cursor-proof.json";
    writeFileSync(evidence, JSON.stringify(proof, null, 2));
    b.proof = { state: proof.state, rawText: proof.rawText, evidence };
    if (proof.state === "unknown") throw new Error("Cursor payload could not be verified at both probe positions; evidence: " + evidence);
    for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) {
      if (!sameBagPixels(bagCellPixels(a.image, grid, { row, col }), bagCellPixels(b.image, grid, { row, col }))) throw new Error("Bag changed between cursor probe frames.");
    }
    return b;
  }
  async function copyAt(cell: BagPosition): Promise<string> {
    const state = await checkpoint();
    const sentinel = "bag-copy:" + randomUUID();
    if (oldClipboard === undefined) oldClipboard = String(must(await host.send({ op: "clipboard" })).text ?? "");
    must(await host.send({ op: "setclipboard", text: sentinel, expectedHwnd: state.hwnd })); lastCopied = sentinel;
    const x = Math.round(Number(state.left) + grid.x + (cell.col + .5) * grid.w / 12), y = Math.round(Number(state.top) + grid.y + (cell.row + .5) * grid.h / 5);
    await input({ kind: "move", x, y }, `Read bag cell ${cellKey(cell)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    await input({ kind: "key", key: "ctrlaltc", x, y }, `Copy advanced item text from bag cell ${cellKey(cell)}`);
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 40));
      const text = String(must(await host.send({ op: "clipboard" })).text ?? "");
      if (text !== sentinel && looksLikePoeItemText(text)) { lastCopied = text; return text; }
    }
    return "";
  }
  async function readPair(cell: BagPosition, frame: Frame): Promise<BagCellObservation> {
    const rawText = await copyAt(cell), confirmation = await copyAt(cell);
    const evidence = frame.file + ":cell:" + cellKey(cell);
    if (rawText && exactText(rawText) === exactText(confirmation)) return { ...cell, state: "item", rawText, confirmation, evidence };
    if (!rawText && !confirmation && emptyBagPixels(bagCellPixels(frame.image, grid, cell))) return { ...cell, state: "empty", evidence };
    return { ...cell, state: "unread", rawText, confirmation, evidence };
  }
  async function scene(frame: Frame): Promise<BagScene> {
    await checkpoint();
    const ocr = must(await host.send({ op: "ocr", path: frame.file }));
    const text = String(ocr.text ?? "");
    // World textures can distort whole-frame OCR layout. Read the exact HUD
    // label and value separately from the same saved frame when needed.
    const hudLife = visibleLife(text) || visibleLifeInHud(ocr.lines, frame.image);
    const lifeOcr = hudLife ? undefined : must(await host.send({ op: "ocr", path: frame.file,
      left: Math.round(frame.image.width * 85 / 3840), top: Math.round(frame.image.height * 1580 / 2160),
      width: Math.round(frame.image.width * 75 / 3840), height: Math.round(frame.image.height * 47 / 2160), scale: 2 }));
    const lifeValueOcr = hudLife ? undefined : must(await host.send({ op: "ocr", path: frame.file,
      left: Math.round(frame.image.width * 70 / 3840), top: Math.round(frame.image.height * 1570 / 2160),
      width: Math.round(frame.image.width * 440 / 3840), height: Math.round(frame.image.height * 60 / 2160), scale: 1 }));
    const alive = hudLife || visibleLife(String(lifeValueOcr?.text ?? "")) || visibleLifeInHud([
      ...(Array.isArray(lifeOcr?.lines) ? lifeOcr.lines : []),
      ...(Array.isArray(lifeValueOcr?.lines) ? lifeValueOcr.lines.filter((line: Record<string, unknown>) => /^\s*[\d,]+\s*\/\s*[\d,]+\s*$/.test(String(line.text ?? ""))) : []),
    ], frame.image);
    // OCR and cursor are bound to this exact frame; never re-stamp stale HUD evidence.
    const fresh = frame;
    const map = context.read(), client = { left: 0, top: 0, width: fresh.image.width, height: fresh.image.height };
    // The calibrated patch contains the inventory title itself; whole-world OCR
    // is not a second reliable title detector over animated map backgrounds.
    const inventoryOpen = matchChrome(bgrToGray(fresh.image), client, perception.inventoryChrome) >= .9;
    const blocked = obstructingBagUi(text, (Array.isArray(ocr.lines) ? ocr.lines : []).map((line: Record<string, unknown>) => String(line.text ?? "")));
    const result: BagScene = { at: fresh.at, evidence: fresh.file, mapInstance: map.mapInstance, context: map.context, foreground: true,
      inventoryOpen, obstructed: blocked, alive, loading: map.loading, calibration: calibrationHash,
      ground: { ...perception.ground, valid: inventoryOpen && !blocked && alive, evidence: fresh.file + ":world-region+" + map.evidence },
      cursor: fresh.proof ?? { state: "unknown", evidence: fresh.file }, cells: structuredClone(cells) };
    if (pendingAction?.kind === "drop" && result.cursor.state === "empty" && groundBaselineProven) {
      const row = current?.report.rows.find(r => r.id === pendingAction?.itemId);
      const labels = worldLabels(ocr);
      const names = row ? [parseItemText(row.rawText).name, parseItemText(row.rawText).baseType].map(normalizeLabel).filter(Boolean) : [];
      if (row && names.some(name => labels.filter(l => l === name).length > groundLabels.filter(l => l === name).length)) {
        result.groundReceipt = { actionId: pendingAction.id, rawText: row.rawText, evidence: fresh.file + ":new-world-label:" + hash(JSON.stringify(labels)) };
      }
    }
    if (!pendingAction || pendingAction.kind === "arm" || pendingAction.kind === "identify") {
      groundLabels = worldLabels(ocr); groundBaselineProven = Array.isArray(ocr.lines);
    }
    writeFileSync(fresh.file + ".scene.json", JSON.stringify({ scene: result, ocr, lifeOcr, lifeValueOcr }, null, 2));
    if (!inventoryOpen || blocked || !result.alive) throw new Error("Inventory/map HUD or unobstructed live scene could not be verified; evidence: " + fresh.file);
    return result;
  }
  async function observe(request?: BagObservationRequest): Promise<BagScene> {
    await checkpoint();
    if (request?.phase === "before" && !request.action) pendingAction = undefined;
    if (request?.action) pendingAction = request.action;
    if (request?.phase === "reconcile" && request.action?.kind === "drop") restoreGroundBaseline(request.action);
    const initial = await capturePair(), cursor = initial.proof!;
    await scene(initial); // Establish inventory/HUD before clipboard key input.
    const afterHeld = cursor.state === "wisdom" || cursor.state === "item";
    if (!cells.length) {
      if (afterHeld) {
        // Restart can use only durable exact cells plus an independently matching saved frame.
        if (!current || !existsSync(current.scene.evidence)) throw new Error("Held-cursor restart has no physical baseline.");
        baseline = { ...initial, image: readBmpBgr(current.scene.evidence), file: current.scene.evidence };
        cells = structuredClone(current.scene.cells);
      } else {
        for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) {
          cells.push(await readPair({ row, col }, initial));
          if (col === 11) log(`Captured inventory row ${row + 1}/5 (${cells.length}/60 cells).`);
        }
        const after = await capturePair();
        if (cells.some(c => !sameBagPixels(bagCellPixels(initial.image, grid, c), bagCellPixels(after.image, grid, c)))) throw new Error("Bag changed during initial full scan; no mutation permitted.");
        baseline = after;
        return scene(after);
      }
    }
    const target = new Set((request?.cells ?? []).map(cellKey));
    if (pendingAction?.kind === "identify") target.add("0,0");
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      const unchanged = baseline && sameBagPixels(bagCellPixels(baseline.image, grid, cell), bagCellPixels(initial.image, grid, cell));
      if (afterHeld) {
        if (!unchanged) {
          if (cursor.state !== "item" || !target.has(cellKey(cell)) || !emptyBagPixels(bagCellPixels(initial.image, grid, cell))) throw new Error("Unexpected bag change with an armed/held cursor.");
          cells[i] = { row: cell.row, col: cell.col, state: "empty", evidence: initial.file + ":verified-source-departure" };
        }
      } else if (target.has(cellKey(cell))) cells[i] = await readPair(cell, initial);
      else if (!unchanged) throw new Error("Unrelated cell changed; refusing to reuse cached text: " + cellKey(cell));
      else cell.evidence = initial.file + ":pixel-match:" + cell.evidence;
    }
    const final = afterHeld ? initial : await capturePair();
    if (cells.some(c => !sameBagPixels(bagCellPixels(initial.image, grid, c), bagCellPixels(final.image, grid, c)))) throw new Error("Bag changed during target verification; cached identity invalid.");
    const result = await scene(final); baseline = final; return result;
  }
  async function mutate(action: BagAction) {
    const state = await checkpoint(); pendingAction = action;
    if (action.kind === "drop") await input({ kind: "click", x: Number(state.left) + action.ground.x, y: Number(state.top) + action.ground.y }, `Release verified held item ${action.itemId} onto map ground`);
    else await input({ kind: "click", button: action.kind === "arm" ? "right" : "left", x: Number(state.left) + grid.x + (action.cell.col + .5) * grid.w / 12, y: Number(state.top) + grid.y + (action.cell.row + .5) * grid.h / 5 }, `${action.kind} exact bag item ${action.itemId}`);
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  return { get inputCount() { return controller.actionTraces.filter(t => t.result === "emitted").length; },
    activate: () => input({ kind: "focus" }, "Bring the user-requested staged bag test to the foreground"),
    ports: { observe, mutate, checkpoint: async () => { await checkpoint(); }, now: () => new Date().toISOString(), save: (s: BagSession) => { options.save(s); current = structuredClone(s); } },
    async close() {
      try {
        // Never overwrite a clipboard change made by the user during the run.
        if (oldClipboard !== undefined && String((await host.send({ op: "clipboard" })).text ?? "") === lastCopied) {
          const state = await host.send({ op: "state" });
          if (state.ok && !state.stopped && !state.paused && state.foregroundIsPoe) await host.send({ op: "setclipboard", text: oldClipboard, expectedHwnd: state.hwnd });
        }
      } finally { await host.close(); }
    } };
}
