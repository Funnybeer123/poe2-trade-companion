import { proveBagCursorEmpty, type CursorVisionFrame } from "../core/bagCursorVision.js";
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { matchChrome, type CalibrationProfile, type GridMark } from "../core/calibrationProfile.js";
import { bagCellPixels, emptyBagPixels, sameBagPixels } from "../core/bagPixels.js";
import { GameInputController } from "../core/gameInputController.js";
import { KillSwitch } from "../core/killSwitch.js";
import { scenario } from "../core/scenarios.js";
import { readGambleCell, worldAngeLabels, gambleRingPosition, evaluateGambledRing, type GambleCell, type RingGamblePort } from "../core/ringGamble.js";
import type { InputAction } from "../core/types.js";
import { startWinHost, type WinReply } from "./winHost.js";
import { WinHostInputSink } from "./winHostInputSink.js";
import { bgrToGray, readBmpBgr } from "./bmp.js";
import { readBagLivePerception } from "./liveBag.js";
import { matchesEmptyRingSlot } from "../core/ringEmptyVision.js";

export function openRingGamble(options: { calibration: CalibrationProfile; perceptionFile: string; directory: string; root: string; journal: string }) {
  const profile = options.calibration;
  const perception = readBagLivePerception(options.perceptionFile, profile);
  const bag = profile.bagGrid!, calibratedStock = profile.ventorBagGrid;
  const emptyReferenceFile = options.perceptionFile + ".ring-empty.bmp";
  let emptyReference: ReturnType<typeof readBmpBgr> | undefined;
  if (existsSync(emptyReferenceFile)) {
    try { emptyReference = readBmpBgr(emptyReferenceFile); } catch { /* Fall back to paired clipboard reads. */ }
  }
  // Vendor stock has square cells and can be taller than the 12×5 player bag.
  // Legacy profiles label both as five rows; derive stock rows from its bounds.
  const stock = calibratedStock && { ...calibratedStock, rows: Math.round(calibratedStock.h / (calibratedStock.w / calibratedStock.cols)) };
  if (!stock || ![stock.x, stock.y, stock.w, stock.h, stock.cols, stock.rows].every(Number.isFinite) ||
    stock.x < 0 || stock.y < 0 || stock.w <= 0 || stock.h <= 0 || stock.x + stock.w > bag.x ||
    stock.y + stock.h > profile.client.height || stock.cols !== 12 || stock.rows < 1 || stock.rows > 12)
    throw new Error("Calibrate the vendor grid before gambling rings (Calibration / Vendor bag).");
  mkdirSync(options.directory, { recursive: true });
  const record = (event: Record<string, unknown>) => {
    appendFileSync(options.journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
    if (event.phase !== "input") console.log(JSON.stringify(event));
  };
  record({ phase: "setup", message: "One ring batch; strong, unknown and unidentified rolls are retained." });
  const host = startWinHost({ scriptName: "win-bag-host.ps1", bagStopFile: process.env.POE2_BAG_STOP_FILE, requestTimeoutMs: 20000 });
  const kill = new KillSwitch();
  const ordinary = new WinHostInputSink(host, {
    allowedProcesses: ["PathOfExileSteam.exe", "PathOfExile.exe", "PathOfExile_x64.exe", "PathOfExile_x64Steam.exe"], requireForeground: true,
  });
  let lastRead: WinReply | undefined;
  const controller = new GameInputController({
    emit: action => ordinary.emit(action), clear: () => ordinary.clear(),
    async emitBatch(actions) {
      const s = await state(), [move, key] = actions;
      if (actions.length === 2 && move?.kind === "move" && key?.kind === "key" && key.key === "ctrlaltc" && move.x === key.x && move.y === key.y) {
        lastRead = must(await host.send({ op: "readitem", x: move.x, y: move.y, hoverMs: 25, timeoutMs: 50, expectedHwnd: s.hwnd })); return;
      }
      if (actions.length && actions.every(a => a.kind === "click" && a.modifier === "ctrl" && a.button !== "right")) {
        const stationary = actions.every(a => a.x === actions[0]!.x && a.y === actions[0]!.y);
        const reply = must(await host.send({ op: "clickchain", ctrl: true, points: actions.map(a => ({ x: a.x, y: a.y })), settleMs: stationary ? 0 : 10, gapMs: 10, expectedHwnd: s.hwnd }));
        if (reply.count !== actions.length) throw new Error("Native click count differs from requested burst.");
        return;
      }
      throw new Error("Unsupported ring input batch.");
    },
  }, kill, "authorized-qa");
  const policy = scenario({ id: "ange-ring-gamble", name: "Ange ring gambling", enabledModules: ["stash"], dryRun: false, actionsPerMinute: 2400, confidenceThreshold: 1 });
  let evidence = "setup", frame = 0, pinned = "", ringPoint: { x: number; y: number } | undefined;
  let previous: Array<{ pixels: number[]; cell: GambleCell }> = [];
  const must = (reply: WinReply) => { if (!reply.ok) { record({ phase: "native-error", reply }); throw new Error(String(reply.error)); } return reply; };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function state() {
    let s = must(await host.send({ op: "state" }));
    while (s.paused && !s.stopped) { await sleep(100); s = must(await host.send({ op: "state" })); }
    if (s.stopped) { kill.trip(); throw new Error("Ring gambling stopped."); }
    if (!s.foregroundIsPoe || !s.nativeMonitorReady) throw new Error("Return to Path of Exile; game focus is required.");
    if (Number(s.width) !== profile.client.width || Number(s.height) !== profile.client.height) throw new Error("Game resolution differs from calibration.");
    if (pinned && pinned !== String(s.hwnd)) throw new Error("Game window changed.");
    pinned = String(s.hwnd); return s;
  }
  async function input(action: InputAction | InputAction[], reason: string) {
    const s = await state(); record({ phase: "input-pending", action, reason, evidence });
    const decision = { module: "stash" as const, rule: "ring-gamble", confidence: 1, reason, intended: Array.isArray(action) ? action : [action] };
    const traces = Array.isArray(action) ? await controller.executeBatch(decision, policy, String(s.process), evidence, true)
      : await controller.execute(decision, policy, String(s.process), evidence, true);
    record({ phase: "input", traces });
    if (traces.some(t => t.result !== "emitted")) throw new Error(traces.map(t => t.reason).join("; "));
  }
  async function point(grid: GridMark, slot: number) {
    const s = await state(); return { x: Math.round(Number(s.left) + grid.x + (slot % grid.cols + .5) * grid.w / grid.cols),
      y: Math.round(Number(s.top) + grid.y + (Math.floor(slot / grid.cols) + .5) * grid.h / grid.rows) };
  }
  async function park(offset = 0) {
    const s = await state();
    await input({ kind: "move", x: Number(s.left) + perception.ground.x - offset, y: Number(s.top) + perception.ground.y }, "Clear inventory tooltips");
    await sleep(60);
    let cursor = must(await host.send({ op: "cursor" })).cursor as { sha256?: string };
    if (!perception.emptyCursorHashes.includes(String(cursor?.sha256))) {
      await sleep(120);
      cursor = must(await host.send({ op: "cursor", path: path.join(options.directory, "cursor-settle.png") })).cursor as { sha256?: string };
      record({ phase: "cursor-settle", sha256: cursor?.sha256 });
    }
    if (!cursor || !perception.emptyCursorHashes.includes(String(cursor.sha256))) throw new Error("Cursor is not the calibrated empty cursor.");
  }
  async function copy(p: { x: number; y: number }) {
    lastRead = undefined;
    await input([{ kind: "move", ...p }, { kind: "key", key: "ctrlaltc", ...p }], "Read ring modifiers with native clipboard sequence verification");
    const reply = lastRead as WinReply | undefined;
    return reply?.copied ? String(reply.text ?? "").replace(/\r/g, "").trim() : "";
  }
  type Line = { text: string; x: number; y: number; w: number; h: number };
  async function lines(vendorOnly = false) {
    const s = await state();
    const reply = must(await host.send({ op: "ocr", ...(vendorOnly ? {
      left: Number(s.left) + stock!.x, top: Number(s.top) + Math.max(0, stock!.y - 180), width: stock!.w, height: 220,
    } : {}) }));
    evidence = "ocr-" + new Date().toISOString();
    record({ phase: "perception", evidence, lines: reply.lines });
    if (!Array.isArray(reply.lines)) throw new Error("Vendor text could not be read.");
    return reply.lines as Line[];
  }
  async function clickLabel(pattern: RegExp, modifier?: "alt") {
    const bounds = await state();
    const visible = await lines();
    const found = modifier === "alt" ? worldAngeLabels(visible, Number(bounds.left), profile.client.width)
      : visible.filter(l => pattern.test(l.text.trim()));
    if (found.length !== 1) throw new Error("Expected one visible " + pattern.source + "; move closer to Ange and retry.");
    const l = found[0]!;
    await input({ kind: "click", x: Math.round(l.x + l.w / 2), y: Math.round(l.y + l.h / 2), modifier }, "Select " + l.text);
  }
  async function vendor() {
    await park();
    const visible = await lines(true);
    if (!visible.some(l => /^(?:gamble|gambling)$/i.test(l.text.trim())) || !visible.some(l => /^jewel(?:le)?ry$/i.test(l.text.trim())))
      throw new Error("Ange's gamble window and Jewelry tab are not confirmed.");
  }
  async function snapshot(attempt = 0): Promise<GambleCell[]> {
    const started = Date.now();
    await vendor();
    const file = path.join(options.directory, `frame-${frame++}.bmp`);
    const capture = must(await host.send({ op: "capture", path: file })); evidence = String(capture.sha256);
    await park(320);
    const secondFile = path.join(options.directory, `frame-${frame++}.bmp`);
    const second = must(await host.send({ op: "capture", path: secondFile }));
    const vision = (reply: WinReply, source: string): CursorVisionFrame => {
      const cursor = reply.cursor as { clientX: number; clientY: number; sha256: string };
      return { image: readBmpBgr(source), pointer: { x: cursor.clientX, y: cursor.clientY },
        cursorHash: cursor.sha256, at: String(reply.capturedAt), evidence: source };
    };
    const proof = proveBagCursorEmpty({ frames: [vision(capture, file), vision(second, secondFile)],
      knownEmptyCursorHashes: perception.emptyCursorHashes, payloadSize: { width: 256, height: 256 }, now: new Date().toISOString() });
    record({ phase: "cursor-proof", proof });
    if (proof.state !== "empty") throw new Error("Cursor may be holding an item; stop and clear it before continuing.");
    const image = readBmpBgr(secondFile), firstImage = readBmpBgr(file), next: typeof previous = [];
    let visualEmpty = 0;
    if (matchChrome(bgrToGray(image), { left: 0, top: 0, width: image.width, height: image.height }, perception.inventoryChrome) < .9) throw new Error("Inventory panel is not confirmed.");
    for (let slot = 0; slot < 60; slot++) {
      const pixels = bagCellPixels(image, bag, { row: Math.floor(slot / 12), col: slot % 12 });
      const cached = previous[slot];
      if (cached && sameBagPixels(cached.pixels, pixels)) { next.push({ pixels, cell: cached.cell }); continue; }
      if (emptyReference && matchesEmptyRingSlot(firstImage, emptyReference, bag, slot) && matchesEmptyRingSlot(image, emptyReference, bag, slot)) {
        next.push({ pixels, cell: { slot, state: "empty", text: "" } }); visualEmpty++; continue;
      }
      const p = await point(bag, slot);
      const cell = await readGambleCell(slot, emptyBagPixels(pixels), () => copy(p));
      next.push({ pixels, cell });
    }
    await park();
    // Reject concurrent inventory changes while the copy sweep was running.
    const endFile = path.join(options.directory, `frame-${frame++}.bmp`);
    must(await host.send({ op: "capture", path: endFile }));
    const end = readBmpBgr(endFile);
    const changed = next.flatMap((entry, slot) => sameBagPixels(entry.pixels, bagCellPixels(end, bag, { row: Math.floor(slot / 12), col: slot % 12 })) ? [] : [slot]);
    if (changed.length) {
      record({ phase: "inventory-settle", attempt, slots: changed });
      if (attempt >= 2) throw new Error("Inventory changed during inspection.");
      // A newly purchased item's highlight can fade after its first hover.
      // Cache only cells stable across this sweep. Changed cells must be copied
      // again; no unstable cell is returned and no mutation is repeated.
      previous = next.map((entry, slot) => changed.includes(slot) ? { pixels: [], cell: { slot, state: "unread", text: "" } } : entry);
      await sleep(100);
      return snapshot(attempt + 1);
    }
    previous = next;
    if (!emptyReference && next.every(entry => entry.cell.state === "empty")) {
      copyFileSync(endFile, emptyReferenceFile); emptyReference = end;
      record({ phase: "empty-reference-learned", file: emptyReferenceFile });
    }
    record({ phase: "inventory-verified", elapsedMs: Date.now() - started, visualEmpty, items: next.filter(e => e.cell.state === "item").length, unread: next.filter(e => e.cell.state === "unread").map(e => e.cell.slot) });
    return next.map(entry => ({ ...entry.cell }));
  }
  const port: RingGamblePort = {
    record, evaluate: text => evaluateGambledRing(text), snapshot,
    async open() {
      await park();
      if (!(await lines()).some(l => /^(?:gamble|gambling)$/i.test(l.text.trim()))) await clickLabel(/^ange$/i, "alt");
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(500); await park();
        if ((await lines()).some(l => /^(?:gamble|gambling)$/i.test(l.text.trim()))) break;
        if (attempt === 11) throw new Error("Ange's gamble window did not open.");
      }
      await clickLabel(/^jewel(?:le)?ry$/i); await sleep(400); await vendor();
      const target = gambleRingPosition(stock), current = await state();
      ringPoint = { x: Math.round(Number(current.left) + target.x), y: Math.round(Number(current.top) + target.y) };
      record({ phase: "ring-slot", column: 0, row: 1, point: ringPoint });
      await park();
    },
    async buy() { await port.buyMany!(1); },
    async buyMany(count) {
      await vendor();
      if (!ringPoint) throw new Error("No verified vendor ring.");
      await input({ kind: "move", ...ringPoint }, "Inspect fixed Jewellery ring slot");
      await sleep(200);
      if (!(await lines()).some(line => /^random ring$/i.test(line.text.trim())))
        throw new Error("The fixed Jewellery slot does not show Random Ring; check the vendor calibration.");
      const started = Date.now();
      await input(Array.from({ length: count }, (): InputAction => ({ kind: "click", ...ringPoint!, modifier: "ctrl" })), "Buy bounded ring burst into verified free capacity");
      await sleep(100);
      record({ phase: "purchase-burst", count, elapsedMs: Date.now() - started, settleMs: 0, gapMs: 10 });
    },
    async sell(cell) {
      await vendor(); const p = await point(bag, cell.slot);
      const observed = await readGambleCell(cell.slot, false, () => copy(p));
      if (observed.state !== "item" || observed.text !== cell.text) throw new Error("Ring identity changed before sale.");
      await input({ kind: "click", ...p, modifier: "ctrl" }, "Sell verified weak ring from this batch"); await sleep(100);
    },
    async sellMany(cells, expected) {
      if (!cells.length || cells.length > 60 || new Set(cells.map(c => c.slot)).size !== cells.length)
        throw new Error("Invalid ring sale batch.");
      const started = Date.now(), actions: InputAction[] = [];
      await vendor();
      for (const cell of cells) {
        const p = await point(bag, cell.slot);
        const observed = previous[cell.slot]?.cell;
        if (observed?.state !== "item" || observed.text !== cell.text || evaluateGambledRing(observed.text).action !== "vendor")
          throw new Error("Ring identity or verdict changed before sale.");
        actions.push({ kind: "click", ...p, modifier: "ctrl" });
      }
      // Reuse the completed modifier scan; a quick visual guard checks the
      // inventory has not changed, without another clipboard sweep.
      const ready = previous.map(entry => entry.cell);
      if (ready.length !== 60 || ready.some(cell => {
        const old = expected.find(c => c.slot === cell.slot);
        return !old || old.state !== cell.state || old.text !== cell.text;
      })) throw new Error("Inventory changed before sale burst.");
      const guardFile = path.join(options.directory, `sale-guard-${frame++}.bmp`);
      must(await host.send({ op: "capture", path: guardFile }));
      const guardImage = readBmpBgr(guardFile);
      if (previous.some((entry, slot) => !sameBagPixels(entry.pixels, bagCellPixels(guardImage, bag, { row: Math.floor(slot / 12), col: slot % 12 }))))
        throw new Error("Inventory pixels changed before sale burst.");
      await input(actions, "Sell bounded burst of freshly verified rejects");
      await sleep(100);
      record({ phase: "sale-burst", count: cells.length, elapsedMs: Date.now() - started });
    },
  };
  return { port, close: () => host.close() };
}
