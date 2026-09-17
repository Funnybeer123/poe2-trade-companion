import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { resolveWinHostScript } from "../../src/adapters/bagWinHost.js";
import { visibleLife } from "../../src/core/bagPixels.js";

const native = describe.skipIf(process.platform !== "win32");
const savedHud = process.env.POE2_BAG_HUD_FIXTURE ?? path.resolve("artifacts/map-triage/live-adapter/bag-01.jsonl.evidence/frame-974f225e-f833-493f-b0c9-def5028b3a2e-00000.bmp");

native("bag native interlocks", () => {
  it("parses PowerShell and runs the actual C# interlock with injected input and time", () => {
    const script = resolveWinHostScript("win-bag-host.ps1").replaceAll("'", "''");
    const command = `
$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
& '${script}' -SelfTest
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim()) as { ok: boolean; tests: string[]; nativeInput: boolean };
    expect(outcome.ok).toBe(true);
    expect(outcome.nativeInput).toBe(false);
    expect(outcome.tests).toEqual([
      "chord-release-on-stop", "chord-release-on-insert-stop", "chord-release-on-ctrl-shift-esc", "chord-release-on-external-stop", "chord-release-on-pause", "chord-release-on-parent",
      "chord-release-on-focus", "chord-release-on-throw", "left-release-on-stop", "right-release-on-stop", "modified-click-release", "shift-chain-release-and-count", "read-item-sequence-bound", "elapsed-scheduler-waits",
      "focus-required", "pause-edge-and-no-input", "stop-latched", "user-modifiers-and-buttons-reject-input", "explicit-focus-guarded", "explicit-focus-deferred-and-bounded", "cursor-rgba-lossless", "cursor-frame-binding", "copy-position-bound-before-c", "exact-process-allowlist",
    ]);
  }, 25_000);

  it("starts the native monitor, rejects unpinned input, and closes through JSON without a game", () => {
    const script = resolveWinHostScript("win-bag-host.ps1");
    // These commands fail before resolving a game window or emitting input.
    const commands = [
      { op: "state", monitorOnly: true }, { op: "click", x: 1, y: 1 }, { op: "rightclick" },
      { op: "hotkey", keys: "ctrlc" }, { op: "move", x: 1, y: 1 },
      { op: "setclipboard", text: "must never reach clipboard" }, { op: "focus" }, { op: "quit" },
    ];
    const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentProcessId", String(process.pid)], {
      input: commands.map(command => JSON.stringify(command)).join("\n") + "\n",
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(commands.length);
    expect(responses[0]).toMatchObject({ ok: true, nativeMonitorReady: true, parentProcessId: process.pid });
    for (const response of responses.slice(1, 7)) expect(response).toMatchObject({ ok: false, error: "expected-hwnd-required" });
    expect(responses[7]).toMatchObject({ ok: true });
  }, 25_000);

  it("acknowledges cancellation on the native thread while the command reader is idle", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "poe2-bag-native-test-"));
    const stopFile = path.join(temporary, "stop");
    const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", resolveWinHostScript("win-bag-host.ps1"), "-ParentProcessId", String(process.pid), "-StopFile", stopFile], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("native-monitor-start-timeout")), 10_000);
        lines.once("line", line => { clearTimeout(timer); resolve(JSON.parse(line) as Record<string, unknown>); });
        child.once("error", reject);
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`native-monitor-exited:${code}`)); });
      });
      child.stdin.write(JSON.stringify({ op: "state", monitorOnly: true }) + "\n");
      expect(await ready).toMatchObject({ ok: true, nativeMonitorReady: true });
      writeFileSync(stopFile, "stop");
      const started = performance.now();
      while (!existsSync(stopFile + ".ack") && performance.now() - started < 2_000) await delay(10);
      expect(existsSync(stopFile + ".ack")).toBe(true);
      const stopped = new Promise<Record<string, unknown>>(resolve => lines.once("line", line => resolve(JSON.parse(line) as Record<string, unknown>)));
      child.stdin.write(JSON.stringify({ op: "state", monitorOnly: true }) + "\n");
      expect(await stopped).toMatchObject({ ok: true, stopped: true, stopReason: "host-cancelled" });
    } finally {
      if (child.exitCode === null) child.stdin.end("quit\n");
      await exited;
      lines.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 25_000);

  it("OCRs a saved bitmap with client coordinates without recapturing the desktop", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "poe2-bag-ocr-test-"));
    const fixture = path.join(temporary, "scene.bmp").replaceAll("'", "''");
    const script = resolveWinHostScript("win-bag-host.ps1").replaceAll("'", "''");
    const command = `
. '${script}' -OfflineOcr
$image = New-Object System.Drawing.Bitmap 800, 200
$graphics = [System.Drawing.Graphics]::FromImage($image)
$font = New-Object System.Drawing.Font 'Arial', 28
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('Life 100 / 100', $font, [System.Drawing.Brushes]::Black, 100, 60)
  $image.Save('${fixture}', [System.Drawing.Imaging.ImageFormat]::Bmp)
} finally { $font.Dispose(); $graphics.Dispose(); $image.Dispose() }
$result = Invoke-BagOcr ([pscustomobject]@{ path = '${fixture}'; left = 80; top = 40; width = 600; height = 120 })
Emit-Bag $result
`;
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
        input: "quit\n", encoding: "utf8", timeout: 20_000, windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const recognized = JSON.parse(result.stdout.trim()) as { text: string; coordinateSpace: string; lines: { x: number; y: number; w: number; h: number; words: { x: number; y: number }[] }[] };
      expect(recognized.text).toContain("Life 100 / 100");
      expect(recognized.coordinateSpace).toBe("client");
      expect(recognized.lines[0]!.words[0]!.x).toBeGreaterThanOrEqual(100);
      expect(recognized.lines[0]!.words[0]!.y).toBeGreaterThanOrEqual(60);
      expect(recognized.lines[0]!.x).toBe(recognized.lines[0]!.words[0]!.x);
      expect(recognized.lines[0]!.w).toBeGreaterThan(100);
      expect(recognized.lines[0]!.h).toBeGreaterThan(20);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 25_000);

  it("validates paired finite copy coordinates without loading native input", () => {
    const script = resolveWinHostScript("win-bag-host.ps1").replaceAll("'", "''");
    const command = `
. '${script}' -OfflineOcr
$accepted = Get-BagExpectedCursor ([pscustomobject]@{ expectedCursorX = -100; expectedCursorY = 200 })
$rejected = 0
foreach ($case in @(
  [pscustomobject]@{ expectedCursorX = 100 },
  [pscustomobject]@{ expectedCursorX = 100; expectedCursorY = $null },
  [pscustomobject]@{ expectedCursorX = '100'; expectedCursorY = 200 },
  [pscustomobject]@{ expectedCursorX = 100.5; expectedCursorY = 200 },
  [pscustomobject]@{ expectedCursorX = [double]::NaN; expectedCursorY = 200 },
  [pscustomobject]@{ expectedCursorX = 100; expectedCursorY = [double]::PositiveInfinity },
  [pscustomobject]@{ expectedCursorX = 2147483648; expectedCursorY = 200 }
)) {
  try { $null = Get-BagExpectedCursor $case }
  catch { if ($_.Exception.Message -in @('expected-cursor-pair-required', 'expected-cursor-integer-required')) { $rejected++ } else { throw } }
}
Emit-Bag @{ accepted = $accepted; rejected = $rejected; nativeMonitor = $null -ne $script:BagGuard }
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ accepted: { x: -100, y: 200 }, rejected: 7, nativeMonitor: false });
  }, 25_000);

  it.skipIf(!existsSync(savedHud))("reads exact Life values from the private saved HUD without retaining padding words", () => {
    const script = resolveWinHostScript("win-bag-host.ps1").replaceAll("'", "''");
    const fixture = savedHud.replaceAll("'", "''");
    // This optional local regression uses an ignored recording. CI does not
    // acquire user screenshots, and offline mode cannot inspect the live game.
    const command = `
. '${script}' -OfflineOcr
$before = [BagNative]::Hash([System.IO.File]::ReadAllBytes('${fixture}'))
$attempts = @()
foreach ($scale in @(1, 2)) {
  $attempts += Invoke-BagOcr ([pscustomobject]@{ path = '${fixture}'; left = 70; top = 1570; width = 440; height = 60; scale = $scale; textThreshold = 130; neutralContext = $true })
}
$rejectedLiveRead = $false
try { $null = Invoke-BagOcr ([pscustomobject]@{ left = 70; top = 1570; width = 440; height = 60 }) }
catch { $rejectedLiveRead = $_.Exception.Message -eq 'offline-ocr-requires-saved-image' }
Emit-Bag @{ attempts = $attempts; sourceUnchanged = $before -eq [BagNative]::Hash([System.IO.File]::ReadAllBytes('${fixture}')); rejectedLiveRead = $rejectedLiveRead }
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const recorded = JSON.parse(result.stdout.trim()) as {
      sourceUnchanged: boolean; rejectedLiveRead: boolean;
      attempts: { text: string; coordinateSpace: string; lines: { x: number; y: number; w: number; h: number; text: string }[] }[];
    };
    expect(recorded.sourceUnchanged).toBe(true);
    expect(recorded.rejectedLiveRead).toBe(true);
    expect(recorded.attempts).toHaveLength(2);
    for (const attempt of recorded.attempts) {
      expect(attempt.text).toBe("Life 2,599/2,599");
      expect(visibleLife(attempt.text)).toBe(true);
      expect(attempt.coordinateSpace).toBe("client");
      expect(attempt.lines).not.toHaveLength(0);
      for (const line of attempt.lines) {
        expect(line.text).not.toContain("sample");
        expect(line.x).toBeGreaterThanOrEqual(70); expect(line.x + line.w).toBeLessThanOrEqual(510);
        expect(line.y).toBeGreaterThanOrEqual(1570); expect(line.y + line.h).toBeLessThanOrEqual(1630);
      }
    }
  }, 25_000);
});
