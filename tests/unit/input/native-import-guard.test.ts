import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("native input import guard", () => {
  it("passes for the current repository", () => {
    const output = execFileSync("node", ["scripts/check-native-input-imports.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(output).toMatch(/OK: no native input imports/);
  });

  it("keeps koffi imports inside packages/native-input only", () => {
    const sink = readFileSync(
      path.join(process.cwd(), "packages/native-input/src/nativeInputSink.ts"),
      "utf8",
    );
    expect(sink).toMatch(/koffi/);
    expect(sink).toMatch(/koffi\.struct\("INPUT"/);
    expect(sink).toMatch(/SendInput/);
    const coreIndex = readFileSync(path.join(process.cwd(), "packages/core/src/index.ts"), "utf8");
    expect(coreIndex).not.toMatch(/from ["']koffi["']/);
    expect(coreIndex).not.toMatch(/@poe2tc\/native-input/);
  });
});
