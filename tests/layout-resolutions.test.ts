import { describe, expect, it } from "vitest";
import {
  allCellsInside,
  clampToRect,
  contentRect,
  displayMode,
  layoutSummary,
  resolvePhysicalClient,
  suggestMonitor,
} from "../src/core/screenLayout.js";
import { inventoryGrid, stashGrid } from "../src/core/stashAssist.js";
import type { ScreenRect } from "../src/core/screenLayout.js";

const CLIENTS: Array<{ name: string; client: ScreenRect; monitor?: [number, number] }> = [
  { name: "720p windowed offset", client: { left: 80, top: 40, width: 1280, height: 720 }, monitor: [1920, 1080] },
  { name: "720p live offset", client: { left: 491, top: 195, width: 1280, height: 720 }, monitor: [1920, 1080] },
  { name: "1080p windowed", client: { left: 100, top: 80, width: 1920, height: 1080 }, monitor: [2560, 1440] },
  { name: "1080p fullscreen", client: { left: 0, top: 0, width: 1920, height: 1080 }, monitor: [1920, 1080] },
  { name: "1366x768 laptop", client: { left: 0, top: 0, width: 1366, height: 768 }, monitor: [1366, 768] },
  { name: "1440p fullscreen", client: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: [2560, 1440] },
  { name: "4K fullscreen", client: { left: 0, top: 0, width: 3840, height: 2160 }, monitor: [3840, 2160] },
  { name: "4K windowed fullscreen via 1080p report", client: { left: 0, top: 0, width: 3840, height: 2160 }, monitor: [3840, 2160] },
  { name: "ultrawide 3440x1440", client: { left: 0, top: 0, width: 3440, height: 1440 }, monitor: [3440, 1440] },
  { name: "16:10 1920x1200", client: { left: 12, top: 32, width: 1920, height: 1200 }, monitor: [1920, 1200] },
  { name: "small 800x600 window", client: { left: 200, top: 100, width: 800, height: 600 }, monitor: [1920, 1080] },
];

describe("resolution and window-mode layout suite", () => {
  it.each(CLIENTS)("$name keeps every HUD click inside the client", ({ client }) => {
    const inventory = inventoryGrid(client);
    const stash = stashGrid(client);
    expect(inventory.length).toBe(60);
    expect(stash.length).toBe(144);
    expect(allCellsInside(inventory, client)).toBe(true);
    expect(allCellsInside(stash, client)).toBe(true);
  });

  it("treats covering the monitor as fullscreen", () => {
    expect(displayMode({ left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080)).toBe("fullscreen");
    expect(displayMode({ left: 491, top: 195, width: 1280, height: 720 }, 1920, 1080)).toBe("windowed");
  });

  it("pillarboxes ultrawide to 16:9 before placing HUD", () => {
    const content = contentRect({ left: 0, top: 0, width: 3440, height: 1440 });
    expect(content.width).toBeCloseTo(2560, 0);
    expect(content.left).toBeCloseTo(440, 0);
    const inventory = inventoryGrid({ left: 0, top: 0, width: 3440, height: 1440 });
    expect(inventory[0]!.x).toBeGreaterThan(440);
    expect(inventory[0]!.x).toBeLessThan(440 + 2560);
  });

  it("letterboxes tall 16:10 windows", () => {
    const content = contentRect({ left: 0, top: 0, width: 1920, height: 1200 });
    expect(content.height).toBeCloseTo(1080, 0);
    expect(content.top).toBeCloseTo(60, 0);
  });

  it("rejects clicks outside the client in every listed mode", () => {
    for (const { client } of CLIENTS) {
      expect(clampToRect(client.left - 20, client.top + 10, client)).toBeNull();
      expect(clampToRect(client.left + client.width + 20, client.top + 10, client)).toBeNull();
      const cx = client.left + Math.floor(client.width / 2);
      const cy = client.top + Math.floor(client.height / 2);
      expect(clampToRect(cx, cy, client)).toEqual({ x: cx, y: cy });
    }
  });

  it("summarizes layout for the previously measured live window", () => {
    const summary = layoutSummary({ left: 491, top: 195, width: 1280, height: 720 }, 1920, 1080);
    expect(summary.mode).toBe("windowed");
    expect(summary.content.width).toBe(1280);
    expect(summary.inventoryRegion.w).toBeGreaterThan(100);
  });

  it("maps 1080p DPI-unaware reports onto 4K windowed fullscreen", () => {
    const physical = resolvePhysicalClient(
      { left: 736, top: 292, width: 1920, height: 1080 },
      3840,
      2160,
    );
    expect(physical).toEqual({ left: 0, top: 0, width: 3840, height: 2160 });
    expect(allCellsInside(inventoryGrid(physical), physical)).toBe(true);
    expect(displayMode(physical, 3840, 2160)).toBe("fullscreen");
  });

  it("maps a 4K game on a non-primary monitor to that monitor origin", () => {
    const origin = { left: 3840, top: 0 };
    const physical = resolvePhysicalClient(
      { left: 3840, top: 0, width: 1920, height: 1080 },
      3840,
      2160,
      origin,
    );
    expect(physical).toEqual({ left: 3840, top: 0, width: 3840, height: 2160 });
    expect(displayMode(physical, 3840, 2160, origin)).toBe("fullscreen");
    expect(allCellsInside(inventoryGrid(physical), physical)).toBe(true);
  });

  it("picks the monitor that contains the game window", () => {
    const monitors = [
      { id: 0, label: "primary", left: 0, top: 0, width: 1920, height: 1080, primary: true },
      { id: 1, label: "game", left: 1920, top: 0, width: 3840, height: 2160 },
    ];
    expect(suggestMonitor(monitors, { left: 2000, top: 10, width: 1920, height: 1080 })?.id).toBe(1);
    expect(suggestMonitor(monitors)?.id).toBe(0);
  });
});
