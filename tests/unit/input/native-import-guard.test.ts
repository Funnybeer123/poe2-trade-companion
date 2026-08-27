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

  it("keeps SendInput koffi usage inside packages/native-input and window query in perception-live", () => {
    const sink = readFileSync(
      path.join(process.cwd(), "packages/native-input/src/nativeInputSink.ts"),
      "utf8",
    );
    expect(sink).toMatch(/koffi/);
    expect(sink).toMatch(/koffi\.struct\("INPUT"/);
    expect(sink).toMatch(/SendInput/);
    const processQuery = readFileSync(
      path.join(process.cwd(), "packages/perception-live/src/win32Process.ts"),
      "utf8",
    );
    expect(processQuery).toMatch(/koffi/);
    expect(processQuery).toMatch(/GetForegroundWindow/);
    expect(processQuery).not.toMatch(/SendInput/);
    const coreIndex = readFileSync(path.join(process.cwd(), "packages/core/src/index.ts"), "utf8");
    expect(coreIndex).not.toMatch(/from ["']koffi["']/);
    expect(coreIndex).not.toMatch(/@poe2tc\/native-input/);
    expect(coreIndex).not.toMatch(/electron/);
  });
});
