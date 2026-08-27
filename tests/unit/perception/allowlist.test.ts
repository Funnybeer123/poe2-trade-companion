import {
  createEmptyWorldState,
  createReplayArming,
  createStateEstimator,
  FrozenClock,
  isProcessAllowlistedByArming,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

const matching = { name: "PathOfExile.exe", title: "Path of Exile 2" };

describe("process allowlist", () => {
  const arming = createReplayArming();

  it("returns true for a matching process name and window title", () => {
    expect(isProcessAllowlistedByArming(matching, arming)).toBe(true);
  });

  it("returns false for a process name outside the allowlist", () => {
    expect(
      isProcessAllowlistedByArming({ name: "notepad.exe", title: "Path of Exile 2" }, arming),
    ).toBe(false);
  });

  it("returns false for a window title that does not include the allowlist fragment", () => {
    expect(
      isProcessAllowlistedByArming({ name: "PathOfExile.exe", title: "Not The Game" }, arming),
    ).toBe(false);
  });

  it("returns false when allowlists are empty (fail closed)", () => {
    expect(
      isProcessAllowlistedByArming(
        matching,
        createReplayArming({ allowlistedProcessNames: [], allowlistedWindowTitleIncludes: [] }),
      ),
    ).toBe(false);
  });

  it("recomputes allowlisted on the estimator from arming, ignoring derived true", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming });
    const world = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: 1,
      capturedAtMs: 10_000,
      evidenceId: "t",
      process: {
        value: { name: "chrome.exe", title: "Chrome", allowlisted: true },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      },
    });
    expect(world.process.value.allowlisted).toBe(false);
  });

  it("sets allowlisted true when the observed name and title match arming", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming });
    const world = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: 1,
      capturedAtMs: 10_000,
      evidenceId: "t",
      process: {
        value: { ...matching, allowlisted: false },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      },
    });
    expect(world.process.value.allowlisted).toBe(true);
  });
});
