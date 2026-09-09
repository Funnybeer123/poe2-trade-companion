import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installWindowActivation } from "../src/main/windowActivation.js";

function fixture() {
  const events = new EventEmitter();
  let minimized = false;
  let destroyed = false;
  const calls: string[] = [];
  const window = Object.assign(events, {
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    restore: vi.fn(() => { calls.push("restore"); minimized = false; events.emit("restore"); }),
    show: vi.fn(() => { calls.push("show"); }),
    focus: vi.fn(() => { calls.push("focus"); events.emit("focus"); }),
    setAlwaysOnTop: vi.fn((top: boolean) => calls.push(top ? "top" : "normal")),
    moveTop: vi.fn(() => calls.push("raise")),
  });
  const activate = installWindowActivation(window as unknown as BrowserWindow);
  return { window, events, calls, activate, minimize: () => { minimized = true; events.emit("minimize"); }, destroy: () => { destroyed = true; events.emit("closed"); } };
}

describe("companion window activation", () => {
  it("shows the finished window and explicitly raises it before requesting focus", () => {
    const f = fixture();
    expect(f.calls).toEqual([]);
    f.events.emit("ready-to-show");
    expect(f.calls.slice(0, 4)).toEqual(["show", "top", "raise", "focus"]);
    expect(f.window.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });
  it("restores a minimized second launch without recursive activation", () => {
    const f = fixture();
    f.minimize();
    f.calls.length = 0;
    f.activate();
    expect(f.calls.slice(0, 5)).toEqual(["restore", "show", "top", "raise", "focus"]);
    expect(f.window.restore).toHaveBeenCalledOnce();
    expect(f.window.focus).toHaveBeenCalledOnce();
  });
  it("raises taskbar/click focus but lets the user switch back to another window", () => {
    const f = fixture();
    f.events.emit("focus");
    expect(f.calls).toEqual(["top", "raise"]);
    expect(f.window.focus).not.toHaveBeenCalled();
    f.events.emit("blur");
    expect(f.calls.at(-1)).toBe("normal");
    f.events.emit("focus");
    f.minimize();
    expect(f.calls.at(-1)).toBe("normal");
    expect(f.window.focus).not.toHaveBeenCalled();
  });
  it("brings a taskbar restore forward and never manipulates a closed window", () => {
    const f = fixture();
    f.events.emit("restore");
    expect(f.window.show).toHaveBeenCalledOnce();
    expect(f.window.focus).toHaveBeenCalledOnce();
    f.destroy();
    f.calls.length = 0;
    f.activate();
    f.events.emit("restore");
    f.events.emit("focus");
    f.events.emit("blur");
    expect(f.calls).toEqual([]);
  });
});
