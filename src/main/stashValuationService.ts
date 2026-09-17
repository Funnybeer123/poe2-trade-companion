import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assessBatch, BUNDLED_KNOWLEDGE, type LeagueKnowledge } from "../core/batchTriage.js";
import { validateSavedStashReport } from "../core/savedStashPricing.js";
import { writeBatchReport } from "./batchReportStore.js";
import { validateLeagueKnowledge } from "../core/leagueKnowledge.js";
import {
  defaultStashValuationSettings,
  validateStashValuationSettings,
  type StashValuationReport,
  type StashValuationSettings,
} from "../core/stashValuation.js";

/** The desktop and standalone scanner share these local settings and reports. */
export class StashValuationService {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = path.join(root, "artifacts", "tab-admin");
  }

  overview(): { settings: StashValuationSettings; profiles: Record<string, StashValuationSettings>; report: StashValuationReport | null; issues: string[] } {
    const issues: string[] = [];
    const read = (name: string): unknown => {
      const file = path.join(this.directory, name);
      if (!existsSync(file)) return undefined;
      try {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch {
        issues.push(`${name} could not be read. Run a new scan to replace an unreadable report.`);
        return undefined;
      }
    };
    const rawSettings = read("stash-valuation.json");
    const candidate = { ...defaultStashValuationSettings(), ...(this.isRecord(rawSettings) ? rawSettings : {}) };
    const settingsIssues = validateStashValuationSettings(candidate, false);
    issues.push(...settingsIssues);
    const settings = settingsIssues.length ? defaultStashValuationSettings() : candidate as StashValuationSettings;
    const rawProfiles = read("stash-valuation-profiles.json");
    const profiles: Record<string, StashValuationSettings> = {};
    if (this.isRecord(rawProfiles)) {
      for (const [league, profile] of Object.entries(rawProfiles)) {
        if (!validateStashValuationSettings(profile).length && (profile as StashValuationSettings).league === league) {
          profiles[league] = profile as StashValuationSettings;
        }
      }
    }
    if (settings.league) profiles[settings.league] = settings;
    const rawReport = read("stash-valuation-report.json");
    const report = this.readReport(rawReport);
    if (rawReport !== undefined && !report) issues.push("Saved valuation report is invalid. Run a new scan.");
    return { settings, profiles, report, issues };
  }

  saveSettings(value: unknown): StashValuationSettings {
    const issues = validateStashValuationSettings(value);
    if (issues.length) throw new Error(issues.join(" "));
    const settings = structuredClone(value) as StashValuationSettings;
    const { profiles, report } = this.overview();
    const knowledge = this.knowledge(settings);
    const rescored = report ? assessBatch(report, settings, new Date().toISOString(), knowledge) : undefined;
    profiles[settings.league] = settings;
    mkdirSync(this.directory, { recursive: true });
    this.write("stash-valuation-profiles.json", profiles);
    this.write("stash-valuation.json", settings);
    if (report && rescored) {
      if (JSON.stringify(report.settings.selectedPriceIds) !== JSON.stringify(settings.selectedPriceIds) ||
        report.league !== settings.league) delete rescored.pricingQueue;
      writeBatchReport(path.join(this.directory, "stash-valuation-report.json"), rescored);
    }
    return settings;
  }

  knowledge(settings: StashValuationSettings): LeagueKnowledge {
    if (!settings.knowledgeId || settings.knowledgeId === BUNDLED_KNOWLEDGE.id) return BUNDLED_KNOWLEDGE;
    if (!/^[a-zA-Z0-9._-]+$/.test(settings.knowledgeId)) throw new Error("Invalid snapshot ID.");
    const candidate = JSON.parse(readFileSync(path.join(this.directory, "knowledge", settings.knowledgeId + ".json"), "utf8")) as LeagueKnowledge;
    validateLeagueKnowledge(candidate);
    if (candidate.id !== settings.knowledgeId || candidate.league !== settings.league) throw new Error("Snapshot identity/league mismatch.");
    return candidate;
  }

  importKnowledge(value: unknown): string {
    validateLeagueKnowledge(value);
    const contents = JSON.stringify(value, null, 2);
    const folder = path.join(this.directory, "knowledge");
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, value.id + ".json");
    if (existsSync(file) && JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(value)) throw new Error("Snapshot IDs are immutable; choose a new version ID.");
    if (!existsSync(file)) writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
    return value.id;
  }

  reassess(): StashValuationReport {
    const { report, settings } = this.overview();
    if (!report) throw new Error("No saved capture is available.");
    const issues = validateSavedStashReport(report);
    if (issues.length) throw new Error(issues.join(" "));
    const assessed = assessBatch(report, settings, new Date().toISOString(), this.knowledge(settings));
    writeBatchReport(path.join(this.directory, "stash-valuation-report.json"), assessed);
    return assessed;
  }

  markStopped(reason: string): void {
    const report = this.overview().report;
    if (!report || (report.status !== "running" && report.pricingQueue?.state !== "running")) return;
    if (report.pricingQueue?.state === "running") {
      report.pricingQueue.state = "paused";
      report.pricingQueue.reason = reason;
    }
    writeBatchReport(path.join(this.directory, "stash-valuation-report.json"), {
      ...report,
      status: report.status === "running" ? "stopped" : report.status,
      finishedAt: new Date().toISOString(),
      errors: [...report.errors, reason],
    });
  }

  private write(name: string, value: unknown): void {
    const file = path.join(this.directory, name);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private readReport(value: unknown): StashValuationReport | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.league !== "string" || typeof record.sourceTab !== "string" ||
      typeof record.scannedItems !== "number" || !Array.isArray(record.unreadCells) || !Array.isArray(record.errors) ||
      !Array.isArray(record.rows) || validateStashValuationSettings(record.settings).length) return null;
    if (record.rows.some(row => !this.isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string" ||
      typeof row.rawText !== "string" || !Array.isArray(row.mods) || !Array.isArray(row.reasons) ||
      !this.isRecord(row.quote) || !Array.isArray(row.quote.reasons))) return null;
    return value as StashValuationReport;
  }
}
