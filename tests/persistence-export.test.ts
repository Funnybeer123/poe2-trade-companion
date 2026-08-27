import { describe, expect, it } from "vitest";
import { parseLegacyRegexHistory, parseLegacyScanJsonl } from "../src/core/legacyImports.js";
import {
  exportIntelligenceData,
  openLocalPersistence,
} from "../src/main/persistence/index.js";

const NOW = "2026-08-27T15:30:00.000Z";

describe("versioned local exports", () => {
  it("round-trips regex history and emits deterministic scan JSONL", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    persistence.ruleSets.upsert({
      kind: "stash-scan",
      name: "Defences",
      rules: [
        {
          id: "life-fire",
          name: "Life + fire",
          regex: "maximum Life\nFire Resistance",
          schemaVersion: 1,
        },
      ],
      active: true,
    });
    const session = persistence.scanSessions.upsert({
      id: "scan-one",
      source: "offline-replay",
      status: "finished",
      startedAt: NOW,
      endedAt: NOW,
    });
    persistence.scanSlots.upsert({
      sessionId: session.id,
      slotKey: "0,0",
      ordinal: 0,
      status: "matched",
      itemFingerprint: "fingerprint-one",
      scannedAt: NOW,
      payload: { item: { name: "Storm Loop" } },
    });

    const rules = exportIntelligenceData(
      persistence,
      { kind: "regex-history" },
      NOW,
    );
    expect(rules).toMatchObject({
      schemaVersion: 1,
      mimeType: "application/json",
      recordCount: 1,
    });
    expect(parseLegacyRegexHistory(rules.content).records).toMatchObject([
      {
        id: "life-fire",
        name: "Life + fire",
        regex: "maximum Life\nFire Resistance",
      },
    ]);

    const scan = exportIntelligenceData(
      persistence,
      { kind: "scan-jsonl", scanSessionId: session.id },
      NOW,
    );
    expect(scan).toMatchObject({
      mimeType: "application/x-ndjson",
      recordCount: 1,
    });
    expect(scan.content.endsWith("\n")).toBe(true);
    expect(parseLegacyScanJsonl(scan.content).records).toMatchObject([
      {
        sessionId: "scan-one",
        slotKey: "0,0",
        status: "matched",
        itemFingerprint: "fingerprint-one",
      },
    ]);
    persistence.close();
  });

  it("exports a bounded complete bundle and rejects unknown scan sessions", () => {
    const persistence = openLocalPersistence(":memory:", { clock: () => NOW });
    persistence.settings.set({ key: "ui.theme", value: "dark" });
    const bundle = exportIntelligenceData(
      persistence,
      { kind: "bundle" },
      NOW,
    );
    expect(JSON.parse(bundle.content)).toMatchObject({
      schemaVersion: 1,
      exportedAt: NOW,
      settings: [{ key: "ui.theme", value: "dark" }],
    });
    expect(() =>
      exportIntelligenceData(
        persistence,
        { kind: "scan-jsonl", scanSessionId: "missing" },
        NOW,
      ),
    ).toThrow("scan-session-not-found");
    persistence.close();
  });
});
