import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CalibrationProfile } from "../src/core/calibrationProfile.js";
import type { BagSession } from "../src/core/bagSession.js";
import { createBagSession, runBagStage } from "../src/core/bagSession.js";
import { captureBagObservations } from "../src/core/bagAssessment.js";
import { parseItemText } from "../src/core/parseItem.js";
import { unid, weakText, wisdom } from "./support/bagFixtures.js";

const native = vi.hoisted(() => ({ start: vi.fn(), send: vi.fn(), close: vi.fn(), map: vi.fn() }));
vi.mock("../src/adapters/winHost.js", () => ({ startWinHost: native.start }));
vi.mock("../src/adapters/bagMapContext.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/adapters/bagMapContext.js")>(),
  createBagMapContext: () => ({ read: native.map }),
}));
import { openLiveBag, type BagLivePerception } from "../src/adapters/liveBag.js";

const EMPTY = "1".repeat(64), WISDOM = "2".repeat(64), UNKNOWN = "f".repeat(64);
const WIDTH = 800, HEIGHT = 600;
type OcrLine = { x: number; y: number; w: number; h: number; text: string };
function savedHudLine(text: string, x: number, y: number, w: number, h: number): OcrLine {
  return { text, x: x * WIDTH / 3840, y: y * HEIGHT / 2160, w: w * WIDTH / 3840, h: h * HEIGHT / 2160 };
}
const calibration: CalibrationProfile = { version: 1, client: { width: WIDTH, height: HEIGHT }, npcs: [], updatedAt: "2026-09-14T12:00:00Z",
  bagGrid: { x: 500, y: 250, w: 240, h: 100, cols: 12, rows: 5 } };
const initialPerception: BagLivePerception = { version: 1, client: calibration.client, evidence: "synthetic calibration; no real game",
  emptyCursorHashes: [EMPTY], ground: { x: 200, y: 200 },
  inventoryChrome: { box: { x: 600, y: 10, w: 2, h: 2 }, patch: { width: 2, height: 2, pixels: [0, 50, 100, 150] } } };
const aboveGridProbes: NonNullable<BagLivePerception["cursorProbes"]> = [{ x: 550, y: 150 }, { x: 700, y: 150 }];

/** Real BMP decoding, cell comparison, controller and input sink run against this
 * deterministic native transport. No PowerShell process or native input starts. */
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bag-live-adapter-"));
  const perceptionFile = path.join(directory, "perception.json");
  writeFileSync(perceptionFile, JSON.stringify(initialPerception));
  const data = Buffer.alloc(WIDTH * HEIGHT * 3, 20);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) data.fill((y * 2 + x) * 50, ((y + 10) * WIDTH + x + 600) * 3, ((y + 10) * WIDTH + x + 600) * 3 + 3);
  const state = { ok: true, hwnd: "11", pid: 12, process: "PathOfExileSteam.exe", foregroundIsPoe: true, stopped: false, paused: false,
    left: 0, top: 0, width: WIDTH, height: HEIGHT };
  const model = { cursor: EMPTY, clipboard: "original user clipboard", x: 0, y: 0, ocr: "Inventory Cosmetics Life 100 / 100", captures: 0,
    lifeOcr: undefined as string | undefined, lifeValueOcr: undefined as string | undefined,
    lifeLines: undefined as OcrLine[] | undefined, lifeValueLines: undefined as OcrLine[] | undefined,
    payload: undefined as { pixels: Buffer; native?: boolean } | undefined,
    lines: [] as OcrLine[], capturedAt: undefined as string | undefined,
    onCommand: undefined as ((command: Record<string, unknown>) => void) | undefined,
    texts: new Map<string, string>(), state, data };
  native.start.mockReturnValue({ send: native.send, close: native.close });
  native.close.mockResolvedValue(undefined);
  native.map.mockImplementation(() => ({ context: "map", loading: false, mapInstance: "synthetic-map", processId: 12, evidence: "synthetic-map-log" }));
  native.send.mockImplementation(async (command: Record<string, unknown>) => {
    model.onCommand?.(command);
    switch (command.op) {
      case "state": case "rect": return { ...state };
      case "move": model.x = Number(command.x); model.y = Number(command.y); return { ok: true };
      case "clipboard": return { ok: true, text: model.clipboard };
      case "setclipboard": model.clipboard = String(command.text); return { ok: true };
      case "hotkey": {
        if (command.expectedCursorX !== model.x || command.expectedCursorY !== model.y) return { ok: false, error: "cursor-position-changed" };
        const key = Math.floor((model.y - 250) / 20) + "," + Math.floor((model.x - 500) / 20);
        const text = model.texts.get(key); if (text) model.clipboard = text;
        return { ok: true };
      }
      case "ocr": {
        const labelCrop = command.left !== undefined && command.width === Math.round(WIDTH * 75 / 3840);
        const valueCrop = command.left !== undefined && !labelCrop;
        return { ok: true, text: labelCrop ? model.lifeOcr ?? model.ocr : valueCrop ? model.lifeValueOcr ?? model.ocr : model.ocr,
          lines: structuredClone(labelCrop ? model.lifeLines ?? model.lines : valueCrop ? model.lifeValueLines ?? model.lines : model.lines) };
      }
      case "capture": {
        model.captures++;
        const rendered = Buffer.from(data);
        if (model.payload && !model.payload.native) for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
          const destination = ((model.y - 10 + y) * WIDTH + model.x - 10 + x) * 3, source = (y * 20 + x) * 3;
          for (let channel = 0; channel < 3; channel++) rendered[destination + channel] = model.payload.pixels[source + channel]!;
        }
        let nativeArt: Record<string, unknown> = {};
        if (model.payload?.native) {
          const rgba = Buffer.alloc(20 * 20 * 4);
          for (let i = 0; i < 400; i++) {
            rgba[i * 4] = model.payload.pixels[i * 3 + 2]!; rgba[i * 4 + 1] = model.payload.pixels[i * 3 + 1]!;
            rgba[i * 4 + 2] = model.payload.pixels[i * 3]!; rgba[i * 4 + 3] = 255;
          }
          nativeArt = { width: 20, height: 20, hotspotX: 10, hotspotY: 10, rgbaBase64: rgba.toString("base64") };
        }
        const header = Buffer.alloc(54); header.write("BM"); header.writeUInt32LE(54 + data.length, 2); header.writeUInt32LE(54, 10);
        header.writeUInt32LE(40, 14); header.writeInt32LE(WIDTH, 18); header.writeInt32LE(-HEIGHT, 22); header.writeUInt16LE(1, 26); header.writeUInt16LE(24, 28);
        writeFileSync(String(command.path), Buffer.concat([header, rendered]));
        return { ...state, capturedAt: model.capturedAt ?? new Date().toISOString(), cursor: { visible: true, sha256: model.cursor,
          clientX: model.x, clientY: model.y, ...nativeArt } };
      }
      case "click": case "rightclick": return { ok: true };
      default: throw new Error("Unexpected native operation in adapter replay: " + String(command.op));
    }
  });
  return { directory, perceptionFile, model, options: { directory, perceptionFile, calibration, clientLog: "synthetic-client-log", save() {} } };
}

let f: ReturnType<typeof fixture>;
const clients: Array<ReturnType<typeof openLiveBag>> = [];
function open(previous?: Parameters<typeof openLiveBag>[0]["previous"], save?: (session: BagSession) => void) {
  const client = openLiveBag({ ...f.options, previous, ...(save ? { save } : {}) }); clients.push(client); return client;
}
function inputs() { return native.send.mock.calls.map(call => call[0] as Record<string, unknown>).filter(call => ["hotkey", "click", "rightclick", "move"].includes(String(call.op))); }
function sourceArt(row: number, col: number) {
  const pixels = Buffer.alloc(20 * 20 * 3, 20);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) {
    const index = (y * 20 + x) * 3;
    pixels[index] = 80 + (x * 17 + y * 31) % 170;
    pixels[index + 1] = 80 + (x * 43 + y * 11) % 170;
    pixels[index + 2] = 80 + (x * 7 + y * 29) % 170;
  }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const destination = ((250 + row * 20 + y) * WIDTH + 500 + col * 20 + x) * 3, source = (y * 20 + x) * 3;
    for (let channel = 0; channel < 3; channel++) f.model.data[destination + channel] = pixels[source + channel]!;
  }
  return pixels;
}
function eraseSource(row: number, col: number) {
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const index = ((250 + row * 20 + y) * WIDTH + 500 + col * 20 + x) * 3;
    f.model.data.fill(20, index, index + 3);
  }
}
async function settle<T>(operation: Promise<T>): Promise<T> {
  const result = operation.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); f = fixture(); });
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.useRealTimers(); rmSync(f.directory, { recursive: true, force: true });
});

describe("actual live adapter with a replayed native transport", { timeout: 20000 }, () => {
  it("rejects invalid perception files before starting a native host", () => {
    writeFileSync(f.perceptionFile, JSON.stringify({ ...initialPerception, ground: { x: 700, y: 200 } }));
    expect(() => open()).toThrow("calibration");
    expect(native.start).not.toHaveBeenCalled(); expect(native.send).not.toHaveBeenCalled();
  });
  it.each(["grid", "patch", "cursor-overlap"])("rejects malformed %s calibration before starting the host", fault => {
    const profile = structuredClone(calibration), perception = structuredClone(initialPerception);
    if (fault === "grid") profile.bagGrid!.x = WIDTH;
    if (fault === "patch") perception.inventoryChrome.patch.pixels.pop();
    if (fault === "cursor-overlap") perception.heldCursorHashes = { item: [EMPTY] };
    writeFileSync(f.perceptionFile, JSON.stringify(perception));
    expect(() => openLiveBag({ ...f.options, calibration: profile })).toThrow();
    expect(native.start).not.toHaveBeenCalled(); expect(native.send).not.toHaveBeenCalled();
  });
  it.each([
    ["overlapping", [{ x: 200, y: 200 }, { x: 220, y: 200 }]],
    ["bag grid", [{ x: 550, y: 260 }, { x: 200, y: 200 }]],
    ["inventory chrome", [{ x: 600, y: 75 }, { x: 200, y: 200 }]],
    ["outside client", [{ x: 790, y: 150 }, { x: 200, y: 200 }]],
    ["fractional", [{ x: 550.5, y: 150 }, { x: 700, y: 150 }]],
    ["non-finite", [{ x: Number.NaN, y: 150 }, { x: 700, y: 150 }]],
    ["wrong length", [{ x: 550, y: 150 }]],
    ["null", null],
  ])("rejects %s explicit cursor probes before host startup", (_reason, cursorProbes) => {
    writeFileSync(f.perceptionFile, JSON.stringify({ ...initialPerception, cursorProbes }));
    expect(() => open()).toThrow("cursor probe");
    expect(native.start).not.toHaveBeenCalled(); expect(native.send).not.toHaveBeenCalled();
  });
  it.each(["stop", "focus", "map", "process"])("blocks %s before any pointer or keyboard input", async fault => {
    if (fault === "stop") f.model.state.stopped = true;
    if (fault === "focus") f.model.state.foregroundIsPoe = false;
    if (fault === "map") native.map.mockReturnValue({ context: "unknown", loading: true });
    if (fault === "process") f.model.state.pid = 99;
    await expect(settle(open().ports.observe())).rejects.toThrow();
    expect(inputs()).toHaveLength(0);
  });
  it("records an unknown cursor using only a pointer move, never copy keys or clicks", async () => {
    f.model.cursor = UNKNOWN;
    await expect(settle(open().ports.observe())).rejects.toThrow("cursor");
    expect(inputs().map(input => input.op)).toEqual(["move", "move"]);
    expect(f.model.captures).toBe(2);
  });
  it("rejects a software-held payload even when the OS cursor is the known empty arrow", async () => {
    f.model.cursor = EMPTY; f.model.payload = { pixels: sourceArt(0, 1) };
    await expect(settle(open().ports.observe())).rejects.toThrow("Cursor payload");
    expect(inputs().map(input => input.op)).toEqual(["move", "move"]);
    expect(native.send.mock.calls.some(([command]) => command.op === "setclipboard")).toBe(false);
  });
  it("rejects pointer coordinates that moved away from the requested probe before any clipboard input", async () => {
    f.model.onCommand = command => { if (command.op === "capture") f.model.x += 2; };
    await expect(settle(open().ports.observe())).rejects.toThrow();
    expect(inputs().every(input => input.op === "move")).toBe(true);
    expect(native.send.mock.calls.some(([command]) => command.op === "setclipboard")).toBe(false);
  });
  it.each(["Inventory Life 0 / 100", "Inventory Life 100 / 100 Destroy this item?"])("checks HUD and modal evidence before copy keys: %s", async text => {
    f.model.ocr = text;
    await expect(settle(open().ports.observe())).rejects.toThrow("HUD");
    expect(inputs().map(input => input.op)).toEqual(["move", "move"]);
  });
  it("binds separately cropped Life label and value from the same frame when whole-frame OCR is garbled", async () => {
    // Coordinates and text are recorded from live06 at 3840x2160, scaled to this replay's client.
    f.model.ocr = "& V FtvrORY ie/d ard";
    f.model.lifeOcr = "Life"; f.model.lifeLines = [savedHudLine("Life", 92, 1589, 64, 33)];
    f.model.lifeValueOcr = "Life.;n 2,446/2,599";
    f.model.lifeValueLines = [savedHudLine("Life.;n", 91, 1590, 81, 30), savedHudLine("2,446/2,599", 234, 1593, 176, 36)];
    const observed = await settle(open().ports.observe());
    expect(observed.alive).toBe(true); expect(observed.inventoryOpen).toBe(true);
    const commands = native.send.mock.calls.map(([command]) => command as Record<string, unknown>);
    const crops = commands.filter(command => command.op === "ocr" && command.left !== undefined);
    expect(crops.length).toBeGreaterThan(0);
    for (const crop of crops) {
      expect(crop.neutralContext).toBeFalsy(); expect(crop.textThreshold ?? 0).toBe(0);
      expect(commands.some(command => command.op === "ocr" && command.path === crop.path && command.left === undefined)).toBe(true);
    }
    expect(crops.some(crop => crop.width === Math.round(WIDTH * 75 / 3840) && crop.scale === 2)).toBe(true);
    const saved = JSON.parse(readFileSync(observed.evidence + ".scene.json", "utf8")) as {
      ocr: { text: string }; lifeOcr: { text: string; lines: OcrLine[] }; lifeValueOcr: { text: string; lines: OcrLine[] }; scene: { at: string };
    };
    expect(saved.ocr.text).toBe(f.model.ocr);
    expect(saved.lifeOcr).toMatchObject({ text: "Life", lines: f.model.lifeLines });
    expect(saved.lifeValueOcr).toMatchObject({ text: f.model.lifeValueOcr, lines: f.model.lifeValueLines });
    expect(saved.scene.at).toBe(observed.at);
    expect(inputs().some(input => ["click", "rightclick"].includes(String(input.op)))).toBe(false);
  });
  it("uses exact cropped digits when whole-frame Life, Shield and Ward labels precede a starred Life value", async () => {
    // This is live05's actual OCR order; flattening it cannot bind Life to its value.
    f.model.ocr = "Inventory Cosmetics Life Shield Ward *2,446/2,599 1,165/1,165 377/377";
    f.model.lines = [savedHudLine("Life", 93, 1590, 56, 30), savedHudLine("Shield", 92, 1634, 100, 30),
      savedHudLine("Ward", 90, 1679, 92, 30), savedHudLine("*2,446/2,599", 220, 1593, 190, 36),
      savedHudLine("1,165/1,165", 262, 1637, 148, 36), savedHudLine("377/377", 303, 1682, 108, 36)];
    f.model.lifeOcr = "Life"; f.model.lifeLines = [savedHudLine("Life", 93, 1590, 56, 30)];
    f.model.lifeValueOcr = "Life 2,446/2,599";
    f.model.lifeValueLines = [savedHudLine("Life", 93, 1590, 56, 30), savedHudLine("2,446/2,599", 220, 1593, 190, 36)];
    expect((await settle(open().ports.observe())).alive).toBe(true);
  });
  it.each(["missing-label", "off-row", "dead"])("rejects %s cropped HUD evidence before copying", async fault => {
    f.model.ocr = "garbled labels";
    f.model.lifeOcr = fault === "missing-label" ? "" : "Life";
    f.model.lifeLines = fault === "missing-label" ? [] : [savedHudLine("Life", 93, 1590, 56, 30)];
    f.model.lifeValueOcr = fault === "dead" ? "0/2,599" : "2,446/2,599";
    f.model.lifeValueLines = [savedHudLine(f.model.lifeValueOcr, 234, fault === "off-row" ? 1637 : 1593, 176, 36)];
    await expect(settle(open().ports.observe())).rejects.toThrow("HUD");
    expect(inputs().map(input => input.op)).toEqual(["move", "move"]);
    expect(native.send.mock.calls.some(([command]) => command.op === "setclipboard")).toBe(false);
  });
  it("recognizes the inventory title from its calibrated pixels when whole-frame OCR misses the word", async () => {
    f.model.ocr = "& V FtvrORY Life 100 / 100";
    const observed = await settle(open().ports.observe());
    expect(observed.inventoryOpen).toBe(true); expect(observed.alive).toBe(true);
  });
  it("captures all 60 cells with independent sentinel/read pairs and no inventory mutation", async () => {
    f.model.texts.set("0,1", weakText());
    const client = open(), observed = await settle(client.ports.observe());
    expect(observed.cells).toHaveLength(60); expect(observed.inventoryOpen).toBe(true); expect(observed.cursor.state).toBe("empty");
    expect(observed.cells[1]).toMatchObject({ state: "item", rawText: weakText(), confirmation: weakText() });
    const commands = native.send.mock.calls.map(call => call[0] as Record<string, unknown>);
    expect(commands.filter(command => command.op === "setclipboard")).toHaveLength(120);
    expect(inputs().filter(input => input.op === "hotkey")).toHaveLength(120);
    expect(inputs().some(input => ["click", "rightclick"].includes(String(input.op)))).toBe(false);
    for (const command of inputs()) expect(command).toMatchObject({ requireForeground: true, expectedHwnd: "11" });
    const trace = readFileSync(path.join(f.directory, "input-trace.jsonl"), "utf8");
    expect(trace).toContain('"scenarioId":"bag-triage"');
    await client.close(); clients.splice(clients.indexOf(client), 1);
    expect(f.model.clipboard).toBe("original user clipboard");
  });
  it("preserves native frame time and never overwrites a previous run's evidence", async () => {
    const first = open(), before = await settle(first.ports.observe());
    const bytes = readFileSync(before.evidence);
    expect(before.at).toBe((JSON.parse(readFileSync(before.evidence + ".json", "utf8")) as { capturedAt: string }).capturedAt);
    writeFileSync(f.perceptionFile, JSON.stringify({ ...initialPerception, cursorProbes: aboveGridProbes }));
    native.send.mockClear();
    const second = open(), after = await settle(second.ports.observe());
    expect(after.evidence).not.toBe(before.evidence);
    expect(readFileSync(before.evidence)).toEqual(bytes);
    expect(inputs().slice(0, 2).map(input => ({ x: input.x, y: input.y }))).toEqual(aboveGridProbes);
    expect(after.calibration).not.toBe(before.calibration);
    expect(after.ground.x).toBe(before.ground.x); expect(after.ground.y).toBe(before.ground.y);
  });
  it("stops if focus changes between pointer movement and copying", async () => {
    let moves = 0;
    f.model.onCommand = command => { if (command.op === "move" && ++moves === 2) f.model.state.foregroundIsPoe = false; };
    await expect(settle(open().ports.observe())).rejects.toThrow("focus");
    expect(inputs().map(input => input.op)).toEqual(["move", "move"]);
  });
  it("rejects movement to another item during hover before the native copy can bind its text", async () => {
    f.model.texts.set("0,1", weakText());
    f.model.onCommand = command => {
      if (command.op === "move" && Number(command.x) >= 500) setTimeout(() => { f.model.x += 20; }, 70);
    };
    await expect(settle(open().ports.observe())).rejects.toThrow("cursor-position-changed");
    const copy = inputs().find(command => command.op === "hotkey");
    expect(copy).toMatchObject({ expectedCursorX: 510, expectedCursorY: 260, keys: "ctrlaltc" });
    expect(f.model.clipboard).toMatch(/^bag-copy:/);
    expect(inputs().filter(command => command.op === "hotkey")).toHaveLength(1);
    expect(inputs().some(command => ["click", "rightclick"].includes(String(command.op)))).toBe(false);
  });
  it("invalidates cached identity when another cell changes during a target re-read", async () => {
    const client = open(); await settle(client.ports.observe());
    let changed = false;
    f.model.onCommand = command => {
      if (command.op !== "hotkey" || changed) return;
      changed = true;
      for (let y = 276; y < 284; y++) for (let x = 546; x < 554; x++) {
        f.model.data.fill(100, (y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3);
      }
    };
    await expect(settle(client.ports.observe({ phase: "before", cells: [{ row: 0, col: 1 }], itemId: "target" }))).rejects.toThrow("cached identity");
    expect(inputs().some(input => ["click", "rightclick"].includes(String(input.op)))).toBe(false);
  });
  it("runs actual adapter identification only after durable pending receipts, with no copies while Wisdom is armed", async () => {
    f.model.texts.set("0,0", wisdom(2)); f.model.texts.set("0,1", unid());
    const scrollArt = sourceArt(0, 0); sourceArt(0, 1);
    let latest: BagSession | undefined;
    const client = open(undefined, saved => { latest = structuredClone(saved); });
    const observed = await settle(client.ports.observe());
    const initial = createBagSession(captureBagObservations("identify-one", observed.cells), observed, "live");
    client.ports.save(initial);
    f.model.onCommand = command => {
      if (["click", "rightclick"].includes(String(command.op))) {
        expect(latest?.receipts.at(-1)?.state).toBe("pending");
        expect(latest?.receipts.at(-1)?.action.kind).toBe(command.op === "rightclick" ? "arm" : "identify");
      }
      if (command.op === "hotkey") expect(f.model.cursor).toBe(EMPTY);
      if (command.op === "rightclick") {
        expect(command).toMatchObject({ x: 510, y: 260 }); f.model.cursor = WISDOM; f.model.payload = { pixels: scrollArt, native: true };
      }
      if (command.op === "click") {
        expect(command).toMatchObject({ x: 530, y: 260 }); f.model.cursor = EMPTY; f.model.payload = undefined;
        f.model.texts.set("0,0", wisdom(1)); f.model.texts.set("0,1", weakText());
      }
    };
    const done = await settle(runBagStage(initial, "identify", client.ports, { maxIdentifications: 1 }));
    expect(done.identifiedIds).toHaveLength(1); expect(done.report.rows[0]!.quantity).toBe(1);
    expect(done.receipts.map(receipt => [receipt.action.kind, receipt.state])).toEqual([["arm", "verified"], ["identify", "verified"]]);
    expect(inputs().filter(input => ["click", "rightclick"].includes(String(input.op))).map(input => input.op)).toEqual(["rightclick", "click"]);
  });
  it("prevents real adapter mutation when durable pending journal write fails", async () => {
    f.model.texts.set("0,0", wisdom(2)); f.model.texts.set("0,1", unid());
    const client = open(undefined, () => { throw new Error("durable journal full"); });
    const observed = await settle(client.ports.observe());
    const initial = createBagSession(captureBagObservations("write-fail", observed.cells), observed, "live");
    await expect(settle(runBagStage(initial, "identify", client.ports, { maxIdentifications: 1 }))).rejects.toThrow("journal full");
    expect(inputs().some(input => ["click", "rightclick"].includes(String(input.op)))).toBe(false);
  });
  it.each([false, true])("requires a new world label after release (new label: %s)", async added => {
    const rawText = weakText(), parsed = parseItemText(rawText);
    if (added) writeFileSync(f.perceptionFile, JSON.stringify({ ...initialPerception, cursorProbes: aboveGridProbes }));
    f.model.texts.set("0,1", rawText);
    const art = sourceArt(0, 1);
    const label = { text: parsed.name, x: 100, y: 200, w: 60, h: 15 };
    f.model.lines = [label];
    let latest: BagSession | undefined;
    const client = open(undefined, saved => { latest = structuredClone(saved); });
    const observed = await settle(client.ports.observe());
    const initial = createBagSession(captureBagObservations("drop-one", observed.cells), observed, "live");
    client.ports.save(initial);
    let clicks = 0;
    f.model.onCommand = command => {
      if (command.op !== "click") return;
      expect(latest?.receipts.at(-1)?.state).toBe("pending");
      if (++clicks === 1) {
        f.model.cursor = EMPTY; f.model.payload = { pixels: art }; f.model.texts.delete("0,1"); eraseSource(0, 1);
      } else {
        expect(command).toMatchObject({ x: initialPerception.ground.x, y: initialPerception.ground.y });
        f.model.cursor = EMPTY; f.model.payload = undefined;
        if (added) f.model.lines.push({ ...label, y: 230 });
      }
    };
    const operation = settle(runBagStage(initial, "drop", client.ports, { maxDrops: 1 }));
    if (added) {
      const done = await operation;
      expect(done.droppedIds).toHaveLength(1);
      expect(done.receipts.at(-1)?.after?.groundReceipt?.rawText).toBe(rawText);
    } else {
      await expect(operation).rejects.toThrow("Ground receipt");
      expect(latest?.droppedIds).toHaveLength(0);
      const pending = latest!;
      rmSync(pending.receipts.at(-1)!.before.evidence + ".scene.json");
      await client.close(); clients.splice(clients.indexOf(client), 1);
      f.model.lines.push({ ...label, y: 230 });
      const resumed = open(pending);
      await expect(settle(runBagStage(pending, "reconcile", resumed.ports))).rejects.toThrow("Ground receipt");
    }
    expect(clicks).toBe(2);
  });
  it("leaves an uncertain pickup pending when held art differs, without a drop or recovery click", async () => {
    f.model.texts.set("0,1", weakText()); const art = sourceArt(0, 1);
    let latest: BagSession | undefined;
    const client = open(undefined, session => { latest = structuredClone(session); });
    const observed = await settle(client.ports.observe());
    const initial = createBagSession(captureBagObservations("wrong-held", observed.cells), observed, "live");
    client.ports.save(initial);
    f.model.onCommand = command => {
      if (command.op !== "click") return;
      const wrong = Buffer.from(art); for (let i = 0; i < wrong.length; i += 3) wrong[i] = 0;
      f.model.payload = { pixels: wrong }; eraseSource(0, 1); f.model.texts.delete("0,1");
    };
    await expect(settle(runBagStage(initial, "drop", client.ports, { maxDrops: 1 }))).rejects.toThrow("Cursor payload");
    expect(latest?.receipts.at(-1)?.state).toBe("pending"); expect(latest?.droppedIds).toHaveLength(0);
    expect(inputs().filter(input => input.op === "click")).toHaveLength(1);
  });
  it("preserves armed cursor mode during restart observation before the original identify action", async () => {
    f.model.texts.set("0,0", wisdom(2)); f.model.texts.set("0,1", unid());
    const art = sourceArt(0, 0); sourceArt(0, 1);
    let saved: BagSession | undefined;
    const client = open(undefined, session => {
      if (session.receipts.length === 2) throw new Error("crash before identify");
      saved = structuredClone(session);
    });
    const initial = await settle(client.ports.observe());
    const original = createBagSession(captureBagObservations("saved", initial.cells), initial, "live");
    client.ports.save(original);
    f.model.onCommand = command => {
      if (command.op === "rightclick") { f.model.cursor = WISDOM; f.model.payload = { pixels: art, native: true }; }
    };
    await expect(settle(runBagStage(original, "identify", client.ports, { maxIdentifications: 1 }))).rejects.toThrow("crash before identify");
    await client.close(); clients.splice(clients.indexOf(client), 1);
    native.send.mockClear();
    const resumed = open(saved);
    const observed = await settle(resumed.ports.observe({ phase: "before", itemId: original.report.rows[1]!.id, cells: [{ row: 0, col: 1 }],
      action: saved!.receipts.at(-1)!.action }));
    expect(observed.cursor.state).toBe("wisdom");
    expect(inputs().every(input => input.op === "move")).toBe(true);
  });
});
