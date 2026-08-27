import { describe, expect, it } from "vitest";
import { resolveBuildMode, RuntimeCapabilities } from "../src/core/capabilities.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { evaluateSafety } from "../src/core/safety.js";
import { clampToRect } from "../src/core/screenLayout.js";
import { inventoryGrid, shouldKeepInInventory } from "../src/core/stashAssist.js";

describe("capabilities and safety", () => {
  it("defaults unknown builds to the full companion", () => {
    expect(resolveBuildMode(undefined)).toBe("authorized-qa");
  });

  it("cannot arm automation without an allowlist and emergency stop", () => {
    const caps = new RuntimeCapabilities({
      mode: "authorized-qa",
      buildAllowsQa: false,
      qaAcknowledged: false,
      assistiveAcknowledged: false,
      allowlist: [],
      bannerVisible: false,
      emergencyStopRegistered: false,
    });
    expect(caps.canArmAutomation()).toBe(false);
    expect(caps.mode).toBe("authorized-qa");
  });

  it("arms when allowlist and emergency stop are set", () => {
    const caps = new RuntimeCapabilities({
      mode: "public-companion",
      buildAllowsQa: false,
      qaAcknowledged: false,
      assistiveAcknowledged: false,
      allowlist: ["PathOfExile.exe"],
      bannerVisible: false,
      emergencyStopRegistered: true,
    });
    expect(caps.canArmAutomation()).toBe(true);
    expect(caps.isProcessAllowed("PathOfExile.exe")).toBe(true);
    expect(caps.isProcessAllowed("notepad.exe")).toBe(false);
    expect(caps.isProcessAllowed("NotPathOfExile.exe")).toBe(false);
    const emptyAllowlist = new RuntimeCapabilities({
      mode: "authorized-qa",
      buildAllowsQa: true,
      qaAcknowledged: true,
      assistiveAcknowledged: false,
      allowlist: [""],
      bannerVisible: true,
      emergencyStopRegistered: true,
    });
    expect(emptyAllowlist.isProcessAllowed("PathOfExile.exe")).toBe(false);
  });

  it("arms assistive access with the same process allowlist", () => {
    const caps = new RuntimeCapabilities({
      mode: "assistive-access",
      buildAllowsQa: false,
      qaAcknowledged: false,
      assistiveAcknowledged: true,
      allowlist: ["PathOfExileSteam.exe"],
      bannerVisible: true,
      emergencyStopRegistered: true,
    });
    expect(caps.mode).toBe("assistive-access");
    expect(caps.canArmAutomation()).toBe(true);
    expect(
      evaluateSafety({
        mode: "assistive-access",
        killSwitchLatched: false,
        dryRun: false,
        processAllowed: true,
        moduleEnabled: true,
        confidence: 1,
        confidenceThreshold: 0.1,
        actionsThisMinute: 0,
        actionsPerMinute: 120,
      }).allow,
    ).toBe(true);
  });

  it("latches kill switch until rearm", () => {
    const ks = new KillSwitch();
    ks.trip();
    expect(ks.isLatched()).toBe(true);
    ks.rearm();
    expect(ks.isLatched()).toBe(false);
  });

  it("allows companion input when the process is allowlisted", () => {
    const decision = evaluateSafety({
      mode: "public-companion",
      killSwitchLatched: false,
      dryRun: false,
      processAllowed: true,
      moduleEnabled: true,
      confidence: 1,
      confidenceThreshold: 0.1,
      actionsThisMinute: 0,
      actionsPerMinute: 30,
    });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("ok");
  });

  it("builds an inventory grid and keep policy", () => {
    const cells = inventoryGrid({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(cells).toHaveLength(60);
    expect(shouldKeepInInventory("keep")).toBe(true);
    expect(shouldKeepInInventory("dump")).toBe(false);
    expect(clampToRect(100, 100, { left: 0, top: 0, width: 200, height: 200 })).toEqual({ x: 100, y: 100 });
    expect(clampToRect(-1, 10, { left: 0, top: 0, width: 200, height: 200 })).toBeNull();
  });
});
