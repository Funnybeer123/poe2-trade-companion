import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BagPosition } from "../src/core/bagAssessment.js";
import { FastBagStop, runFastBag, type FastLogEntry } from "../src/core/bagFastRun.js";
import { validateBagSession, type BagSession } from "../src/core/bagSession.js";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";
import { CLASS_SIZE_DEFAULTS } from "../src/core/itemSizeCatalog.js";
import { parseItemText } from "../src/core/parseItem.js";
import { strongText, text } from "./support/batchFixtures.js";
import { unid, weakText, wisdom } from "./support/bagFixtures.js";

const native = vi.hoisted(() => ({ start: vi.fn(), send: vi.fn(), close: vi.fn(), map: vi.fn() }));
vi.mock("../src/adapters/bagWinHost.js", () => ({ startWinHost: native.start }));
vi.mock("../src/adapters/bagMapContext.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/adapters/bagMapContext.js")>(),
  createBagMapContext: () => ({ read: native.map }),
}));
import { fastBagTuning, openLiveBagFast } from "../src/adapters/liveBagFast.js";

const EMPTY_CURSOR = "1".repeat(64), W = 1600, H = 900;
const calibration: CalibrationProfile = { version: 1, client: { width: W, height: H }, npcs: [], updatedAt: "2026-09-17T12:00:00Z",
  bagGrid: { x: 900, y: 500, w: 600, h: 250, cols: 12, rows: 5 } };
const perception = { version: 1, client: calibration.client, evidence: "synthetic calibration; no real game", emptyCursorHashes: [EMPTY_CURSOR],
  ground: { x: 400, y: 400 }, cursorProbes: [{ x: 974, y: 324 }, { x: 1374, y: 324 }],
  inventoryChrome: { box: { x: 1100, y: 20, w: 2, h: 2 }, patch: { width: 2, height: 2, pixels: [0, 50, 100, 150] } } };
const noWaits = { scanHoverMs: 0, carefulHoverMs: 0, readTimeoutMs: 10, probeSettleMs: 0, armSettleMs: 0, chainSettleMs: 0, chainGapMs: 0, chainAfterMs: 0, heldSettleMs: 0, dropGapMs: 0 };
type Item = { id: number; text: string; row: number; col: number; w: number; h: number };

/** The real adapter, BMP decoding, pixel evidence, controller and orchestration run
 * against this deterministic rendered game. No PowerShell process or native input. */
function game(items: Array<{ text: string; row: number; col: number }>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bag-fast-adapter-"));
  const perceptionFile = path.join(directory, "perception.json"); writeFileSync(perceptionFile, JSON.stringify(perception));
  let next = 1;
  const model = { pointer: { x: 0, y: 0 }, held: undefined as Item | "wisdom" | undefined, cursorHash: EMPTY_CURSOR, dropRefused: false, drift: 0,
    foreground: true, ocr: "Inventory Life 100 / 100", ground: [] as Item[], commands: [] as Array<Record<string, unknown>>,
    bag: items.map(item => { const size = CLASS_SIZE_DEFAULTS.find(s => s.itemClass === parseItemText(item.text).itemClass); return { id: next++, ...item, w: size?.w ?? 1, h: size?.h ?? 1 }; }) };
  const cellAt = (p: { x: number; y: number }): BagPosition | undefined => p.x >= 900 && p.x < 1500 && p.y >= 500 && p.y < 750 ? { row: Math.floor((p.y - 500) / 50), col: Math.floor((p.x - 900) / 50) } : undefined;
  const itemAt = (cell?: BagPosition) => cell && model.bag.find(i => cell.row >= i.row && cell.row < i.row + i.h && cell.col >= i.col && cell.col < i.col + i.w);
  function render(): Buffer {
    const data = Buffer.alloc(W * H * 3);
    const put = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 3; data[i] = c[0]!; data[i + 1] = c[1]!; data[i + 2] = c[2]!; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.fill(40 + (x * 7 + y * 13) % 60, (y * W + x) * 3, (y * W + x) * 3 + 3);
    for (let y = 500; y < 750; y++) for (let x = 900; x < 1500; x++) put(x, y, [5, 5, 5]);
    [0, 50, 100, 150].forEach((v, i) => put(1100 + i % 2, 20 + Math.floor(i / 2), [v, v, v]));
    for (const item of model.bag) {
      const background = parseItemText(item.text).identified ? [27, 4, 4] : [3, 3, 41];
      for (let y = 0; y < item.h * 50; y++) for (let x = 0; x < item.w * 50; x++) {
        const inner = x % 50 >= 8 && x % 50 < 42 && y % 50 >= 8 && y % 50 < 42 && (x * 3 + y * 5 + item.id * 7) % 11 <= 3;
        const level = 205 + (x * item.id + y) % 45;
        put(900 + item.col * 50 + x, 500 + item.row * 50 + y, inner ? [level, level - 20, level - 35] : background);
      }
    }
    if (model.held) for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if ((x + y * 3) % 3) put(model.pointer.x - 12 + x, model.pointer.y - 12 + y, [180, 200, 220]);
    return data;
  }
  const state = () => ({ ok: true, hwnd: "11", pid: 12, process: "PathOfExileSteam", foregroundIsPoe: model.foreground, stopped: false, paused: false, left: 0, top: 0, width: W, height: H, at: new Date().toISOString() });
  native.start.mockReturnValue({ send: native.send, close: native.close });
  native.close.mockResolvedValue(undefined);
  native.map.mockImplementation(() => ({ context: "map", loading: false, mapInstance: "synthetic-map", processId: 12, evidence: "synthetic-map-log" }));
  native.send.mockImplementation(async (command: Record<string, unknown>) => {
    model.commands.push(command);
    const point = { x: Number(command.x), y: Number(command.y) };
    switch (command.op) {
      case "state": return state();
      case "focus": return { ok: true, focused: true };
      case "clipboard": return { ok: true, text: "user clipboard" };
      case "setclipboard": return { ok: true };
      case "ocr": return { ok: true, text: model.ocr, lines: [] };
      case "move": model.pointer = point; return { ok: true };
      case "readitem": { model.pointer = point; const found = itemAt(cellAt(point)); return { ok: true, copied: !!found, text: found?.text ?? "", waitedMs: 5 }; }
      case "rightclick": model.pointer = point; if (!model.held && parseItemText(itemAt(cellAt(point))?.text ?? "").name === "Scroll of Wisdom") model.held = "wisdom"; return { ok: true };
      case "clickchain": {
        for (const p of command.points as Array<{ x: number; y: number }>) {
          model.pointer = p;
          const target = itemAt(cellAt(p)), scroll = itemAt({ row: 0, col: 0 });
          if (model.held !== "wisdom" || !target || !scroll || parseItemText(target.text).identified) continue;
          target.text = target.text.replace(/\n--------\nUnidentified$/, "") + weakText().split("--------\n").at(-1)!;
          const left = Number(/Stack Size: (\d+)/.exec(scroll.text)![1]) - 1;
          if (left > 0) scroll.text = wisdom(left); else model.bag.splice(model.bag.indexOf(scroll), 1);
        }
        model.held = undefined; return { ok: true, count: (command.points as unknown[]).length };
      }
      case "click": {
        model.pointer = point;
        const found = itemAt(cellAt(point));
        if (!model.held && found) { model.bag.splice(model.bag.indexOf(found), 1); model.held = found; }
        else if (model.held && model.held !== "wisdom" && !cellAt(point) && !model.dropRefused) { model.ground.push(model.held); model.held = undefined; }
        return { ok: true };
      }
      case "regions": {
        const frame = render(), rects = command.rects as Array<{ x: number; y: number; w: number; h: number }>;
        const files = rects.map((rect, index) => {
          const row = Math.ceil(rect.w * 3 / 4) * 4, body = Buffer.alloc(row * rect.h);
          for (let y = 0; y < rect.h; y++) frame.copy(body, y * row, ((rect.y + y) * W + rect.x) * 3, ((rect.y + y) * W + rect.x + rect.w) * 3);
          const header = Buffer.alloc(54); header.write("BM"); header.writeUInt32LE(54 + body.length, 2); header.writeUInt32LE(54, 10); header.writeUInt32LE(40, 14);
          header.writeInt32LE(rect.w, 18); header.writeInt32LE(-rect.h, 22); header.writeUInt16LE(1, 26); header.writeUInt16LE(24, 28);
          const file = `${String(command.path)}.${index}.bmp`; writeFileSync(file, Buffer.concat([header, body]));
          return { path: file, ...rect, sha256: "0".repeat(64) };
        });
        return { ...state(), capturedAt: new Date().toISOString(), files, cursor: { clientX: model.pointer.x + model.drift, clientY: model.pointer.y, visible: true, sha256: model.cursorHash } };
      }
      default: throw new Error("Unexpected native operation: " + String(command.op));
    }
  });
  const log: FastLogEntry[] = [], sessions: BagSession[] = [];
  const client = openLiveBagFast({ directory, calibration, perceptionFile, clientLog: "synthetic-client-log", tuning: noWaits,
    record: entry => { log.push(entry); }, saveSession: session => { sessions.push(structuredClone(session)); } });
  return { directory, model, client, log, sessions, ops: () => model.commands.map(c => String(c.op)) };
}
const run = (g: ReturnType<typeof game>, maxDrops = 59) => runFastBag({ id: "fast-adapter", origin: "live", maxIdentifications: 59, maxDrops }, g.client.ports);
const gloves = text([], { itemClass: "Gloves", base: "Knightly Mitts", name: "Fixture Mitts", status: "Unidentified" });
const bagItems = () => [{ text: wisdom(6), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 },
  { text: strongText(), row: 0, col: 3 }, { text: gloves, row: 1, col: 4 }];

let current: ReturnType<typeof game> | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { if (current) { await current.client.close(); rmSync(current.directory, { recursive: true, force: true }); current = undefined; } });

describe("fast live adapter against a rendered native transport", { timeout: 30000 }, () => {
  it("completes the one-action workflow from pixels, one read per physical item and one Shift chain", async () => {
    const g = current = game(bagItems());
    await g.client.activate();
    const result = await run(g);
    expect(result.scrollsUsed).toBe(2);
    expect(result.session.droppedIds).toHaveLength(2);
    expect(g.model.ground.map(i => parseItemText(i.text).name)).toEqual(["Fixture Ring", "Fixture Ring"]);
    expect(g.model.bag.map(i => parseItemText(i.text).name).sort()).toEqual(["Fixture Mitts", "Fixture Ring", "Scroll of Wisdom"]);
    validateBagSession(result.session);
    const ops = g.ops(), firstMutation = ops.indexOf("rightclick");
    // Five physical items -> five scan reads; no whole-frame capture anywhere.
    expect(ops.slice(0, firstMutation).filter(op => op === "readitem")).toHaveLength(5);
    expect(ops).not.toContain("capture");
    const chain = g.model.commands.find(c => c.op === "clickchain")!;
    expect(chain.shift).toBe(true);
    expect(chain.points).toHaveLength(2);
    expect(g.model.commands.filter(c => ["move", "readitem", "click", "rightclick", "clickchain", "regions", "focus", "setclipboard"].includes(String(c.op))).every(c => c.expectedHwnd === "11")).toBe(true);
    expect(g.log.map(e => e.kind)).toContain("final");
    const trace = readFileSync(path.join(g.directory, "input-trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(trace.filter(t => t.result === "emitted").length).toBe(g.client.inputCount);
    expect(trace.some(t => t.result && t.result !== "emitted")).toBe(false);
  });

  it("refuses to start when a software payload follows the pointer or the native cursor is unknown", async () => {
    const held = current = game(bagItems()); held.model.held = "wisdom";
    await expect(run(held)).rejects.toThrow("not provably empty");
    expect(held.ops().some(op => ["readitem", "click", "rightclick", "clickchain"].includes(op))).toBe(false);
    await held.client.close(); rmSync(held.directory, { recursive: true, force: true });
    const unknown = current = game(bagItems()); unknown.model.cursorHash = "f".repeat(64);
    await expect(run(unknown)).rejects.toThrow("not provably empty");
  });

  it("reports a refused drop as a held item and records no unverified drop", async () => {
    const g = current = game(bagItems()); g.model.dropRefused = true;
    const error = await run(g).catch(e => e);
    expect(error).toBeInstanceOf(FastBagStop);
    expect(error.held).toBe("item");
    expect(g.sessions.at(-1)!.droppedIds).toHaveLength(0);
    expect(g.sessions.at(-1)!.identifiedIds).toHaveLength(2);
    expect(g.log.at(-1)).toMatchObject({ kind: "stop", held: "item" });
    expect(g.ops().filter(op => op === "click")).toHaveLength(2); // one pickup, one refused release, nothing after
  });

  it("stops on focus loss, a moved pointer, death or an obstructing panel before any mutation", async () => {
    const focus = current = game(bagItems()); focus.model.foreground = false;
    await expect(run(focus)).rejects.toThrow("focus");
    await focus.client.close(); rmSync(focus.directory, { recursive: true, force: true });
    const drift = current = game(bagItems()); drift.model.drift = 9;
    await expect(run(drift)).rejects.toThrow("Cursor moved away");
    await drift.client.close(); rmSync(drift.directory, { recursive: true, force: true });
    for (const ocr of ["Inventory Life 0 / 100", "Inventory Life 100 / 100 Resurrect at checkpoint"]) {
      const g = current = game(bagItems()); g.model.ocr = ocr;
      await expect(run(g)).rejects.toThrow("unsafe");
      expect(g.ops().some(op => ["readitem", "click", "rightclick", "clickchain"].includes(op))).toBe(false);
      await g.client.close(); rmSync(g.directory, { recursive: true, force: true });
    }
    current = undefined;
  });

  it("bounds every timing override to the native wait range", () => {
    expect(fastBagTuning({ scanHoverMs: 60 }).scanHoverMs).toBe(60);
    for (const bad of [{ scanHoverMs: 251 }, { dropGapMs: -1 }, { readTimeoutMs: 5 }, { unknown: 1 } as never, { chainGapMs: 1.5 }]) expect(() => fastBagTuning(bad)).toThrow("timing");
  });
});
