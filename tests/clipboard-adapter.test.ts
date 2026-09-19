import { describe, expect, it, vi } from "vitest";
import { clipboard } from "electron";
import { readClipboardText } from "../src/adapters/clipboard.js";

vi.mock("electron", () => ({ clipboard: { readText: vi.fn() } }));

describe("asynchronous Electron clipboard adapter", () => {
  it("resolves the clipboard contents rather than passing a promise as item text", async () => {
    vi.mocked(clipboard.readText).mockResolvedValue("Item Class: Rings");
    await expect(readClipboardText()).resolves.toBe("Item Class: Rings");
  });
  it("propagates a denied clipboard read without fabricating empty contents", async () => {
    vi.mocked(clipboard.readText).mockRejectedValue(new Error("Clipboard unavailable"));
    await expect(readClipboardText()).rejects.toThrow("Clipboard unavailable");
  });
});
