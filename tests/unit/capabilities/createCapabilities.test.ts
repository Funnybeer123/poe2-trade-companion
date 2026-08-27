import { createCapabilities } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("createCapabilities", () => {
  it("makes public-companion structurally unable to emit native input", () => {
    const caps = createCapabilities("public-companion");
    expect(caps.mode).toBe("public-companion");
    expect(caps.canEmitNativeInput).toBe(false);
    expect(caps.qaBannerRequired).toBe(false);
    expect(caps.modules.input).toBe(false);
    expect(caps.modules.follow).toBe(false);
    expect(caps.modules.perception).toBe(true);
  });

  it("keeps public-companion canEmitNativeInput frozen at false", () => {
    const caps = createCapabilities("public-companion");
    expect(() => {
      (caps as { canEmitNativeInput: boolean }).canEmitNativeInput = true;
    }).toThrow();
    expect(caps.canEmitNativeInput).toBe(false);
  });

  it("marks authorized-qa as native-input eligible, not armed", () => {
    const caps = createCapabilities("authorized-qa");
    expect(caps.mode).toBe("authorized-qa");
    expect(caps.canEmitNativeInput).toBe(true);
    expect(caps.qaBannerRequired).toBe(true);
    expect(caps.modules.input).toBe(true);
    expect(caps.modules.follow).toBe(true);
  });
});
