import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  newestReleasedVersion,
  parseChangelog,
  releasesSince,
} from "../src/core/appSettingsChangelog.js";

const SAMPLE = readFileSync(
  path.join(process.cwd(), "fixtures/app-settings/CHANGELOG.sample.md"),
  "utf8",
);

describe("parseChangelog", () => {
  const releases = parseChangelog(SAMPLE);

  it("drops the title and preamble and finds every release", () => {
    expect(releases.map((release) => release.version)).toEqual(["Unreleased", "0.2.0", "0.1.0"]);
  });

  it("reads a BOM-prefixed file whose first line is a release heading", () => {
    // Notepad and `Out-File` both write UTF-8 with a BOM on Windows; it
    // survives `readFileSync(…, "utf8")` and would hide the first `##`.
    const bom = readFileSync(
      path.join(process.cwd(), "fixtures/app-settings/CHANGELOG.bom.md"),
      "utf8",
    );
    expect(bom.charCodeAt(0)).toBe(0xfeff);
    const parsed = parseChangelog(bom);
    expect(parsed.map((release) => release.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(parsed[0]?.entries[0]?.text).toBe("A release whose heading is the very first line");
  });

  it("reads both date spellings", () => {
    expect(releases[1]?.date).toBe("2026-09-20");
    expect(releases[2]?.date).toBe("2026-09-01");
    expect(releases[0]?.date).toBeUndefined();
  });

  it("tags entries with their section and folds continuation lines", () => {
    const unreleased = releases[0];
    expect(unreleased?.entries[0]).toEqual({ section: "Added", text: "Overlay settings section" });
    expect(unreleased?.entries[1]?.text).toBe(
      "First-run checklist that verifies the log file, the league and the feed across two lines of source text",
    );
  });

  it("uses 'Changes' for bullets that precede any section heading", () => {
    expect(releases[2]?.entries).toEqual([{ section: "Changes", text: "Initial companion" }]);
  });

  it("ignores link-reference lines (they stay in `raw`, never in an entry)", () => {
    const entries = releases.flatMap((release) => release.entries);
    expect(JSON.stringify(entries)).not.toContain("example.invalid");
    expect(releases[2]?.entries).toHaveLength(1);
  });

  it("keeps the original lines for a raw fallback", () => {
    expect(releases[1]?.raw.startsWith("## [0.2.0] - 2026-09-20")).toBe(true);
  });

  it("survives empty and heading-free input", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nnothing here yet\n")).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
  });

  it("puts Unreleased above everything and '' below everything", () => {
    expect(compareVersions("Unreleased", "99.0.0")).toBe(1);
    expect(compareVersions("0.0.1", "")).toBe(1);
    expect(compareVersions("", "0.0.1")).toBe(-1);
  });
});

describe("releasesSince", () => {
  const releases = parseChangelog(SAMPLE);

  it("counts everything on a fresh install, minus Unreleased when packaged", () => {
    expect(releasesSince(releases, "").map((r) => r.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(releasesSince(releases, "", { includeUnreleased: true }).map((r) => r.version)).toEqual([
      "Unreleased",
      "0.2.0",
      "0.1.0",
    ]);
  });

  it("counts nothing once the newest release has been seen", () => {
    expect(releasesSince(releases, "0.2.0")).toEqual([]);
    expect(releasesSince(releases, "0.1.0").map((r) => r.version)).toEqual(["0.2.0"]);
  });

  it("names the newest released version for the bookmark", () => {
    expect(newestReleasedVersion(releases)).toBe("0.2.0");
    expect(newestReleasedVersion([])).toBeUndefined();
  });
});
