import path from "node:path";
import { expect, it } from "vitest";
import { backgroundSmokeEnabled } from "../src/main/backgroundSmoke.js";

it("leaves ordinary app launches unchanged", () => {
  expect(backgroundSmokeEnabled([], {})).toBe(false);
  expect(backgroundSmokeEnabled(["--user-data-dir=relative"], { POE2_SMOKE_BACKGROUND: "0" })).toBe(false);
});

it("requires a matching explicit absolute test profile before enabling background smoke", () => {
  const profile = path.resolve("artifacts", "isolated-smoke-profile");
  const env = { POE2_SMOKE_BACKGROUND: "1", POE2_SMOKE_USER_DATA_DIR: profile };
  expect(backgroundSmokeEnabled([`--user-data-dir=${profile}`], env)).toBe(true);
  expect(backgroundSmokeEnabled(["--user-data-dir", profile], env)).toBe(true);
  for (const argv of [[], ["--user-data-dir=relative"], [`--user-data-dir=${profile}-other`], [`--user-data-dir=${profile}`, `--user-data-dir=${profile}`]]) {
    expect(() => backgroundSmokeEnabled(argv, env)).toThrow("isolated user-data");
  }
  expect(() => backgroundSmokeEnabled([`--user-data-dir=${profile}`], { POE2_SMOKE_BACKGROUND: "1" })).toThrow("isolated user-data");
  const root = path.parse(profile).root;
  expect(() => backgroundSmokeEnabled([`--user-data-dir=${root}`], { ...env, POE2_SMOKE_USER_DATA_DIR: root })).toThrow("isolated user-data");
});
