import { createCapabilities, isQaBannerRequired } from "@poe2tc/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("QA banner", () => {
  it("is required when qaBannerRequired is set in authorized-qa", () => {
    const qa = createCapabilities("authorized-qa");
    expect(qa.qaBannerRequired).toBe(true);
    expect(isQaBannerRequired(qa)).toBe(true);
  });

  it("is not required in public-companion", () => {
    const pub = createCapabilities("public-companion");
    expect(pub.qaBannerRequired).toBe(false);
    expect(isQaBannerRequired(pub)).toBe(false);
  });

  it("QaBanner component cannot be dismissed and STOP trips the latch", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/overlay/src/components/QaBanner.vue"),
      "utf8",
    );
    expect(source).toContain("data-testid=\"qa-banner\"");
    expect(source).toContain("STOP");
    expect(source).toContain("tripStop");
    expect(source).not.toMatch(/dismiss|hideBanner|closeBanner|v-if="!dismissed"/i);
  });
});
