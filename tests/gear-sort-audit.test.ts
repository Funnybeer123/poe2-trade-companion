import { describe, expect, it, vi } from "vitest";
import { GearSorter, type SourceTab, type TabIndex } from "../src/adapters/gearSorter.js";
import type { GridCell } from "../src/core/gearSort.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TabListRow } from "../src/adapters/stashTabKit.js";

vi.mock("../src/core/itemSprites.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/core/itemSprites.js")>();
  return { ...actual, scoreGridCells: vi.fn(() => Array.from({ length: 576 }, (_, n) => ({
    row: Math.floor(n / 24), col: n % 24, mean: 0, variance: 0, itemFrac: 0,
  }))) };
});

interface AuditInternals {
  indexTab(source: SourceTab, key: string, exhaustive?: boolean): Promise<TabIndex>;
  scanTab: GearSorter["scanTab"];
  ensureSession: GearSorter["ensureSession"];
  gridCalibration: Record<string, { x: number; y: number; w: number; h: number; cols: number; rows: number }>;
  loadGridCalibration(): void;
  matchFolderRow(rows: TabListRow[], label: string, occurrence: number): TabListRow | undefined;
  gotoTopTabViaStrip(label: string, cacheKey: string): Promise<boolean | undefined>;
  gotoTab: GearSorter["gotoTab"];
  ensureFolderRowOpen(): Promise<boolean>;
  selectedFolderDestination(label: string, occurrence: number): Promise<boolean>;
}

function auditFixture() {
  const sorter = Object.create(GearSorter.prototype) as AuditInternals;
  const identify = vi.fn(async (cells: GridCell[], options: Record<string, unknown>) => ({ items: [], reads: [], unread: [], cells, options }));
  Object.assign(sorter, {
    options: { root: ".", templateDir: "." },
    harness: { checkpoint: vi.fn(async () => undefined), guard: vi.fn(), startPhase: () => vi.fn() },
    captureRaw: vi.fn(async () => ({ gray: { width: 1, height: 1, pixels: new Uint8Array(1) }, client: { left: 0, top: 0, width: 3840, height: 2160 } })),
    gridCalibrationLoaded: true,
    gridCalibration: { "Dump#0": { x: 30, y: 273, w: 1200, h: 1200, cols: 24, rows: 24 } },
    phantomStash: new Set(["Dump#0:0,0"]),
    phantomStore: new Map([["Dump#0:0,0", { mean: 0, variance: 0, row: 0, col: 0 }]]),
    identifyCells: identify,
    log: vi.fn(),
  });
  return { sorter, identify };
}

describe("exhaustive stash audit coverage", () => {
  it("rejects selected-pointer evidence that disappears before the confirming capture", async () => {
    const { sorter } = auditFixture();
    const client = { left: 1320, top: 480, width: 100, height: 200 };
    const data = new Uint8Array(client.width * client.height * 3);
    for (let dy = -12; dy <= 12; dy += 1) {
      const dx = Math.round(16 * (1 - Math.abs(dy) / 12));
      for (const x of [1352 - dx, 1352 + dx]) {
        data.set([40, 80, 150], ((561 + dy - client.top) * client.width + x - client.left) * 3);
      }
    }
    const frame = { client, bgr: { width: client.width, height: client.height, data } };
    const capture = vi.fn().mockResolvedValueOnce(frame)
      .mockResolvedValueOnce({ ...frame, bgr: { ...frame.bgr, data: new Uint8Array(data.length) } });
    Object.assign(sorter, { options: { strictTabNavigation: true }, captureRaw: capture,
      kit: { readTabList: async () => [{ index: 0, label: "Amulets", readable: true, clickY: 561 }, { index: 1, label: "Rings", readable: true, clickY: 614 }] },
      harness: { checkpoint: async () => undefined, sleep: async () => undefined } });
    expect(await sorter.selectedFolderDestination("Amulets", 0)).toBe(false);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("invalidates stale top-level selection after opening the destination folder", async () => {
    const { sorter } = auditFixture();
    const kit = { readStrip: vi.fn().mockResolvedValueOnce({ top: [{ label: "G", point: { x: 750, y: 220 }, width: 20 }], folder: [] })
      .mockResolvedValue({ top: [], folder: [{ label: "Amulets" }, { label: "Rings" }] }) };
    Object.assign(sorter, { options: { strictTabNavigation: true, gearFolderName: "G" }, kit,
      host: { send: vi.fn(async () => ({ ok: true })) }, surfaceClick: vi.fn(async () => true),
      harness: { guard: vi.fn(), sleep: vi.fn(async () => undefined) },
      lastSelected: "top:Dump#0", folderRowsCache: [{}], folderListOpen: true });
    expect(await sorter.ensureFolderRowOpen()).toBe(true);
    expect(sorter).toMatchObject({ lastSelected: undefined, folderRowsCache: undefined, folderListOpen: false });
  });

  it.each([undefined, "top:Dump#0", "Amulets#0"])("requires fresh selected-pointer proof for an unchanged destination even with remembered selection %s", async lastSelected => {
    const { sorter } = auditFixture();
    const target = { label: "Amulets", readable: true, index: 0, clickY: 561 };
    const proof = vi.fn(async () => true);
    Object.assign(sorter, { options: { strictTabNavigation: true }, lastSelected,
      stashRecentlyProven: () => true, openFolderList: async () => [target], surfaceClick: async () => true,
      park: async () => undefined, observeTabSwitch: async () => "unchanged", selectedFolderDestination: proof, rowYCache: new Map() });
    expect(await sorter.gotoTab("Amulets")).toBe(true);
    expect(proof).toHaveBeenCalledWith("Amulets", 0);
  });

  it("does not accept an empty destination just because exact OCR text is present", async () => {
    const { sorter } = auditFixture();
    const proof = vi.fn(async () => false);
    Object.assign(sorter, { options: { strictTabNavigation: true }, lastSelected: undefined,
      stashRecentlyProven: () => true, openFolderList: async () => [{ label: "Amulets", readable: true, index: 0, clickY: 561 }],
      surfaceClick: async () => true, park: async () => undefined, observeTabSwitch: async () => "unchanged",
      selectedFolderDestination: proof, rowYCache: new Map() });
    expect(await sorter.gotoTab("Amulets")).toBe(false);
    expect(proof).toHaveBeenCalledTimes(3);
  });

  it("strict navigation refuses remembered or duplicate row guesses", () => {
    const { sorter } = auditFixture();
    Object.assign(sorter, { options: { strictTabNavigation: true }, rowYCache: new Map([["Rings#0", 400]]) });
    expect(sorter.matchFolderRow([{ label: "Rngs", readable: true, index: 0, clickY: 400 }], "Rings", 0)).toBeUndefined();
    const exact = { label: "Rings", readable: true, index: 0, clickY: 400 };
    expect(sorter.matchFolderRow([exact], "Rings", 0)).toEqual(exact);
    expect(sorter.matchFolderRow([exact, { ...exact, index: 1, clickY: 447 }], "Rings", 0)).toBeUndefined();
  });

  it("strict source navigation refuses an unreadable header without issuing pointer input", async () => {
    const { sorter } = auditFixture();
    const pointer = vi.fn();
    Object.assign(sorter, { options: { strictTabNavigation: true },
      kit: { readStrip: async () => ({ top: [], folder: [] }) },
      readTopStripEnhanced: async () => [], surfaceClick: pointer });
    expect(await sorter.gotoTopTabViaStrip("Dump", "top:Dump#0")).toBe(false);
    expect(pointer).not.toHaveBeenCalled();
  });

  it("does not open a destination folder while preparing a top-level source scan", async () => {
    const { sorter } = auditFixture();
    const folder = vi.fn(async () => true);
    Object.assign(sorter, { host: { send: vi.fn(async () => ({ ok: true })) }, ensureStash: vi.fn(async () => true),
      ensureFolderRowOpen: folder, harness: { startPhase: () => vi.fn(), sleep: vi.fn(async () => undefined) } });
    await sorter.ensureSession({ openFolder: false });
    expect(folder).not.toHaveBeenCalled();
    await sorter.ensureSession();
    expect(folder).toHaveBeenCalledTimes(1);
  });

  it("reuses app calibration while distinguishing top-level and folder grid origins", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "poe2-grid-audit-"));
    try {
      const { sorter } = auditFixture();
      Object.assign(sorter, { options: { root, profileStashLayout: "top-level" }, gridCalibrationLoaded: false,
        profileCache: { quadStashGrid: { x: 28, y: 246, w: 1275, h: 1273, cols: 24, rows: 24 } } });
      sorter.loadGridCalibration();
      expect(sorter.gridCalibration.__default_24x24_toplevel).toMatchObject({ x: 28, y: 246, cols: 24 });
      expect(sorter.gridCalibration.__default_24x24).toMatchObject({ x: 28, y: 313, cols: 24 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("copies all 576 cells despite black occupancy and remembered phantoms", async () => {
    const { sorter, identify } = auditFixture();
    const result = await sorter.indexTab({ label: "Dump", occurrence: 0, topLevel: true }, "Dump", true);
    expect(identify.mock.calls[0]![0]).toHaveLength(576);
    const options = identify.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.phantomScope).toBeUndefined();
    expect(options.sameSpriteAsLeft).toBeUndefined();
    expect(result.coverage).toEqual({ totalCells: 576, copiedCells: 576, excludedCells: [] });
  });

  it("reports cells outside the safe input area rather than claiming complete coverage", async () => {
    const { sorter } = auditFixture();
    sorter.gridCalibration["Dump#0"]!.x = 0;
    const result = await sorter.indexTab({ label: "Dump", occurrence: 0, topLevel: true }, "Dump", true);
    expect(result.coverage?.copiedCells).toBe(552);
    expect(result.coverage?.excludedCells).toHaveLength(24);
  });

  it("forwards exhaustive selection through the public scan method", async () => {
    const { sorter } = auditFixture();
    const spy = vi.spyOn(sorter, "indexTab");
    await sorter.scanTab({ label: "Dump", occurrence: 0, topLevel: true }, { navigate: false, exhaustive: true });
    expect(spy).toHaveBeenCalledWith({ label: "Dump", occurrence: 0, topLevel: true }, "Dump", true);
  });
});
