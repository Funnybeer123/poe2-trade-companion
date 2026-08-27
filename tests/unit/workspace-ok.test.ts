import { workspaceOk } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("workspaceOk", () => {
  it("returns true", () => {
    expect(workspaceOk()).toBe(true);
  });
});
