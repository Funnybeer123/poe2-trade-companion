import {
  isQaBuildEnabled,
  resolveRuntimeMode,
  resolveRuntimeModeFromEnv,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("public-mode compile-time flag", () => {
  it("cannot resolve authorized-qa without a compile-time QA flag", () => {
    expect(
      resolveRuntimeMode({
        compileTimeMode: "public-companion",
        runtimeMode: "authorized-qa",
      }),
    ).toBe("public-companion");
    expect(isQaBuildEnabled("public-companion")).toBe(false);
  });

  it("ignores POE2TC_RUNTIME_MODE when compile-time mode is public", () => {
    expect(
      resolveRuntimeModeFromEnv({
        POE2TC_MODE: "public-companion",
        POE2TC_RUNTIME_MODE: "authorized-qa",
      }),
    ).toBe("public-companion");
  });

  it("allows authorized-qa only when compile-time mode is authorized-qa", () => {
    expect(
      resolveRuntimeMode({
        compileTimeMode: "authorized-qa",
        runtimeMode: "authorized-qa",
      }),
    ).toBe("authorized-qa");
    expect(
      resolveRuntimeMode({
        compileTimeMode: "authorized-qa",
        runtimeMode: "public-companion",
      }),
    ).toBe("public-companion");
  });
});
