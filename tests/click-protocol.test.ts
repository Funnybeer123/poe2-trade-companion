import { existsSync, readFileSync } from "node:fs";
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
    expect(source).toContain("keybd_event(0x11, 0, 0");
    expect(source).toContain("[bool]$cmd.shift");
    expect(source).toContain("keybd_event(0x10, 0, 0");
    expect(source).toContain("[bool]$cmd.requireForeground");
    expect(source).toContain('error = "focus-lost"');
    expect(source).toContain('error = "unsupported-hotkey"');
    expect(source).toContain('if ($op -eq "rightclick")');
    expect(source).toContain("mouse_event(0x0008");
    expect(source).toContain("Resolve-PinnedPoeWindow");
    expect(source).toContain('"target-window-lost"');
    expect(source).toContain("hwnd = $script:PinnedPoeHwnd");
  });

  it("resolves the Windows input host from the repo, not the parent folder", () => {
    const host = resolveWinHostScript();
    expect(existsSync(host)).toBe(true);
    expect(host.replaceAll("\\", "/")).toMatch(/poe2-trade-companion\/scripts\/win-input-host\.ps1$/i);
  });
});
