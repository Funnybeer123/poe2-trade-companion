import { describe, expect, it } from "vitest";
import {
  createScanPlanner,
  recordScanObservation,
  restoreScanPlannerSnapshot,
} from "../src/core/scanPlanner.js";
import {
  InMemoryScanSessionStorage,
  ScanSessionStore,
} from "../src/main/scanSessionStore.js";
import { TEST_SCAN_CONTEXT, slotDraft } from "./scanFixtures.js";

function clock() {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1_000).toISOString();
}

describe("scan session lifecycle", () => {
  it("keeps unique interleaved sessions without cross-session truncation", async () => {
    const storage = new InMemoryScanSessionStorage();
    const store = new ScanSessionStore(storage, { clock: clock() });
    await store.createSession({ id: "finished", context: TEST_SCAN_CONTEXT });
    await store.createSession({ id: "aborted", context: TEST_SCAN_CONTEXT });
    await store.createSession({ id: "failed", context: TEST_SCAN_CONTEXT });
    await store.appendSlot("finished", slotDraft(0, 0, 0, "copied"));
    await store.appendSlot("aborted", slotDraft(0, 0, 1, "empty"));
    await store.appendSlot("failed", slotDraft(0, 0, 2, "copy-timeout"));

    await store.finishSession("finished");
    await store.abortSession("aborted", "operator-stop");
    await store.failSession("failed", new Error("clipboard unavailable"));

    const reloaded = new ScanSessionStore(storage, { clock: clock() });
    const report = await reloaded.reload();
    const sessions = await reloaded.listSessions();
    expect(report.issues).toEqual([]);
    expect(sessions.map((session) => ({
      id: session.id,
      status: session.status,
      slots: session.slots.length,
    }))).toEqual([
      { id: "finished", status: "finished", slots: 1 },
      { id: "aborted", status: "aborted", slots: 1 },
      { id: "failed", status: "failed", slots: 1 },
    ]);
    expect((await reloaded.getSession("failed"))?.terminalError).toBe(
      "clipboard unavailable",
    );
    await expect(
      reloaded.appendSlot("finished", slotDraft(1, 0, 1)),
    ).rejects.toThrow("scan-session-terminal:finished");
  });

  it("rejects duplicate session identities, including after reload", async () => {
    const storage = new InMemoryScanSessionStorage();
    const store = new ScanSessionStore(storage);
    await store.createSession({ id: "same-id", context: TEST_SCAN_CONTEXT });
    await expect(
      store.createSession({ id: "same-id", context: TEST_SCAN_CONTEXT }),
    ).rejects.toThrow("duplicate-scan-session-id");

    const reloaded = new ScanSessionStore(storage);
    await reloaded.reload();
    await expect(
      reloaded.createSession({ id: "same-id", context: TEST_SCAN_CONTEXT }),
    ).rejects.toThrow("duplicate-scan-session-id");
  });

  it("bounds text and records while allowing ordered retries only", async () => {
    const storage = new InMemoryScanSessionStorage();
    const store = new ScanSessionStore(storage, {
      limits: {
        maxTextChars: 5,
        maxSlotRecordsPerSession: 3,
      },
    });
    await store.createSession({ id: "bounded", context: TEST_SCAN_CONTEXT });
    const first = await store.appendSlot(
      "bounded",
      slotDraft(0, 0, 0, "copied", 1, "123456789"),
    );
    expect(first.rawText).toBe("12345");
    expect(first.textTruncated).toBe(true);

    await expect(
      store.appendSlot("bounded", slotDraft(1, 0, 0, "copied", 2)),
    ).rejects.toThrow("duplicate-final-slot-coordinate:0,0");

    await store.appendSlot(
      "bounded",
      slotDraft(1, 0, 1, "copy-timeout", 1),
    );
    await expect(
      store.appendSlot("bounded", slotDraft(2, 0, 1, "copied", 3)),
    ).rejects.toThrow("scan-slot-attempt-gap:0,1");
    await store.appendSlot("bounded", slotDraft(2, 0, 1, "copied", 2));

    await expect(
      store.appendSlot("bounded", slotDraft(3, 0, 2, "empty", 1)),
    ).rejects.toThrow("scan-session-slot-cap-reached");
    expect((await store.getSession("bounded"))?.slots).toHaveLength(3);
  });

  it("reloads a planner snapshot and resumes an active session in order", async () => {
    const storage = new InMemoryScanSessionStorage();
    const firstStore = new ScanSessionStore(storage, { clock: clock() });
    await firstStore.createSession({
      id: "resume-me",
      context: TEST_SCAN_CONTEXT,
    });
    let planner = createScanPlanner({ grid: TEST_SCAN_CONTEXT.grid });
    planner = recordScanObservation(planner, {
      at: "2026-08-26T06:00:00.000Z",
      status: "empty",
    });
    await firstStore.appendSlot("resume-me", planner.records[0]!);
    await firstStore.savePlannerSnapshot("resume-me", planner);

    const secondStore = new ScanSessionStore(storage, { clock: clock() });
    const report = await secondStore.reload();
    expect(report).toMatchObject({
      recoveredPartialLine: false,
      issues: [],
      sessionsLoaded: 1,
    });
    const loaded = await secondStore.getSession("resume-me");
    expect(loaded?.status).toBe("active");
    planner = restoreScanPlannerSnapshot(loaded!.plannerSnapshot!);
    await secondStore.resumeSession("resume-me");
    planner = recordScanObservation(planner, {
      at: "2026-08-26T06:00:01.000Z",
      status: "empty",
    });
    await secondStore.appendSlot("resume-me", planner.records[1]!);
    await secondStore.savePlannerSnapshot("resume-me", planner);
    const finished = await secondStore.finishSession("resume-me");

    expect(finished.status).toBe("finished");
    expect(finished.slots.map((slot) => slot.sequence)).toEqual([0, 1]);
    expect(finished.plannerSnapshot?.cursor).toBe(2);
  });

  it("recovers a partial last JSONL line and safely appends later sessions", async () => {
    const original = new InMemoryScanSessionStorage();
    const firstStore = new ScanSessionStore(original);
    await firstStore.createSession({ id: "before-tail", context: TEST_SCAN_CONTEXT });

    const storage = new InMemoryScanSessionStorage(
      `${original.contents()}{"journalVersion":1`,
    );
    const recovering = new ScanSessionStore(storage);
    const firstReport = await recovering.reload();
    expect(firstReport.recoveredPartialLine).toBe(true);
    expect((await recovering.getSession("before-tail"))?.status).toBe("active");
    await recovering.createSession({ id: "after-tail", context: TEST_SCAN_CONTEXT });

    const finalStore = new ScanSessionStore(storage);
    const finalReport = await finalStore.reload();
    expect(finalReport.recoveredPartialLine).toBe(false);
    expect(finalReport.issues.some((issue) => issue.line.includes("journalVersion"))).toBe(
      true,
    );
    expect(
      (await finalStore.listSessions()).map((session) => session.id).sort(),
    ).toEqual(["after-tail", "before-tail"]);
  });

  it("persists before publishing and applies subscriber backpressure in event order", async () => {
    const storage = new InMemoryScanSessionStorage();
    const store = new ScanSessionStore(storage);
    const sequences: number[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listenerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    store.subscribe(async ({ event }) => {
      expect(storage.contents()).toContain(JSON.stringify(event));
      sequences.push(event.journalSequence);
      started();
      await gate;
    });

    let settled = false;
    const pending = store
      .createSession({ id: "ordered", context: TEST_SCAN_CONTEXT })
      .then((session) => {
        settled = true;
        return session;
      });
    await listenerStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    await store.resumeSession("ordered");

    expect(sequences).toEqual([0, 1]);
  });
});
