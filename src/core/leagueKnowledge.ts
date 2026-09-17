import { BUNDLED_KNOWLEDGE, type LeagueKnowledge } from "./batchTriage.js";
/** Data-only snapshot imports: bounded structure, no executable patterns or implicit refresh. */
export function validateLeagueKnowledge(value: unknown): asserts value is LeagueKnowledge {
  const fail = () => { throw new Error("Invalid league knowledge snapshot."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as LeagueKnowledge;
  const words = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 200 && x.every(s => typeof s === "string" && s.length <= 500);
  const records = (x: unknown): x is Record<string, unknown>[] => Array.isArray(x) && x.length <= 200 && x.every(s => !!s && typeof s === "object" && !Array.isArray(s));
  if (v.schemaVersion !== 1 || typeof v.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(v.id) ||
    typeof v.league !== "string" || !v.league.trim() || v.league.length > 80 || typeof v.patch !== "string" || !v.patch || v.patch.length > 40 ||
    !Number.isFinite(Date.parse(v.accessedAt)) || v.tierOrder !== "one-is-best" || v.refreshPolicy !== "manual-import" ||
    !records(v.sources) || !records(v.archetypes) || !records(v.baseOpportunities) || !records(v.lifeTiers) ||
    !v.sample || !words(v.sample.limitations) || ![v.sample.guideCount, v.sample.ladderCharacters, v.sample.marketListings].every(n => Number.isInteger(n) && n >= 0)) fail();
  const ids = new Set<string>();
  for (const source of v.sources) {
    if (typeof source.id !== "string" || !source.id || ids.has(source.id) || typeof source.kind !== "string" ||
      typeof source.url !== "string" || source.url.length > 2000 || source.publishedAt !== null && !Number.isFinite(Date.parse(source.publishedAt))) fail();
    try { if (new URL(source.url).protocol !== "https:") fail(); } catch { fail(); }
    ids.add(source.id);
  }
  for (const archetype of v.archetypes) {
    if (typeof archetype.id !== "string" || typeof archetype.label !== "string" ||
      !["attack", "spell", "minion"].includes(archetype.subject) || !words(archetype.sources) || archetype.sources.some(id => !ids.has(id)) ||
      !words(archetype.uniqueNames) || !words(archetype.bases) || !archetype.slots || typeof archetype.slots !== "object" ||
      Array.isArray(archetype.slots) || Object.values(archetype.slots).some(families => !words(families))) fail();
  }
  for (const base of v.baseOpportunities) if (typeof base.base !== "string" || typeof base.itemClass !== "string" ||
    !Number.isInteger(base.minimumItemLevel) || base.minimumItemLevel < 1 || base.minimumItemLevel > 100 ||
    !ids.has(base.source) || typeof base.reason !== "string") fail();
  for (const table of v.lifeTiers) {
    if (!words(table.classes) || !Array.isArray(table.ranges) || table.ranges.length > 30 || table.ranges.some((range, index) =>
      !Array.isArray(range) || range.length !== 3 || range.some(n => !Number.isFinite(n)) ||
      range[0]! > range[1]! || range[2]! < 1 || range[2]! > 100 || index > 0 && range[1]! >= table.ranges[index - 1]![0]!)) fail();
  }
}
export function knowledgeForReport(report: import("./stashValuation.js").StashValuationReport): LeagueKnowledge {
  const id = report.rows[0]?.assessment?.knowledgeId ?? report.settings.knowledgeId;
  const candidate = id ? report.knowledgeSnapshots?.[id] : undefined;
  if (candidate) { validateLeagueKnowledge(candidate); return candidate; }
  if (id && id !== BUNDLED_KNOWLEDGE.id) throw new Error("The assessment's knowledge snapshot is missing.");
  return BUNDLED_KNOWLEDGE;
}
