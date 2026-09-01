import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyProfile } from "../src/core/calibrationProfile.js";
import {
  buildCursorFixPrompt,
  compactCursorFixPrompt,
  CURSOR_DEEPLINK_MAX_CHARS,
  cursorPromptDeeplink,
  fitPromptForDeeplink,
  hasCursorHandoffFindings,
  redactHandoffText,
  summarizeAssistiveResult,
  summarizeCalibration,
  type CursorHandoffEvidence,
} from "../src/core/cursorHandoff.js";
import { recordOccupancyLabel, type OccupancyLabel } from "../src/core/occupancyLabels.js";
import {
  gatherCursorHandoffEvidence,
  launchCursorWithPrompt,
} from "../src/main/cursorHandoff.js";

const CLIENT = { width: 1600, height: 900 };

function profile() {
  return {
    ...emptyProfile(CLIENT.width, CLIENT.height),
    stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
    bagGrid: { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 },
    stashSearch: { x: 200, y: 790, w: 300, h: 30 },
    activeStashTab: "normal" as const,
  };
}

function wrongLabel(overrides: Partial<OccupancyLabel> = {}): OccupancyLabel {
  return {
    timestamp: "2026-08-27T00:00:00.000Z",
    area: "stash",
    row: 1,
    col: 2,
    perceivedOccupied: true,
    label: "wrong",
    evidenceHash: "hash-1",
    screenshotId: "assistive-1.png",
    ...overrides,
  };
}

function evidence(overrides: Partial<CursorHandoffEvidence> = {}): CursorHandoffEvidence {
  return {
    createdAt: "2026-08-27T00:01:00.000Z",
    occupancyLabels: [
      wrongLabel(),
      {
        timestamp: "2026-08-27T00:00:01.000Z",
        area: "bag",
        row: 0,
        col: 4,
        perceivedOccupied: false,
        label: "right",
      },
    ],
    sessionLabels: [
      {
        area: "stash",
        row: 1,
        col: 2,
        perceivedOccupied: true,
        label: "wrong",
      },
    ],
    selected: [{ area: "stash", row: 1, col: 2, occupied: true }],
    lastResult: {
      ok: false,
      reason: "source-empty",
      kind: "empty",
      dryRun: true,
      cycles: 1,
      elapsedMs: 40,
      bagCells: 0,
      stashCells: 12,
      traces: [
        {
          timestamp: "2026-08-27T00:00:02.000Z",
          reason: "preview; safety=dry-run",
          result: "blocked",
          decisionRule: "dry-run-preview",
          input: { kind: "click", x: 211, y: 221 },
        },
      ],
    },
    overlay: {
      kind: "empty",
      client: CLIENT,
      grids: [
        { region: "stash", label: "Stash 12×12", cols: 12, rows: 12, x: 80, y: 144, w: 736, h: 630 },
        { region: "bag", label: "Bag 12×5", cols: 12, rows: 5, x: 1048, y: 324, w: 480, h: 450 },
      ],
      occupied: ["stash:0,0"],
      detected: ["stash:0,0", "stash:1,2"],
      items: [{ area: "stash", row: 0, col: 0, w: 1, h: 1, cellCount: 1 }],
      clicks: [{ n: 1, kind: "click", region: "stash" }],
      selected: [{ area: "stash", row: 1, col: 2, occupied: true }],
      evidenceHash: "hash-1",
      screenshotId: "assistive-1.png",
    },
    calibration: summarizeCalibration(profile()),
    traceTail: '{"module":"stash","reason":"preview; safety=dry-run","result":"blocked"}',
    occupancyLabelFile: "C:/tmp/occupancy-labels.jsonl",
    traceFile: "C:/tmp/qa-action-trace.jsonl",
    screenshotId: "assistive-1.png",
    workspace: "C:/repos/poe2-trade-companion",
    ...overrides,
  };
}

describe("cursor handoff prompt", () => {
  it("builds a self-contained prompt from Wrong labels and a failed dry-run result", () => {
    const prompt = buildCursorFixPrompt(evidence(), { promptPath: "C:/tmp/cursor-handoff-latest.md" });
    expect(prompt).toContain("Fix Path of Exile 2 companion perception/transfer");
    expect(prompt).toContain("stash r1 c2 perceived occupied → wrong (false-occupied)");
    expect(prompt).toContain("kind=empty");
    expect(prompt).toContain("dryRun=true");
    expect(prompt).toContain("ok=false");
    expect(prompt).toContain("reason=source-empty");
    expect(prompt).toContain("bagCells=0");
    expect(prompt).toContain("stashCells=12");
    expect(prompt).toContain("search present: yes");
    expect(prompt).toContain("plannedClicks=1");
    expect(prompt).toContain("qa-action-trace");
    expect(prompt).toContain("Do not revert Empty-when-bag-empty");
    expect(prompt).not.toContain("Listen once");
  });

  it("redacts account/session cookie material from the prompt", () => {
    const prompt = buildCursorFixPrompt(
      evidence({
        lastResult: {
          ok: false,
          reason: "blocked cookie=POESESSID=abc123secret cf_clearance=tok",
          kind: "fill",
          dryRun: true,
          bagCells: 1,
          stashCells: 4,
        },
        traceTail: 'POESESSID=abc123secret; Bearer eyJhbGciOi.secret',
      }),
    );
    expect(prompt).not.toContain("abc123secret");
    expect(prompt).not.toContain("eyJhbGciOi.secret");
    expect(prompt).toContain("POESESSID=[redacted]");
    expect(prompt).toContain("Bearer [redacted]");
  });

  it("treats Wrong labels, selected cells, overlay, and failed runs as findings", () => {
    expect(hasCursorHandoffFindings(evidence({ occupancyLabels: [], sessionLabels: [], selected: [], overlay: null, lastResult: null }))).toBe(false);
    expect(hasCursorHandoffFindings(evidence({ lastResult: null, overlay: null, selected: [], sessionLabels: [] }))).toBe(true);
    expect(
      hasCursorHandoffFindings(
        evidence({
          occupancyLabels: [],
          sessionLabels: [],
          selected: [],
          overlay: null,
          lastResult: { ok: true, reason: "ok", kind: "empty", dryRun: false, bagCells: 0, stashCells: 4 },
        }),
      ),
    ).toBe(false);
    expect(
      hasCursorHandoffFindings(
        evidence({
          occupancyLabels: [],
          sessionLabels: [],
          selected: [],
          overlay: null,
          lastResult: { ok: true, reason: "dry-run-preview", kind: "fill", dryRun: true, bagCells: 2, stashCells: 8 },
        }),
      ),
    ).toBe(true);
  });

  it("fits the Cursor prompt deeplink under the documented URL limit", () => {
    const compact = compactCursorFixPrompt(evidence(), { promptPath: "C:/tmp/cursor-handoff-latest.md" });
    const href = cursorPromptDeeplink(compact);
    expect(href.startsWith("cursor://anysphere.cursor-deeplink/prompt?text=")).toBe(true);
    expect(href.length).toBeLessThanOrEqual(CURSOR_DEEPLINK_MAX_CHARS);
    const fitted = fitPromptForDeeplink("x".repeat(20_000), { promptPath: "C:/tmp/full.md" });
    expect(fitted.truncated).toBe(true);
    expect(fitted.href.length).toBeLessThanOrEqual(CURSOR_DEEPLINK_MAX_CHARS);
    expect(fitted.href).toContain("cursor://anysphere.cursor-deeplink/prompt");
  });

  it("summarizes calibration without pixel patches or account fields", () => {
    const summary = summarizeCalibration(profile());
    expect(summary).toEqual({
      client: CLIENT,
      activeStashTab: "normal",
      stash: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12 },
      bag: { x: 1048, y: 324, w: 480, h: 450, cols: 12, rows: 5 },
      searchPresent: true,
      gridsReady: true,
    });
    expect(JSON.stringify(summary)).not.toContain("patch");
  });

  it("drops typed text from assistive traces so item clipboard does not leak", () => {
    const summarized = summarizeAssistiveResult({
      ok: false,
      reason: "failed",
      kind: "fill",
      dryRun: true,
      bagCells: 1,
      stashCells: 2,
      traces: [
        {
          reason: "typed",
          input: { kind: "type", x: 1, y: 2 },
        },
      ],
    });
    expect(summarized.traces?.[0]?.input).toEqual({ kind: "type", x: 1, y: 2 });
  });
});

describe("cursor handoff gather/launch", () => {
  it("packages occupancy-labels.jsonl and the qa-action-trace tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-cursor-handoff-"));
    const artifactDir = path.join(root, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    recordOccupancyLabel(root, {
      timestamp: "2026-08-27T00:00:00.000Z",
      area: "bag",
      row: 0,
      col: 1,
      perceivedOccupied: false,
      label: "wrong",
      evidenceHash: "hash-live",
    });
    writeFileSync(
      path.join(artifactDir, "qa-action-trace.jsonl"),
      `${JSON.stringify({ module: "stash", reason: "dry-run-preview", result: "blocked" })}\n`,
    );
    const gathered = gatherCursorHandoffEvidence({
      memoryRoot: root,
      artifactDir,
      profile: profile(),
      snapshot: {
        last: {
          ok: false,
          reason: "source-empty",
          kind: "empty",
          dryRun: true,
          bagCells: 0,
          stashCells: 3,
        },
        overlayPlan: null,
        overlaySelection: [{ area: "bag", row: 0, col: 1, occupied: false }],
        overlaySessionLabels: [
          { area: "bag", row: 0, col: 1, perceivedOccupied: false, label: "wrong" },
        ],
      },
      createdAt: "2026-08-27T00:02:00.000Z",
    });
    expect(gathered.occupancyLabels).toEqual([
      expect.objectContaining({ area: "bag", row: 0, col: 1, label: "wrong" }),
    ]);
    expect(gathered.traceTail).toContain("dry-run-preview");
    expect(gathered.selected).toEqual([{ area: "bag", row: 0, col: 1, occupied: false }]);
  });

  it("opens the Cursor prompt deeplink and copies the full prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-cursor-launch-"));
    const opened: string[] = [];
    let copied = "";
    const result = await launchCursorWithPrompt(evidence(), { artifactDir: root }, {
      writeText: (text) => {
        copied = text;
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.copied).toBe(true);
    expect(result.method).toBe("deeplink");
    expect(result.message).toContain("Opened Cursor");
    expect(opened[0]).toMatch(/^cursor:\/\/anysphere.cursor-deeplink\/prompt\?text=/);
    expect(copied).toContain("stash r1 c2 perceived occupied");
    expect(copied).toContain(result.promptPath);
  });

  it("falls back to clipboard when the deeplink cannot open", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "poe2-cursor-clip-"));
    const spawned: string[][] = [];
    const result = await launchCursorWithPrompt(evidence({ workspace: root }), { artifactDir: root }, {
      writeText: () => undefined,
      openExternal: async () => {
        throw new Error("no-protocol");
      },
      spawnCursor: async (args) => {
        spawned.push(args);
        return true;
      },
    });
    expect(result.opened).toBe(false);
    expect(result.copied).toBe(true);
    expect(result.method).toBe("clipboard");
    expect(result.message).toContain("clipboard");
    expect(spawned).toEqual([["cursor", root]]);
  });

  it("does not launch Cursor when there are no findings", async () => {
    const result = await launchCursorWithPrompt(
      evidence({
        occupancyLabels: [],
        sessionLabels: [],
        selected: [],
        lastResult: null,
        overlay: null,
        traceTail: "",
      }),
      { artifactDir: mkdtempSync(path.join(tmpdir(), "poe2-cursor-empty-")) },
      {
        writeText: () => {
          throw new Error("should-not-copy");
        },
        openExternal: async () => {
          throw new Error("should-not-open");
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      opened: false,
      copied: false,
      findings: false,
      method: "none",
    });
  });
});

describe("redact helpers", () => {
  it("scrubs cookie-shaped strings", () => {
    expect(redactHandoffText("sid=POESESSID=deadbeef; cf_clearance=aa")).toBe(
      "sid=POESESSID=[redacted]; cf_clearance=[redacted]",
    );
  });
});
