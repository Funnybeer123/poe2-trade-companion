import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("overlay smoke", () => {
  it("public UI copy cannot imply arming always works", () => {
    const vue = readFileSync("src/renderer/App.vue", "utf8");
    expect(vue).toContain("Automation on");
    expect(vue).toContain("E-stop ready · Ctrl+Shift+Esc");
    expect(vue).toContain("runtime.isNative.value");
    expect(vue).toContain("<RouterView");
    expect(vue).toContain("Tools &amp; QA");
    const cal = readFileSync("src/renderer/CalibrationPanel.vue", "utf8");
    expect(cal).toContain("Screenshot");
    expect(cal).toContain("Look");
    expect(cal).toContain("Reset");
    expect(cal).toContain("Vendor");
    expect(cal).toContain("Search");
    expect(cal).not.toContain("Stash open");
    expect(cal).not.toContain("Bag open");
    expect(cal).not.toContain("Find STASH nameplates");
    expect(cal).not.toContain("Walk to");
    expect(cal).not.toContain("New screenshot for quad stash");
  });
});
