import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaInfo } from "../src/core/areaCatalog.js";
import { parseClientLogLine, type ClientLogEvent } from "../src/core/clientLog.js";
import {
  MAX_AREAS,
  applyEvent,
  applyTick,
  campaignRank,
  currentCharacter,
  endSession,
  experienceHint,
  formatDuration,
  isRunBoundary,
  mapTierFromLevel,
  newRunId,
  newSessionId,
  runKindFor,
  sessionMetrics,
  setCharacterOverride,
  startSession,
  type SessionState,
} from "../src/core/sessionTracker.js";

const ROOT = path.resolve(__dirname, "..");

/**
 * The fixture lines carry LOCAL wall-clock times (that is what the parser
 * produces), so every timestamp an assertion needs is built the same way.
 */
const at = (hour: number, minute: number, second = 0): string =>
  new Date(2026, 8, 11, hour, minute, second).toISOString();

function events(fixture: string): ClientLogEvent[] {
  const text = readFileSync(path.join(ROOT, "fixtures", "session", fixture), "utf8");
  const out: ClientLogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseClientLogLine(line, areaInfo);
    if (event) out.push(event);
  }
  return out;
}

function fold(fixture: string, startedAt: string): SessionState {
  let state = startSession(newSessionId(startedAt), startedAt);
  for (const event of events(fixture)) state = applyEvent(state, event);
  return state;
}

describe("session tracker — pure helpers", () => {
  it("maps area level to map tier, with T16 for the irradiated levels", () => {
    expect(mapTierFromLevel(64)).toBeUndefined();
    expect(mapTierFromLevel(65)).toBe(1);
    expect(mapTierFromLevel(79)).toBe(15);
    expect(mapTierFromLevel(80)).toBe(16);
    expect(mapTierFromLevel(81)).toBe(16);
    expect(mapTierFromLevel(82)).toBe(16);
  });

  it("gives every observed Map* id at level 65+ a tier between 1 and 16", () => {
    const tsv = readFileSync(path.join(ROOT, "fixtures", "client-log", "area-ids-observed.tsv"), "utf8");
    let checked = 0;
    for (const line of tsv.split(/\r?\n/)) {
      const [id, levelText] = line.split("\t");
      if (!id || !levelText) continue;
      const level = Number(levelText);
      if (!Number.isFinite(level) || level < 65) continue;
      const info = areaInfo(id);
      if (info.category !== "map") continue;
      const tier = mapTierFromLevel(level);
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(tier).toBeLessThanOrEqual(16);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("classifies run kinds and boundaries", () => {
    expect(runKindFor(areaInfo("MapSunTemple"), 79)).toBe("map");
    expect(runKindFor(areaInfo("MapSunTemple"), 40)).toBeUndefined();
    expect(runKindFor(areaInfo("MapHideoutShoreline_Claimable"), 46)).toBeUndefined();
    expect(runKindFor(areaInfo("BreachDomain_01"), 80)).toBe("league");
    expect(runKindFor(areaInfo("Sanctum_1_1"), 70)).toBe("trial");
    expect(runKindFor(areaInfo("G1_1"), 1)).toBeUndefined();
    expect(isRunBoundary("hideout")).toBe(true);
    expect(isRunBoundary("town")).toBe(true);
    expect(isRunBoundary("endgame-town")).toBe(true);
    expect(isRunBoundary("map")).toBe(false);
  });

  it("ranks campaign areas by part, act and level with towns last", () => {
    const first = campaignRank(areaInfo("G1_1"));
    const town = campaignRank(areaInfo("G1_town"));
    const act2 = campaignRank(areaInfo("G2_1"));
    expect(first).toBeLessThan(town!);
    expect(town).toBeLessThan(act2!);
    expect(campaignRank(areaInfo("MapSunTemple"))).toBeUndefined();
  });

  it("turns the level delta into a tone without percentages or the word XP", () => {
    expect(experienceHint(80, 90)).toMatchObject({ delta: -10, tone: "warning" });
    expect(experienceHint(90, 80)).toMatchObject({ delta: 10, tone: "neutral" });
    expect(experienceHint(80, 80)).toMatchObject({ delta: 0, tone: "safe" });
    expect(experienceHint(undefined, 80).tone).toBe("neutral");
    for (const level of [70, 80, 90]) {
      expect(experienceHint(level, 80).hint ?? "").not.toMatch(/%|XP/i);
    }
  });

  it("formats durations", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(769_000)).toBe("12m 49s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });

  it("builds stable ids", () => {
    expect(newSessionId("2026-09-11T21:00:00.000Z")).toBe("ses-2026-09-11T21-00-00-000Z");
    expect(newRunId("2026-09-11T21:00:41.000Z", "Map Sun/Temple")).toBe(
      "run-2026-09-11T21-00-41-000Z-MapSunTemple",
    );
  });
});

describe("session tracker — the worked mapping session", () => {
  const startedAt = at(21, 0);
  const state = fold("client-log-mapping.txt", startedAt);

  it("starts one run per map, resumes the same instance and nests the Breach domain", () => {
    expect(state.runs).toHaveLength(2);
    const [first, second] = state.runs;
    expect(first.areaId).toBe("MapSunTemple");
    expect(first.tier).toBe(15);
    expect(first.portals).toBe(1);
    expect(first.subAreas).toEqual(["BreachDomain_01"]);
    expect(first.deaths).toBe(1);
    expect(first.completed).toBe(true);
    expect(first.endedBy).toBe("hideout");
    expect(first.activeMs).toBe(769_000);
    expect(first.wallMs).toBe(799_000);
    expect(second.areaId).toBe("MapAugury");
    expect(second.tier).toBe(10);
    expect(second.endedAt).toBeUndefined();
    expect(second.suspendedAt).toBeDefined();
  });

  it("finalizes a run suspended past the resume window on a tick", () => {
    const before = applyTick(state, at(21, 50));
    expect(before.runs[1].endedAt).toBeUndefined();
    const ticked = applyTick(state, at(21, 56));
    expect(ticked.runs[1].endedAt).toBe(at(21, 25));
    expect(ticked.runs[1].completed).toBe(true);
    expect(ticked.runs[1].endedBy).toBe("hideout");
    expect(ticked.runs[1].activeMs).toBe(570_000);
  });

  it("produces the worked metrics at 22:00", () => {
    const ticked = applyTick(state, at(21, 56));
    const metrics = sessionMetrics(ticked, at(22, 0));
    expect(metrics.wallMs).toBe(3_600_000);
    expect(metrics.afkMs).toBe(1_200_000);
    expect(metrics.activeMs).toBe(2_400_000);
    expect(metrics.mapsCompleted).toBe(2);
    expect(metrics.mapsPerHour).toBe(3);
    expect(formatDuration(metrics.avgMapMs)).toBe("11m 10s");
    expect(metrics.deathsInMaps).toBe(1);
    expect(metrics.deathsPerMap).toBe(0.5);
  });

  it("leaves maps per hour undefined under the rate window", () => {
    const metrics = sessionMetrics(state, at(21, 5));
    expect(metrics.mapsPerHour).toBeUndefined();
  });

  it("attaches the instance address to the visit that followed it", () => {
    const mapVisit = state.areas.find((visit) => visit.areaId === "MapSunTemple");
    expect(mapVisit?.instance).toBe("64.87.48.12:21360");
  });

  it("closes the open visit, run and AFK span when the session ends", () => {
    const open = applyEvent(state, {
      kind: "afk",
      at: at(22, 10),
      on: true,
    });
    const ended = endSession(open, at(22, 20), "game-exit");
    expect(ended.endReason).toBe("game-exit");
    expect(ended.current).toBeUndefined();
    expect(ended.afk.at(-1)?.to).toBe(at(22, 20));
    expect(ended.runs.every((run) => run.endedAt)).toBe(true);
  });
});

describe("session tracker — campaign and characters", () => {
  const state = fold("client-log-campaign.txt", at(18, 0));

  it("never starts a run in a campaign area and tracks progress by rank", () => {
    expect(state.runs).toHaveLength(0);
    expect(state.campaign?.areaId).toBe("G2_1");
    expect(state.campaign?.act).toBe(2);
    expect(state.campaign?.complete).toBe(false);
  });

  it("treats a claimable MapHideout area as a plain visit", () => {
    expect(state.current?.areaId).toBe("MapHideoutShoreline_Claimable");
    expect(state.current?.runId).toBeUndefined();
    expect(state.runs).toHaveLength(0);
  });

  it("keeps the level-up character and counts levels gained", () => {
    const character = currentCharacter(state);
    expect(character?.name).toBe("Himbo");
    expect(character?.level).toBe(17);
    expect(character?.source).toBe("level-up");
    expect(sessionMetrics(state, at(19, 30)).levelsGained).toBe(9);
  });

  it("prefers a level-up over the override and the death name", () => {
    const withOverride = setCharacterOverride(
      state,
      { name: "Manual", className: "Warrior", level: 1 },
      at(19, 0),
    );
    expect(currentCharacter(withOverride)?.name).toBe("Himbo");
    const bare = setCharacterOverride(
      startSession("ses-x", at(18, 0)),
      { name: "Manual", level: 12 },
      at(18, 0),
    );
    expect(currentCharacter(bare)?.name).toBe("Manual");
    expect(currentCharacter(setCharacterOverride(bare, undefined, at(18, 1)))).toBeUndefined();
  });

  it("records a second character without starting a new session", () => {
    const switched = applyEvent(state, {
      kind: "level-up",
      at: at(19, 20),
      character: "Otherguy",
      className: "Warrior",
      level: 4,
    });
    expect(switched.characters.map((entry) => entry.name)).toContain("Himbo");
    expect(currentCharacter(switched)?.name).toBe("Otherguy");
    expect(switched.id).toBe(state.id);
  });
});

describe("session tracker — bounds and junk", () => {
  it("drops the oldest visits beyond the cap and counts them", () => {
    let state = startSession("ses-cap", "2026-09-11T00:00:00.000Z");
    for (let index = 0; index < MAX_AREAS + 5; index += 1) {
      state = applyEvent(state, {
        kind: "area",
        at: new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString(),
        areaId: `MapSunTemple`,
        level: 79,
        seed: index,
        info: areaInfo("MapSunTemple"),
      });
    }
    expect(state.areas.length).toBe(MAX_AREAS);
    expect(state.areasDropped).toBeGreaterThan(0);
  });

  it("ignores a malformed event instead of throwing", () => {
    const state = startSession("ses-junk", "2026-09-11T00:00:00.000Z");
    const next = applyEvent(state, { kind: "area" } as unknown as ClientLogEvent);
    expect(next.eventCount).toBe(1);
    expect(next.runs).toHaveLength(0);
  });

  it("counts trades and whispers", () => {
    let state = startSession("ses-trade", "2026-09-11T00:00:00.000Z");
    state = applyEvent(state, { kind: "trade", at: "2026-09-11T00:01:00.000Z", result: "accepted" });
    state = applyEvent(state, { kind: "trade", at: "2026-09-11T00:02:00.000Z", result: "cancelled" });
    state = applyEvent(state, {
      kind: "whisper",
      at: "2026-09-11T00:03:00.000Z",
      direction: "in",
      player: "Buyer",
      text: "hi",
    });
    expect(state.trades).toEqual({ accepted: 1, cancelled: 1 });
    expect(state.whispers).toEqual({ in: 1, out: 0 });
  });
});
