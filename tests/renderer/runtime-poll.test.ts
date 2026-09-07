// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { runtimePollDelayMs } from "../../src/renderer/composables/useRuntimeState";

describe("runtime status polling", () => {
  it("asks main every 2.5 s while the window has focus and every 5 s otherwise", () => {
    expect(runtimePollDelayMs(true)).toBe(2_500);
    expect(runtimePollDelayMs(false)).toBe(5_000);
  });
});
