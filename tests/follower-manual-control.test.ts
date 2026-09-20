import { expect, it, describe } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWinHostScript } from "../src/adapters/winHost.js";
import { startManualControlMonitor } from "../src/adapters/manualControlMonitor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, "..", "scripts", "win-manual-control.ps1"), "utf8");

describe("the manual-control hotkey host", () => {
  // The same assertion win-follower-host.ps1 carries: a watcher that could also press keys would be a
  // second, unguarded path to the game, outside GameInputController. It reads key state and prints a line.
  it("has no input API at all", () => {
    for (const forbidden of ["SendInput", "mouse_event", "keybd_event", "SetCursorPos", "INPUT"]) {
      expect(source, `win-manual-control.ps1 must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("resumes on the key that is actually reached for, and holds on its own deliberate chord", () => {
    expect(source).toContain("GetAsyncKeyState(0x11)");  // Ctrl
    expect(source).toContain("GetAsyncKeyState(0x10)");  // Shift
    expect(source).toContain("GetAsyncKeyState(0x48)");  // H: hold it for me
    expect(source).toContain("GetAsyncKeyState(0x4D)");  // M: resume
    expect(source).toContain("GetAsyncKeyState(0x46)");  // F: resume too
    // Edge-triggered, so holding a chord acts once rather than fluttering the follower every 8 ms.
    expect(source).toContain("if (take && !wasDown)");
    expect(source).toContain("if (give && !wasGive)");
    // Two separate words, never one "toggle": the operator cannot see the status line, so a toggle made
    // every press a guess and pressing to resume stopped a follower that was already following.
    expect(source).toContain('Console.WriteLine("take")');
    expect(source).toContain('Console.WriteLine("give")');
    expect(source).not.toContain('Console.WriteLine("toggle")');
    // M must RESUME, not hold. Four times it was pressed meaning "go" - the last 16.6 s into a fresh run -
    // and parked a follower that was already following. The binding follows the habit, not the mnemonic.
    const line = (needle: string) => source.split("\n").find(l => l.includes(needle)) ?? "";
    expect(line("bool give =")).toContain("0x4D");
    expect(line("bool take =")).not.toContain("0x4D");
  });

  it("does not collide with the emergency stop or the bag hotkeys", () => {
    // Ctrl+Shift+Esc (0x1B) stops everything; Num0 (0x60), Insert (0x2D) and Num5 (0x65) drive the bag.
    for (const claimed of ["0x1B", "0x60", "0x2D", "0x65"]) expect(source).not.toContain(`GetAsyncKeyState(${claimed})`);
  });

  it("is allowlisted by the native helper resolver, and unknown scripts still are not", () => {
    expect(resolveWinHostScript("win-manual-control.ps1")).toMatch(/win-manual-control\.ps1$/);
    expect(() => resolveWinHostScript("win-anything-else.ps1" as never)).toThrow(/Unsupported native helper script/);
  });
});

it.runIf(process.platform === "win32")("starts an independent native manual-control observer without input", async () => {
  let failed = false;
  const monitor = startManualControlMonitor(() => {}, () => {}, () => { failed = true; });
  try {
    await expect.poll(() => monitor.ready || failed, { timeout: 10000, interval: 25 }).toBe(true);
    expect(failed).toBe(false);
    expect(monitor.ready).toBe(true);
  } finally { monitor.close(); }
  expect(monitor.ready).toBe(false);
}, 15000);
