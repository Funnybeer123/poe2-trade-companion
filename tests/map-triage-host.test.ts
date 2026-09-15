import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const hostScript = path.resolve("scripts/win-input-host.ps1");

/**
 * Parse the real host, then run only its guard functions and two batch bodies
 * against inert replacements. No host main loop, game process, clipboard, or
 * user32 import executes. This tests actual PowerShell control flow and finally
 * blocks, including cancellation after only part of a batch was emitted.
 */
const offlineProbe = String.raw`
param([string]$HostScript)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($HostScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = @("Update-GuardedInputState", "Wait-GuardedInputReady", "Wait-GuardedInputDelay", "Test-GeneratedInput", "Test-EmergencyStopChord")
foreach ($definition in $ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $functions
}, $true)) { Invoke-Expression $definition.Extent.Text }

Add-Type @"
using System;
using System.Collections.Generic;
public class AssistiveWin {
  public static List<string> Events = new List<string>();
  public static int Clicks, Copies, Moves;
  public static bool Ctrl;
  public static bool EmergencyDown;
  public static bool SetCursorPos(int x, int y) { Moves++; Events.Add("move"); return true; }
  public static IntPtr GetForegroundWindow() { return new IntPtr(1); }
  public static short GetAsyncKeyState(int key) {
    return EmergencyDown && (key == 17 || key == 16 || key == 27) ? unchecked((short)0x8000) : (short)0;
  }
  public static void keybd_event(int key, int scan, int flags, UIntPtr extra) {
    Events.Add("key:" + key + ":" + flags);
    if (key == 17) Ctrl = flags == 0;
    if (key == 67 && flags == 0) Copies++;
  }
  public static void mouse_event(int flags, int x, int y, int data, UIntPtr extra) {
    Events.Add("mouse:" + flags);
    if (flags == 4) Clicks++;
  }
  public static void Reset() { Events.Clear(); Clicks = Copies = Moves = 0; Ctrl = false; }
}
"@
function Start-Sleep([int]$Milliseconds) { [AssistiveWin]::Events.Add("wait:$Milliseconds") }
function Emit($value) { $script:Reply = $value }
function Get-Clipboard {
  if ($script:Clipboard -like "poe2-identify-*" -and [AssistiveWin]::Copies -gt $script:LastCopy) {
    $script:LastCopy = [AssistiveWin]::Copies
    $script:Clipboard = "Item Class: Rings" + [Environment]::NewLine + "Rarity: Rare" + [Environment]::NewLine + "Dusk Loop"
    if ($script:Mode -eq "id-unid") { $script:Clipboard += [Environment]::NewLine + "Unidentified" }
    if ($script:Mode -eq "id-empty") { $script:Clipboard = "" }
    if ($script:Mode -eq "id-unknown") { $script:Clipboard = "unrecognized tooltip" }
    if ($script:Mode -eq "id-wrong-class") { $script:Clipboard = $script:Clipboard.Replace("Rings", "Boots") }
  }
  if ($script:Clipboard -eq "sentinel" -and [AssistiveWin]::Copies -gt $script:LastCopy) {
    $script:LastCopy = [AssistiveWin]::Copies
    $script:Clipboard = "Item Class: Rings"
  }
  return $script:Clipboard
}
function Set-Clipboard([string]$Value) { $script:Clipboard = $Value }
function Get-GuardedInputSample([IntPtr]$target, [bool]$checkFocus) {
  $script:Samples++
  if ($script:Mode -eq "pause-resume") {
    $pauseDown = $script:Samples -eq 1 -or $script:Samples -eq 2 -or $script:Samples -eq 4
    return @{ stopDown = $false; emergencyDown = $false; pauseDown = $pauseDown; foreground = $true }
  }
  $stop = ($script:Mode -eq "stop-click" -and [AssistiveWin]::Clicks -ge 1) -or
    ($script:Mode -eq "id-stop" -and [AssistiveWin]::Clicks -ge 1) -or
    ($script:Mode -eq "stop-copy" -and [AssistiveWin]::Moves -ge 2) -or
    ($script:Mode -eq "stop-ctrl" -and [AssistiveWin]::Ctrl)
  $focus = -not (($script:Mode -eq "focus-copy" -and [AssistiveWin]::Moves -ge 2) -or
    ($script:Mode -eq "id-focus" -and [AssistiveWin]::Clicks -ge 1))
  return @{ stopDown = $stop; emergencyDown = $false; pauseDown = $false; foreground = $focus }
}
$batches = @{}
foreach ($name in @("copysweep", "clickburst", "identifyburst", "waitkey")) {
  $condition = '$op -eq "' + $name + '"'
  $node = $ast.FindAll({ param($candidate)
    $candidate -is [System.Management.Automation.Language.IfStatementAst] -and
      $candidate.Clauses[0].Item1.Extent.Text -eq $condition
  }, $true) | Select-Object -First 1
  if (-not $node) { throw "batch not found: $name" }
  $batches[$name] = [scriptblock]::Create('foreach ($batchOnce in @(1)) { ' + $node.Extent.Text + ' }')
}
function Invoke-Batch([string]$operation, [string]$mode, [bool]$guardedValue) {
  [AssistiveWin]::Reset()
  $script:GuardedInputState = @{ stopped = ""; paused = $false; pauseDown = $false }
  $script:Mode = $mode
  $script:Samples = 0
  $script:Clipboard = "original clipboard"
  $script:LastCopy = 0
  $script:Reply = $null
  $op = $operation
  $guarded = $guardedValue
  $requireForeground = $guardedValue
  $focused = $true
  $hwnd = [IntPtr]1
  $r = @{ left = 0; top = 0; width = 100; height = 100 }
  $cmd = @{ points = @(@{x=20;y=20;itemClass="rInGs"}, @{x=40;y=40;itemClass="Rings"}, @{x=60;y=60;itemClass="Rings"}); gapMs = 80; sentinel = "sentinel"; shift = $true }
  if ($operation -ne "clickburst" -or $mode -eq "drop-hover") { $cmd.hoverMs = 100 }
  & $batches[$operation]
  $latched = $false
  try { Wait-GuardedInputReady $hwnd $false } catch { $latched = $true }
  return @{ reply = $script:Reply; events = @([AssistiveWin]::Events); clipboard = $script:Clipboard;
    copies = [AssistiveWin]::Copies; clicks = [AssistiveWin]::Clicks; latched = $latched; samples = $script:Samples }
}
$result = @{}
$state = @{ stopped = ""; paused = $false; pauseDown = $false }
$states = @()
foreach ($down in @($true, $true, $false, $true, $false)) {
  $state = Update-GuardedInputState $state $false $false $down $true
  $states += $state
}
$result.pauseStates = $states
$paused = @{ stopped = ""; paused = $true; pauseDown = $false }
$result.stopWhilePaused = Update-GuardedInputState $paused $true $false $false $true
$result.emergency = Update-GuardedInputState $state $false $true $false $true
$result.latchPersists = Update-GuardedInputState $result.emergency $false $false $false $true
$result.focusWhilePaused = Update-GuardedInputState $paused $false $false $false $false
$result.stopClick = Invoke-Batch "clickburst" "stop-click" $true
$result.stopCopy = Invoke-Batch "copysweep" "stop-copy" $true
$result.focusCopy = Invoke-Batch "copysweep" "focus-copy" $true
$result.stopCtrl = Invoke-Batch "copysweep" "stop-ctrl" $true
$result.legacyClick = Invoke-Batch "clickburst" "stop-click" $false
$result.legacyCopy = Invoke-Batch "copysweep" "stop-copy" $false
$result.dropHover = Invoke-Batch "clickburst" "drop-hover" $true
$result.identify = @{}
foreach ($mode in @("id-good", "id-unid", "id-empty", "id-unknown", "id-wrong-class", "id-stop", "id-focus")) {
  $result.identify[$mode] = Invoke-Batch "identifyburst" $mode $true
}
$script:GuardedInputState = @{ stopped = ""; paused = $false; pauseDown = $false }
$script:Mode = "pause-resume"
$script:Samples = 0
Wait-GuardedInputReady ([IntPtr]1) $true
$result.pauseResume = @{ state = $script:GuardedInputState; samples = $script:Samples }
$op = "waitkey"
$hwnd = [IntPtr]2 # intentionally not foreground: emergency stop is global
[AssistiveWin]::EmergencyDown = $true
$cmd = @{ timeoutMs = 100; emergencyStop = $true }
& $batches["waitkey"]
$result.controlEmergency = $script:Reply
$cmd = @{ timeoutMs = 100 }
& $batches["waitkey"]
$result.legacyControl = $script:Reply
[AssistiveWin]::EmergencyDown = $false
$result.generated = @{}
foreach ($operation in @("click", "focus", "copysweep", "clickburst", "identifyburst", "hotkey", "capture", "rect", "hidemark")) {
  $result.generated[$operation] = Test-GeneratedInput $operation @{}
}
$result | ConvertTo-Json -Depth 10 -Compress
`;

interface GuardState {
  stopped: string;
  paused: boolean;
}
interface BatchResult {
  reply: { ok: boolean; error?: string; count: number; texts?: string[]; verificationFailed?: boolean };
  events: string[];
  clipboard: string;
  copies: number;
  clicks: number;
  latched: boolean;
  samples: number;
}
interface ProbeResult {
  pauseStates: GuardState[];
  stopWhilePaused: GuardState;
  emergency: GuardState;
  latchPersists: GuardState;
  focusWhilePaused: GuardState;
  stopClick: BatchResult;
  stopCopy: BatchResult;
  focusCopy: BatchResult;
  stopCtrl: BatchResult;
  legacyClick: BatchResult;
  legacyCopy: BatchResult;
  dropHover: BatchResult;
  identify: Record<string, BatchResult>;
  pauseResume: { state: GuardState; samples: number };
  controlEmergency: { ok: boolean; key?: number; error?: string };
  legacyControl: { ok: boolean; key?: number; error?: string };
  generated: Record<string, boolean>;
}

describe("map triage host guards", () => {
  it.skipIf(process.platform !== "win32")("stops and pauses real batch code with inert input substitutes", () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "poe2-map-host-test-"));
    const probe = path.join(scratch, "probe.ps1");
    let result: ProbeResult;
    try {
      writeFileSync(probe, offlineProbe);
      const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe, "-HostScript", hostScript], {
        encoding: "utf8", windowsHide: true, timeout: 15_000,
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      result = JSON.parse(run.stdout.trim()) as ProbeResult;
    } finally {
      rmSync(probe, { force: true });
      rmdirSync(scratch);
    }
    expect(result.pauseStates.map((state) => state.paused)).toEqual([true, true, true, false, false]);
    expect(result.pauseResume).toMatchObject({ state: { stopped: "", paused: false }, samples: 4 });
    for (const state of [result.stopWhilePaused, result.emergency, result.latchPersists]) {
      expect(state.stopped).toBe("stop-requested");
    }
    expect(result.focusWhilePaused.stopped).toBe("focus-lost");
    expect(result.controlEmergency).toEqual({ ok: true, key: 0 });
    expect(result.legacyControl).toEqual({ ok: false, error: "timeout" });
    expect(result.stopClick.reply).toMatchObject({ ok: false, error: "stop-requested", count: 1 });
    expect(result.stopClick.clicks).toBe(1);
    expect(result.stopClick.events.at(-1)).toBe("key:16:2");
    expect(result.stopClick.latched).toBe(true);
    for (const [batch, error] of [[result.stopCopy, "stop-requested"], [result.focusCopy, "focus-lost"]] as const) {
      expect(batch.reply).toMatchObject({ ok: false, error, count: 1 });
      expect(batch.copies).toBe(1);
      expect(batch.clipboard).toBe("original clipboard");
      expect(batch.latched).toBe(true);
    }
    expect(result.stopCtrl.reply).toMatchObject({ ok: false, error: "stop-requested", count: 0 });
    expect(result.stopCtrl.copies).toBe(0);
    expect(result.stopCtrl.events.at(-1)).toBe("key:17:2");
    expect(result.stopCtrl.clipboard).toBe("original clipboard");
    for (const batch of [result.legacyClick, result.legacyCopy]) {
      expect(batch.reply).toMatchObject({ ok: true, count: 3 });
      expect(batch.samples).toBe(0);
      expect(batch.latched).toBe(false);
    }
    const hoverWaits = (events: string[]): number[] => {
      const waits: number[] = [];
      let hover = 0;
      let moved = false;
      for (const event of events) {
        if (event === "move") { hover = 0; moved = true; }
        else if (moved && event.startsWith("wait:")) hover += Number(event.slice(5));
        else if (event === "mouse:2") { waits.push(hover); moved = false; }
      }
      return waits;
    };
    expect(hoverWaits(result.legacyClick.events)).toEqual([14, 14, 14]);
    expect(result.dropHover.reply).toMatchObject({ ok: true, count: 3 });
    expect(hoverWaits(result.dropHover.events)).toEqual([100, 100, 100]);
    expect(result.generated).toEqual({ click: true, focus: true, copysweep: true, clickburst: true, identifyburst: true, hotkey: true,
      capture: false, rect: false, hidemark: false });
    const identify = result.identify;
    expect(identify["id-good"].reply).toMatchObject({ ok: true, count: 3, verificationFailed: false });
    expect(identify["id-good"].copies).toBe(3);
    for (const mode of ["id-unid", "id-empty", "id-unknown", "id-wrong-class"]) {
      expect(identify[mode].reply).toMatchObject({ ok: true, count: 1, verificationFailed: true });
      expect(identify[mode].reply.texts).toHaveLength(1);
      expect(identify[mode].clicks).toBe(1);
    }
    for (const [mode, error] of [["id-stop", "stop-requested"], ["id-focus", "focus-lost"]]) {
      expect(identify[mode].reply).toMatchObject({ ok: false, count: 1, error });
      expect(identify[mode].clicks).toBe(1);
      expect(identify[mode].latched).toBe(true);
    }
    for (const batch of Object.values(identify)) {
      expect(batch.events.filter((event) => event === "key:16:0")).toHaveLength(1);
      expect(batch.events.filter((event) => event === "key:16:2")).toHaveLength(1);
      expect(batch.events.at(-1)).toBe("key:16:2");
      expect(batch.clipboard).toBe("original clipboard");
    }
  }, 20_000);

  it("keeps batch guards opt-in and blocks input before explicit focus", () => {
    const source = readFileSync(hostScript, "utf8");
    expect(source.indexOf("if (Test-GeneratedInput $op $cmd)")).toBeLessThan(source.indexOf('if ($op -eq "rect" -or $op -eq "focus")'));
    expect(source).toContain("$guarded = [bool]$cmd.guarded");
    expect(source).toContain("$requireForeground = [bool]$cmd.requireForeground -or $guarded");
  });
});
