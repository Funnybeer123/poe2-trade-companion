import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWinHostScript } from "../src/adapters/winHost.js";
import { clampToRect } from "../src/core/screenLayout.js";

describe("live click protocol", () => {
  it("host must reject coordinates outside the reported client", () => {
    const client = { left: 491, top: 195, width: 1280, height: 720 };
    const pad = 8;
    const outside = [
      { x: client.left - 1, y: client.top + 50 },
      { x: client.left + client.width + 1, y: client.top + 50 },
      { x: 0, y: 0 },
    ];
    for (const point of outside) {
      expect(clampToRect(point.x, point.y, client, pad)).toBeNull();
    }
  });

  it("hosts a single ctrl-held burst so fill and deposit do not refocus per click", () => {
    const source = readFileSync(resolveWinHostScript(), "utf8");
    expect(source).toContain('if ($op -eq "ctrlburst")');
    expect(source).toContain('if ($op -eq "shiftburst")');
    expect(source).toContain('if ($op -eq "orbbatch")');
    expect(source).toContain('if ($op -eq "vaalburst")');
    expect(source).toContain("Copy-HoveredItemText");
    expect(source).toContain("Can be used in a Map Device");
    expect(source).toContain("Test-WaystoneCopyComplete");
    expect(source).toContain("[bool]$fast");
    expect(source).toContain("Test-CurrencyCopyComplete");
    expect(source).toContain("Test-HeldExpectedOrb");
    expect(source).toContain("Test-HeldWaystone");
    expect(source).toContain("emptyCursor");
    expect(source).toContain("heldWaystone");
    expect(source).toContain("$cmd.probeX");
    expect(source).toContain("$cmd.expect");
    expect(source).toContain("$pickupMs");
    expect(source).toContain("Test-ItemTextCorrupted");
    expect(source).toContain("Test-WaystoneTier15");
    expect(source).toContain("stillClean");
    expect(source).toContain("$retries");
    expect(source).toContain("(?m)^\\s*(?:Twice\\s+)?Corrupted\\s*$");
    expect(source).toContain("orbbatch-pickup-required");
    expect(source).toContain("$cmd.pickups");
    expect(source).toContain("[bool]$cmd.putBack");
    expect(source).toContain("$hasPickup");
    expect(source).toContain("keybd_event(0x11, 0, 0");
    expect(source).toContain("[bool]$cmd.shift");
    expect(source).toContain("keybd_event(0x10, 0, 0");
    expect(source).toContain("[bool]$cmd.requireForeground");
    expect(source).toContain('error = "focus-lost"');
    expect(source).toContain('error = "unsupported-hotkey"');
    expect(source).toContain('if ($op -eq "rightclick")');
    expect(source).toContain("mouse_event(0x0008");
    expect(source).toMatch(/if \(\$op -eq "rightclick"\)[\s\S]*\$shift = \[bool\]\$cmd\.shift/);
    expect(source).toContain("Resolve-PinnedPoeWindow");
    expect(source).toContain('"target-window-lost"');
    expect(source).toContain("hwnd = $script:PinnedPoeHwnd");
  });

  it("resolves the Windows input host from the repo, not the parent folder", () => {
    const host = resolveWinHostScript();
    expect(existsSync(host)).toBe(true);
    expect(host).toBe(fileURLToPath(new URL("../scripts/win-input-host.ps1", import.meta.url)));
  });
});
