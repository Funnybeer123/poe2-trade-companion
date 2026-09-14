import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStashValuationSettings, type StashValuationReport } from "../src/core/stashValuation.js";
import { StashValuationService } from "../src/main/stashValuationService.js";

const settings = () => ({ ...defaultStashValuationSettings(), league: "Forbidden Rites" });
const root = () => mkdtempSync(path.join(tmpdir(), "stash-valuation-service-"));

describe("shared stash valuation settings and reports", () => {
  it("requires an explicit league and rejects invalid thresholds before writing settings", () => {
    const service = new StashValuationService(root());
    expect(service.overview().settings.league).toBe("");
    expect(() => service.saveSettings(defaultStashValuationSettings())).toThrow("exact league");
    expect(() => service.saveSettings({ ...settings(), league: "auto" })).toThrow("exact league");
    expect(() => service.saveSettings({ ...settings(), minChaos: Number.NaN })).toThrow("minChaos");
    expect(() => service.saveSettings({ ...settings(), weights: { unknown: 2 } })).toThrow("score multiplier");
  });

  it("persists CLI-readable settings and preserves independent scoring profiles per league", () => {
    const directory = root();
    const service = new StashValuationService(directory);
    const first = { ...settings(), weights: { life: 2 }, minChaos: 1.5 };
    service.saveSettings(first);
    service.saveSettings({ ...settings(), league: "Standard", weights: { life: 0.5 } });
    const reloaded = new StashValuationService(directory).overview();
    expect(reloaded.settings.league).toBe("Standard");
    expect(reloaded.profiles["Forbidden Rites"]).toEqual(first);
    expect(reloaded.profiles.Standard?.weights).toEqual({ life: 0.5 });
    const file = path.join(directory, "artifacts", "tab-admin", "stash-valuation.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(reloaded.settings);
  });

  it("surfaces corrupted artifacts without manufacturing an empty successful scan", () => {
    const directory = root();
    const artifacts = path.join(directory, "artifacts", "tab-admin");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "stash-valuation-report.json"), "{bad-json");
    const service = new StashValuationService(directory);
    expect(service.overview().report).toBeNull();
    expect(service.overview().issues.join(" ")).toContain("could not be read");
    writeFileSync(path.join(artifacts, "stash-valuation-report.json"), JSON.stringify({ schemaVersion: 1, rows: [] }));
    expect(service.overview().report).toBeNull();
    expect(service.overview().issues.join(" ")).toContain("report is invalid");
  });

  it("loads the scanner report with explicit incomplete coverage", () => {
    const directory = root();
    const service = new StashValuationService(directory);
    service.saveSettings(settings());
    const report: StashValuationReport = {
      schemaVersion: 1, id: "scan-1", startedAt: "2026-09-14T12:00:00Z", league: "Forbidden Rites",
      settings: settings(), scoreVersion: "test-1", mode: "scan", status: "incomplete", sourceTab: "Dump",
      scannedItems: 0, unreadCells: [{ row: 0, col: 2, reason: "clipboard timed out" }], rows: [], errors: [],
    };
    writeFileSync(path.join(directory, "artifacts", "tab-admin", "stash-valuation-report.json"), JSON.stringify(report));
    expect(service.overview().report).toEqual(report);
  });

  it("marks an interrupted running report stopped while preserving completed failures", () => {
    const directory = root();
    const service = new StashValuationService(directory);
    service.saveSettings(settings());
    const report: StashValuationReport = {
      schemaVersion: 1, id: "scan-running", startedAt: "2026-09-14T12:00:00Z", league: "Forbidden Rites",
      settings: settings(), scoreVersion: "test-1", mode: "scan", status: "running", sourceTab: "Dump",
      scannedItems: 0, unreadCells: [], rows: [], errors: [],
    };
    const file = path.join(directory, "artifacts", "tab-admin", "stash-valuation-report.json");
    writeFileSync(file, JSON.stringify(report));
    service.markStopped("Emergency stop");
    expect(service.overview().report).toMatchObject({ status: "stopped", errors: ["Emergency stop"] });
    const failed = { ...report, status: "failed", errors: ["Source scan failed: no-geometry"] };
    writeFileSync(file, JSON.stringify(failed));
    service.markStopped("App closed");
    expect(service.overview().report).toEqual(failed);
  });
});
