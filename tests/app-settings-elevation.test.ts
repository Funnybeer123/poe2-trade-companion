import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ELEVATION_PROBE_SCRIPT,
  judgeElevation,
  parseElevationProbe,
  psQuote,
  relaunchElevatedCommand,
} from "../src/core/appSettingsElevation.js";

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures/app-settings", name), "utf8");
}

const CHECKED_AT = "2026-09-12T10:00:00.000Z";

describe("parseElevationProbe", () => {
  it("reads a normal object", () => {
    const probe = parseElevationProbe(fixture("elevation-probe-normal.json"));
    expect(probe.appElevated).toBe(false);
    expect(probe.processes).toHaveLength(2);
    expect(probe.processes[0]).toEqual({ name: "PathOfExileSteam", pid: 4812, access: "ok" });
  });

  it("normalises a single unwrapped process row into an array", () => {
    const probe = parseElevationProbe(
      '{"appElevated":true,"processes":{"name":"PathOfExile","pid":7,"access":"denied"}}',
    );
    expect(probe.processes).toEqual([{ name: "PathOfExile", pid: 7, access: "denied" }]);
  });

  it("degrades to unknown for empty output and garbage", () => {
    expect(parseElevationProbe("")).toEqual({ appElevated: "unknown", processes: [] });
    expect(parseElevationProbe(fixture("garbage.txt"))).toEqual({
      appElevated: "unknown",
      processes: [],
    });
    expect(parseElevationProbe("[1,2,3]")).toEqual({ appElevated: "unknown", processes: [] });
  });

  it("drops rows that carry no usable name or pid", () => {
    const probe = parseElevationProbe('{"appElevated":false,"processes":[{"pid":"x"},{"name":"PoE","pid":1}]}');
    expect(probe.processes).toEqual([{ name: "PoE", pid: 1, access: "ok" }]);
  });
});

describe("judgeElevation", () => {
  it("flags the one actionable case with the hint", () => {
    const report = judgeElevation(
      parseElevationProbe(fixture("elevation-probe-elevated-game.json")),
      CHECKED_AT,
    );
    expect(report).toMatchObject({ poeRunning: true, poeElevated: "likely", appElevated: false });
    expect(report.hint).toContain("UIPI");
    expect(report.checkedAt).toBe(CHECKED_AT);
  });

  it("says 'no' when every handle opened", () => {
    const report = judgeElevation(parseElevationProbe(fixture("elevation-probe-normal.json")), CHECKED_AT);
    expect(report.poeElevated).toBe("no");
    expect(report.hint).toBeUndefined();
  });

  it("says 'unknown' with no game running", () => {
    const report = judgeElevation(parseElevationProbe(fixture("elevation-probe-no-game.json")), CHECKED_AT);
    expect(report).toMatchObject({ poeRunning: false, poeElevated: "unknown" });
    expect(report.hint).toBeUndefined();
  });

  it("never warns when the companion itself is elevated", () => {
    const report = judgeElevation(
      { appElevated: true, processes: [{ name: "PathOfExile", pid: 1, access: "ok" }] },
      CHECKED_AT,
    );
    expect(report.poeElevated).toBe("unknown");
    expect(report.hint).toBeUndefined();
  });

  it("treats an error row without a denial as unknown", () => {
    const report = judgeElevation(
      { appElevated: false, processes: [{ name: "PathOfExile", pid: 1, access: "error" }] },
      CHECKED_AT,
    );
    expect(report.poeElevated).toBe("unknown");
  });
});

describe("PowerShell command construction (blocking safety test)", () => {
  it("the probe script carries no shell expansion", () => {
    expect(ELEVATION_PROBE_SCRIPT).not.toContain("${");
    expect(ELEVATION_PROBE_SCRIPT).toContain("ConvertTo-Json");
  });

  it("psQuote single-quotes and doubles embedded quotes", () => {
    expect(psQuote("C:/app.exe")).toBe("'C:/app.exe'");
    expect(psQuote("C:\\Dir's\\app.exe")).toBe("'C:\\Dir''s\\app.exe'");
    expect(psQuote("$(Get-Process)")).toBe("'$(Get-Process)'");
  });

  it("builds a relaunch command with no expansion and every argument quoted", () => {
    const command = relaunchElevatedCommand("C:\\Dir's\\app.exe", [".", "--flag"], {
      POE2_BUILD_MODE: "authorized-qa",
    });
    expect(command).not.toContain("${");
    expect(command).toBe(
      "$env:POE2_BUILD_MODE = 'authorized-qa'; Start-Process -FilePath 'C:\\Dir''s\\app.exe' -ArgumentList @('.','--flag') -Verb RunAs",
    );
  });

  it("omits -ArgumentList when there are no arguments and keeps -Verb RunAs", () => {
    const command = relaunchElevatedCommand("C:/app.exe", [], { POE2_BUILD_MODE: "public-companion" });
    expect(command).not.toContain("-ArgumentList");
    expect(command.endsWith("-Verb RunAs")).toBe(true);
  });

  it("quotes the working directory and puts it before -Verb RunAs", () => {
    const command = relaunchElevatedCommand(
      "C:/app.exe",
      ["C:\\Repo's\\app"],
      { POE2_BUILD_MODE: "authorized-qa" },
      { workingDirectory: "C:\\Repo's\\app" },
    );
    expect(command).not.toContain("${");
    expect(command).toBe(
      "$env:POE2_BUILD_MODE = 'authorized-qa'; Start-Process -FilePath 'C:/app.exe' " +
        "-ArgumentList @('C:\\Repo''s\\app') -WorkingDirectory 'C:\\Repo''s\\app' -Verb RunAs",
    );
  });

  it("omits -WorkingDirectory when none is given or it is empty", () => {
    expect(relaunchElevatedCommand("C:/app.exe", [])).not.toContain("-WorkingDirectory");
    expect(relaunchElevatedCommand("C:/app.exe", [], {}, { workingDirectory: "" })).not.toContain(
      "-WorkingDirectory",
    );
  });

  it("refuses an environment name that is not a plain identifier", () => {
    const command = relaunchElevatedCommand("C:/app.exe", [], {
      "BAD;NAME": "x",
      POE2_BUILD_MODE: "authorized-qa",
    });
    expect(command).not.toContain("BAD;NAME");
    expect(command.startsWith("$env:POE2_BUILD_MODE = 'authorized-qa'; ")).toBe(true);
  });
});
