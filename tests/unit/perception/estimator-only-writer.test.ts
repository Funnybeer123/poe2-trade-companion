import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AutomationLoop perception wiring", () => {
  it("routes frames through FixturePerceptionAdapter and StateEstimator", () => {
    const source = readFileSync(join(process.cwd(), "packages/core/src/loop/automationLoop.ts"), "utf8");
    expect(source).toContain("createFixturePerceptionAdapter");
    expect(source).toContain("createStateEstimator");
    expect(source).toContain("analyzeFailureFrame");
    expect(source).not.toContain("identityEstimate");
    expect(source).not.toMatch(/derived as WorldState/);
    expect(source).not.toMatch(/world\s*=\s*derived/);
  });
});
