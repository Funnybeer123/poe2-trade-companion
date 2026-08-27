import { FixtureFrameSource, parseReplayManifest } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("ReplayManifest", () => {
  it("rejects a corrupt manifest without hanging", () => {
    const started = Date.now();
    expect(() => parseReplayManifest({ id: "broken" })).toThrow(/corrupt-manifest/);
    expect(() => parseReplayManifest({ frames: "not-an-array" })).toThrow(/corrupt-manifest/);
    expect(() =>
      parseReplayManifest({
        id: "x",
        scenarioId: "y",
        seed: 1,
        frames: [{ tickId: 1, atMs: 1, derived: {} }],
        expect: [{ tickId: 1, selectedState: "Follow", executed: true, sinkKind: "noop" }],
      }),
    ).toThrow(/corrupt-manifest/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("ends FixtureFrameSource with null after the last frame", async () => {
    const source = new FixtureFrameSource([]);
    await expect(source.nextFrame()).resolves.toBeNull();
  });
});
