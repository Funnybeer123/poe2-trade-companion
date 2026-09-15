import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_RECORD_BYTES,
  parseSessionHistory,
  pruneHistory,
  recentRuns,
  sanitizeSessionRecord,
  sanitizeSessionState,
  serializeSessionRecord,
  shouldPersist,
  stateForView,
  summarizeSession,
  type SessionRecord,
} from "../src/core/sessionHistory.js";
import { sessionMetrics, startSession, type MapRun, type SessionState } from "../src/core/sessionTracker.js";

const ROOT = path.resolve(__dirname, "..");
const HISTORY = readFileSync(path.join(ROOT, "fixtures", "session", "session-history.jsonl"), "utf8");
const RESUMABLE = readFileSync(
  path.join(ROOT, "fixtures", "session", "session-current-resumable.json"),
  "utf8",
);

function run(id: string, startedAt: string, overrides: Partial<MapRun> = {}): MapRun {
  return {
    id,
    kind: "map",
    areaId: "MapSunTemple",
    name: "Sun Temple",
    areaLevel: 79,
    seed: 5,
    tier: 15,
    startedAt,
    wallMs: 600_000,
    activeMs: 540_000,
    portals: 0,
    deaths: 0,
    subAreas: [],
    completed: true,
    endedBy: "hideout",
    endedAt: startedAt,
    ...overrides,
  };
}

function stateWith(runs: MapRun[]): SessionState {
  return { ...startSession("ses-runs", "2026-09-11T20:00:00.000Z"), runs };
}

describe("session history — parsing", () => {
  it("reads the fixture, skipping the junk line", () => {
    const records = parseSessionHistory(HISTORY);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.state.id)).toEqual([
      "ses-2026-09-09T20-00-00-000Z",
      "ses-2026-09-10T19-00-00-000Z",
      "ses-2026-09-11T21-00-00-000Z",
    ]);
  });

  it("recomputes missing metrics from the state", () => {
    const record = parseSessionHistory(HISTORY)[0];
    expect(record.metrics.mapsCompleted).toBe(1);
    expect(record.metrics.deaths).toBe(1);
    expect(record.metrics.wallMs).toBe(3 * 3_600_000);
  });

  it("parses the resumable current-session file", () => {
    const record = sanitizeSessionRecord(JSON.parse(RESUMABLE));
    expect(record?.state.id).toBe("ses-2026-09-11T21-00-00-000Z");
    expect(record?.state.endedAt).toBeUndefined();
    expect(record?.state.current?.areaId).toBe("MapSunTemple");
    expect(record?.state.runs[0].endedAt).toBeUndefined();
  });

  it("refuses junk and a wrong version", () => {
    expect(sanitizeSessionRecord(undefined)).toBeUndefined();
    expect(sanitizeSessionRecord({ version: 2, state: {} })).toBeUndefined();
    expect(sanitizeSessionRecord({ version: 1, state: { id: "x" } })).toBeUndefined();
    expect(parseSessionHistory("{not json\n\n")).toEqual([]);
  });
});

describe("session history — sanitizing a state", () => {
  it("drops impossible members instead of the whole state", () => {
    const state = sanitizeSessionState({
      id: "ses-1",
      startedAt: "2026-09-11T20:00:00.000Z",
      endReason: "exploded",
      characters: [{ name: "Himbo", seenAt: "nope" }, { name: "Ok", seenAt: "2026-09-11T20:00:00.000Z" }],
      areas: [{ areaId: "X", enteredAt: "2026-09-11T20:00:00.000Z", category: "not-a-category" }],
      runs: [
        { id: "r", areaId: "MapX", kind: "sprint", startedAt: "2026-09-11T20:00:00.000Z" },
        { id: "r2", areaId: "MapX", kind: "map", startedAt: "2026-09-11T20:00:00.000Z", deaths: Number.NaN, endedBy: "??" },
      ],
      deaths: "not an array",
      trades: { accepted: -3, cancelled: "2" },
      eventCount: Number.POSITIVE_INFINITY,
    });
    expect(state).toBeDefined();
    expect(state?.endReason).toBeUndefined();
    expect(state?.characters.map((entry) => entry.name)).toEqual(["Ok"]);
    expect(state?.areas).toEqual([]);
    expect(state?.runs).toHaveLength(1);
    expect(state?.runs[0].deaths).toBe(0);
    expect(state?.runs[0].endedBy).toBeUndefined();
    expect(state?.deaths).toEqual([]);
    expect(state?.trades).toEqual({ accepted: 0, cancelled: 2 });
    expect(state?.eventCount).toBe(0);
  });

  it("refuses a state without an id or a start", () => {
    expect(sanitizeSessionState({ startedAt: "2026-09-11T20:00:00.000Z" })).toBeUndefined();
    expect(sanitizeSessionState({ id: "ses-1" })).toBeUndefined();
    expect(sanitizeSessionState({ id: "a b/c", startedAt: "2026-09-11T20:00:00.000Z" })).toBeUndefined();
  });
});

describe("session history — writing", () => {
  it("round-trips a record", () => {
    const record = parseSessionHistory(HISTORY)[1];
    const line = serializeSessionRecord(record);
    expect(line.includes("\n")).toBe(false);
    const back = sanitizeSessionRecord(JSON.parse(line));
    expect(back?.state.runs.map((entry) => entry.id)).toEqual(["run-b", "run-c"]);
  });

  it("drops areas first and then the oldest runs to fit the byte cap", () => {
    const many: MapRun[] = [];
    for (let index = 0; index < 300; index += 1) {
      many.push(
        run(`run-${index}`, new Date(Date.UTC(2026, 8, 11, 0, index)).toISOString(), {
          name: `Sun Temple ${"x".repeat(900)} ${index}`,
          subAreas: ["BreachDomain_01", "BreachDomain_02"],
        }),
      );
    }
    const state: SessionState = {
      ...stateWith(many),
      areas: many.map((entry, index) => ({
        areaId: entry.areaId,
        name: `${entry.name} area`,
        category: "map" as const,
        level: 79,
        seed: index,
        enteredAt: entry.startedAt,
      })),
    };
    const record: SessionRecord = {
      version: 1,
      state,
      metrics: sessionMetrics(state, "2026-09-11T23:00:00.000Z"),
      savedAt: "2026-09-11T23:00:00.000Z",
    };
    const line = serializeSessionRecord(record);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const back = sanitizeSessionRecord(JSON.parse(line));
    expect(back?.state.areas).toEqual([]);
    expect(back!.state.runs.length).toBeLessThan(300);
    expect(back!.state.runs.at(-1)?.id).toBe("run-299");
  });

  /**
   * The cap is documented in bytes. Measuring `line.length` would let a record
   * full of three-byte characters be written at ~3× the promised size.
   */
  it("measures the cap in UTF-8 bytes, not code units", () => {
    const many: MapRun[] = [];
    for (let index = 0; index < 300; index += 1) {
      many.push(
        run(`run-${index}`, new Date(Date.UTC(2026, 8, 11, 0, index)).toISOString(), {
          name: `${"태양신전".repeat(120)} ${index}`,
        }),
      );
    }
    const state = stateWith(many);
    const record: SessionRecord = {
      version: 1,
      state,
      metrics: sessionMetrics(state, "2026-09-11T23:00:00.000Z"),
      savedAt: "2026-09-11T23:00:00.000Z",
    };
    const line = serializeSessionRecord(record);
    // A code-unit cap would have accepted the whole record untrimmed…
    expect(JSON.stringify({ ...record }).length).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // …at roughly three times the documented size on disk.
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(sanitizeSessionRecord(JSON.parse(line))!.state.runs.length).toBeLessThan(300);
  });

  it("keeps only the newest sessions when pruning", () => {
    const records = parseSessionHistory(HISTORY);
    const kept = pruneHistory(records, 2);
    expect(kept.map((record) => record.state.id)).toEqual([
      "ses-2026-09-10T19-00-00-000Z",
      "ses-2026-09-11T21-00-00-000Z",
    ]);
  });
});

describe("session history — views", () => {
  it("summarizes a record with its best character", () => {
    const summary = summarizeSession(parseSessionHistory(HISTORY)[1]);
    expect(summary).toMatchObject({
      id: "ses-2026-09-10T19-00-00-000Z",
      endReason: "idle",
      mapsCompleted: 1,
    });
    expect(summary.character?.name).toBe("Himbo");
    expect(summary.character?.level).toBe(87);
  });

  it("refuses to persist a short empty session", () => {
    const empty = startSession("ses-empty", "2026-09-11T20:00:00.000Z");
    expect(shouldPersist(empty, sessionMetrics(empty, "2026-09-11T20:00:30.000Z"))).toBe(false);
    const busy = { ...empty, eventCount: 5 };
    expect(shouldPersist(busy, sessionMetrics(busy, "2026-09-11T20:05:00.000Z"))).toBe(true);
    const withRun = stateWith([run("r1", "2026-09-11T20:00:10.000Z")]);
    expect(shouldPersist(withRun, sessionMetrics(withRun, "2026-09-11T20:00:40.000Z"))).toBe(true);
  });

  it("orders recent runs newest first across the live session and history", () => {
    const current = stateWith([run("live", "2026-09-12T10:00:00.000Z")]);
    const rows = recentRuns(parseSessionHistory(HISTORY), current, 3);
    expect(rows.map((entry) => entry.id)).toEqual(["live", "run-c", "run-b"]);
  });

  it("trims the arrays for the bridge", () => {
    const many: MapRun[] = [];
    for (let index = 0; index < 150; index += 1) {
      many.push(run(`run-${index}`, new Date(Date.UTC(2026, 8, 11, 0, index)).toISOString()));
    }
    const trimmed = stateForView(stateWith(many), { runs: 10 });
    expect(trimmed.runs).toHaveLength(10);
    expect(trimmed.runs.at(-1)?.id).toBe("run-149");
  });
});
