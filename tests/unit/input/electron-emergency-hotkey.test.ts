import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron emergency-stop hotkey", () => {
  const source = readFileSync(path.join(process.cwd(), "apps/desktop/electron-main.ts"), "utf8");

  it("registers Ctrl+Shift+F12 via globalShortcut and trips the latch", () => {
    expect(source).toMatch(/globalShortcut/);
    expect(source).toMatch(/CommandOrControl\+Shift\+F12/);
    expect(source).toMatch(/emergencyStop\.trip\(/);
    expect(source).toMatch(/registerEmergencyStopHotkey/);
  });

  it("does not import native input on the public start path", () => {
    expect(source).not.toMatch(/@poe2tc\/native-input/);
    expect(source).not.toMatch(/NativeInputSink/);
    expect(source).not.toMatch(/from ["']koffi["']/);
    expect(source).not.toMatch(/uiohook-napi|robotjs|nut-js|@nut-tree/);
  });
});
