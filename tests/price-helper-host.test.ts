import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWinHostScript } from "../src/adapters/winHost.js";
describe("native helper path boundary", () => {
  it("does not execute a same-named script planted in the launch directory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "poe-helper-path-test-"));
    mkdirSync(path.join(directory, "scripts"));
    writeFileSync(path.join(directory, "scripts", "win-price-helper.ps1"), "untrusted file; never execute");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try { expect(resolveWinHostScript("win-price-helper.ps1")).not.toContain(directory); }
    finally { cwd.mockRestore(); }
    expect(() => resolveWinHostScript("../../untrusted.ps1")).toThrow("Unsupported");
  });
  it("ships a capture-only host without input, network or file-write primitives", () => {
    const source = readFileSync(resolveWinHostScript("win-price-helper.ps1"), "utf8");
    expect(source).not.toMatch(/\b(?:SendInput|keybd_event|mouse_event|SetCursorPos|WriteProcessMemory|Invoke-WebRequest|Invoke-RestMethod|WriteAllBytes|WriteAllText)\b/);
    expect(source).toContain("Assert-PriceForeground $target");
  });
});
