import { describe, expect, it, vi } from "vitest";
import { sendRendererEvent } from "../src/main/rendererEvents.js";

describe("renderer events during shutdown", () => {
  it("ignores service events after the main-window reference has been cleared", () => {
    expect(() => sendRendererEvent(undefined, "scanner:event", { type: "stopped" })).not.toThrow();
  });
  it("does not access webContents on a destroyed BrowserWindow", () => {
    const window = {
      isDestroyed: () => true,
      get webContents(): never { throw new Error("Object has been destroyed"); },
    };
    expect(() => sendRendererEvent(window, "assistive:event", { running: false })).not.toThrow();
  });
  it("skips events when webContents is destroyed before its BrowserWindow", () => {
    const send = vi.fn(() => { throw new Error("Object has been destroyed"); });
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send } };
    expect(() => sendRendererEvent(window, "stash-sort:event", { running: false })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves normal payloads and argument-free emergency-stop events", () => {
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
    const event = { running: false };
    sendRendererEvent(window, "scanner:event", event);
    sendRendererEvent(window, "qa:killed");
    expect(send.mock.calls).toEqual([["scanner:event", event], ["qa:killed"]]);
  });
});
