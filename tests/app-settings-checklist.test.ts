import { describe, expect, it } from "vitest";
import {
  deriveSetupChecklist,
  FEED_STALE_AFTER_HOURS,
  type ChecklistInput,
} from "../src/core/appSettingsChecklist.js";
import type { SetupChecklist, SetupStepId } from "../src/shared/appSettings.js";

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    now: "2026-09-12T10:00:00.000Z",
    poeRunning: true,
    clientLog: { watching: true, source: "steam", file: "C:/poe/logs/Client.txt" },
    feed: {
      resolvedLeague: "Runes of Aldur",
      leagueAmbiguous: false,
      candidates: 1,
      feedEntryCount: 412,
      feedAgeHours: 3,
      hasSession: false,
    },
    hotkeys: { total: 9, errors: [] },
    overlay: { windowVisible: false },
    calibration: { hasStashGrid: false, hasBagGrid: false, hasSearchBox: false },
    ...overrides,
  };
}

function step(checklist: SetupChecklist, id: SetupStepId) {
  const found = checklist.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe("deriveSetupChecklist", () => {
  it("counts exactly the five required steps", () => {
    const checklist = deriveSetupChecklist(input());
    expect(checklist.required).toBe(5);
    expect(checklist.steps.filter((entry) => !entry.optional).map((entry) => entry.id)).toEqual([
      "client-log",
      "league",
      "price-feed",
      "hotkeys",
      "overlay",
    ]);
    expect(checklist.steps).toHaveLength(10);
    expect(checklist.generatedAt).toBe("2026-09-12T10:00:00.000Z");
  });

  it("reproduces the fresh-install example", () => {
    const checklist = deriveSetupChecklist(
      input({
        feed: {
          leagueAmbiguous: true,
          candidates: 2,
          feedEntryCount: 0,
          hasSession: false,
        },
      }),
    );
    expect(step(checklist, "league").state).toBe("warn");
    expect(step(checklist, "league").detail).toContain("2 current leagues");
    expect(step(checklist, "price-feed").state).toBe("todo");
    expect(step(checklist, "overlay").state).toBe("todo");
    expect(step(checklist, "admin-rights").state).toBe("unknown");
    expect(checklist.done).toBe(2);
    expect(checklist.complete).toBe(false);
  });

  it("reaches complete without any optional step", () => {
    const checklist = deriveSetupChecklist(
      input({ poeRunning: false, overlay: { windowVisible: false, testedAt: "2026-09-12T09:58:11.000Z" } }),
    );
    expect(checklist.done).toBe(5);
    expect(checklist.complete).toBe(true);
    expect(step(checklist, "game-detected").state).toBe("optional");
    expect(step(checklist, "overlay").detail).toContain("Tested ");
  });

  it("shows the client-log error and falls back to todo when nothing was found", () => {
    const failed = deriveSetupChecklist(
      input({ clientLog: { watching: false, source: "none", error: "access denied" } }),
    );
    expect(step(failed, "client-log")).toMatchObject({ state: "warn", detail: "access denied" });

    const missing = deriveSetupChecklist(input({ clientLog: { watching: false, source: "none" } }));
    expect(step(missing, "client-log").state).toBe("todo");
    expect(step(missing, "client-log").action).toBe("browse-log");
  });

  it("reports a league that is not resolved yet with the feed error", () => {
    const checklist = deriveSetupChecklist(
      input({
        feed: { leagueAmbiguous: false, candidates: 0, lastError: "poe2scout unreachable", feedEntryCount: 0, hasSession: false },
      }),
    );
    expect(step(checklist, "league")).toMatchObject({
      state: "todo",
      detail: "poe2scout unreachable",
      action: "check-leagues",
    });
  });

  it("warns about a stale feed but keeps the count", () => {
    const checklist = deriveSetupChecklist(
      input({
        feed: {
          resolvedLeague: "Runes of Aldur",
          leagueAmbiguous: false,
          candidates: 1,
          feedEntryCount: 412,
          feedAgeHours: FEED_STALE_AFTER_HOURS + 1,
          hasSession: false,
        },
      }),
    );
    expect(step(checklist, "price-feed").state).toBe("warn");
    expect(step(checklist, "price-feed").detail).toContain("412 feed prices");
    expect(step(checklist, "price-feed").detail).toContain("refresh");
  });

  it("treats the session cookie as optional and marks it ok when saved", () => {
    const without = deriveSetupChecklist(input());
    expect(step(without, "session-cookie")).toMatchObject({ state: "optional", action: "open-market-data" });
    const withCookie = deriveSetupChecklist(
      input({ feed: { ...input().feed, hasSession: true } }),
    );
    expect(step(withCookie, "session-cookie").state).toBe("ok");
    expect(step(withCookie, "session-cookie").action).toBeUndefined();
  });

  it("lists hotkeys that could not be registered", () => {
    const checklist = deriveSetupChecklist(
      input({
        hotkeys: {
          total: 9,
          errors: [{ id: "evaluate", label: "Evaluate", error: "Alt+E could not be registered" }],
        },
      }),
    );
    expect(step(checklist, "hotkeys").state).toBe("warn");
    expect(step(checklist, "hotkeys").detail).toBe(
      "1 not active: Evaluate (Alt+E could not be registered)",
    );

    const none = deriveSetupChecklist(input({ hotkeys: { total: 0, errors: [] } }));
    expect(step(none, "hotkeys").state).toBe("unknown");
  });

  it("covers every admin-rights branch and never blocks completion", () => {
    const notChecked = deriveSetupChecklist(input());
    expect(step(notChecked, "admin-rights")).toMatchObject({ state: "unknown", optional: true });

    const warned = deriveSetupChecklist(
      input({ elevation: { hint: "the game runs elevated", verdict: "likely", appElevated: false } }),
    );
    expect(step(warned, "admin-rights")).toMatchObject({ state: "warn", detail: "the game runs elevated" });

    const elevatedApp = deriveSetupChecklist(
      input({ elevation: { verdict: "unknown", appElevated: true } }),
    );
    expect(step(elevatedApp, "admin-rights").state).toBe("ok");

    const same = deriveSetupChecklist(input({ elevation: { verdict: "no", appElevated: false } }));
    expect(step(same, "admin-rights").state).toBe("ok");

    const unclear = deriveSetupChecklist(input({ elevation: { verdict: "unknown", appElevated: false } }));
    expect(step(unclear, "admin-rights").state).toBe("unknown");
  });

  it("marks calibration ok only with both grids", () => {
    const partial = deriveSetupChecklist(
      input({ calibration: { hasStashGrid: true, hasBagGrid: false, hasSearchBox: true } }),
    );
    expect(step(partial, "calibration")).toMatchObject({ state: "optional", action: "open-calibration" });

    const ready = deriveSetupChecklist(
      input({ calibration: { hasStashGrid: true, hasBagGrid: true, hasSearchBox: true } }),
    );
    expect(step(ready, "calibration").state).toBe("ok");
  });

  it("describes the chat-command kill switches and the dry-run flag", () => {
    const absent = deriveSetupChecklist(input());
    expect(step(absent, "chat-commands").state).toBe("unknown");

    const off = deriveSetupChecklist(input({ chatCommands: { enabled: false, dryRun: false } }));
    expect(step(off, "chat-commands")).toMatchObject({ state: "optional", action: "open-settings" });

    const on = deriveSetupChecklist(input({ chatCommands: { enabled: true, dryRun: true } }));
    expect(step(on, "chat-commands").state).toBe("ok");
    expect(step(on, "chat-commands").detail).toContain("Ctrl+Shift+Esc");
    expect(step(on, "chat-commands").detail).toContain("Dry-run");
    expect(step(on, "chat-commands").detail).toContain("dry-run on");
  });

  it("passes the dismissal timestamp through", () => {
    const checklist = deriveSetupChecklist(input({ dismissedAt: "2026-09-12T10:00:00.000Z" }));
    expect(checklist.dismissedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(deriveSetupChecklist(input()).dismissedAt).toBeUndefined();
  });
});
