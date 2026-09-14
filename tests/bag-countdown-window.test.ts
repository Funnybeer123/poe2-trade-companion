import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import { prepareBagCountdownWindow } from "../src/main/bagCountdownWindow.js";
import { installWindowActivation } from "../src/main/windowActivation.js";

it("releases the topmost companion and minimizes before the countdown, without restoring on completion", () => {
  const events = new EventEmitter(), calls: string[] = [];
  let minimized = false;
  const window = Object.assign(events, {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    setAlwaysOnTop: vi.fn((enabled: boolean) => calls.push(enabled ? "topmost" : "release")),
    minimize: vi.fn(() => { calls.push("minimize"); minimized = true; events.emit("minimize"); }),
    restore: vi.fn(), show: vi.fn(), focus: vi.fn(), moveTop: vi.fn(),
  });
  // Exercise the same activation listener that previously left the companion
  // covering the game; minimizing must not trigger restore or activation.
  installWindowActivation(window as unknown as BrowserWindow);
  prepareBagCountdownWindow(window, "countdown");
  expect(calls.slice(0, 2)).toEqual(["release", "minimize"]);
  expect(calls).not.toContain("topmost");
  expect(window.minimize).toHaveBeenCalledOnce();
  for (const phase of ["running", "stopping", "complete", "error", "idle"] as const) prepareBagCountdownWindow(window, phase);
  expect(window.minimize).toHaveBeenCalledOnce();
  expect(window.restore).not.toHaveBeenCalled(); expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled();
});

it("handles repeated countdown events, minimized windows, and a closed window", () => {
  let destroyed = false;
  const window = { isDestroyed: () => destroyed, isMinimized: () => true, setAlwaysOnTop: vi.fn(), minimize: vi.fn() };
  prepareBagCountdownWindow(undefined, "countdown");
  prepareBagCountdownWindow(window, "countdown");
  prepareBagCountdownWindow(window, "countdown");
  expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(2);
  expect(window.minimize).not.toHaveBeenCalled();
  destroyed = true;
  prepareBagCountdownWindow(window, "countdown");
  expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(2);
});
