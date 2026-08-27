import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportLegacyScanJsonl,
  importLegacyScanJsonl,
  isUtcTimestamp,
  parseJsonlWithPartialRecovery,
  toUtcTimestamp,
} from "../src/core/scanContracts.js";
import { TEST_SCAN_CONTEXT } from "./scanFixtures.js";

const fixture = readFileSync(
  path.join(
    process.cwd(),
    "fixtures",
    "scans",
    "legacy-camel-pascal.jsonl",
  ),
  "utf8",
);

describe("versioned scan contracts", () => {
  it("normalizes timestamps to canonical UTC", () => {
    expect(toUtcTimestamp("2026-08-26T01:00:00-05:00")).toBe(
      "2026-08-26T06:00:00.000Z",
    );
    expect(isUtcTimestamp("2026-08-26T06:00:00.000Z")).toBe(true);
    expect(isUtcTimestamp("2026-08-26T01:00:00-05:00")).toBe(false);
  });

  it("imports mixed camelCase/PascalCase legacy records as 0-based client-relative records", () => {
    const imported = importLegacyScanJsonl(fixture, {
      sessionId: "legacy-session",
      context: TEST_SCAN_CONTEXT,
    });

    expect(imported.issues).toEqual([]);
    expect(imported.records).toHaveLength(2);
    expect(imported.records[0]).toMatchObject({
      schemaVersion: 1,
      recordType: "scan-slot",
      cell: { row: 0, col: 1 },
      clientPoint: { x: 10, y: 20 },
      status: "copied",
      observedAt: "2026-08-26T06:00:00.000Z",
      footprint: { known: true, width: 1, height: 1, source: "legacy" },
      context: {
        coordinateSpace: {
          kind: "client-relative",
          origin: "client-top-left",
          gridIndexBase: 0,
        },
      },
    });
    expect(imported.records[1]).toMatchObject({
      cell: { row: 1, col: 2 },
      clientPoint: { x: 25, y: 35 },
      status: "skipped-footprint",
      claimedBy: { row: 0, col: 1 },
    });
  });

  it("recovers an unterminated partial final line without discarding complete records", () => {
    const imported = importLegacyScanJsonl(
      `${fixture}{"Row":3,"Column":`,
      {
        sessionId: "partial-session",
        context: TEST_SCAN_CONTEXT,
      },
    );

    expect(imported.records).toHaveLength(2);
    expect(imported.recoveredPartialLine).toBe(true);
    expect(imported.partialLine).toContain('"Row":3');
    expect(imported.issues).toEqual([]);
  });

  it("infers copied versus empty for statusless upstream records", () => {
    const imported = importLegacyScanJsonl(
      [
        JSON.stringify({
          sessionId: "old",
          scanType: "inventory",
          profileIndex: 2,
          rows: 5,
          cols: 12,
          row: 1,
          col: 1,
          x: 105,
          y: 205,
          capturedAt: "2026-08-26T06:00:00Z",
          itemText: "Item Class: Currency\nRarity: Normal\nChaos Orb",
        }),
        JSON.stringify({
          sessionId: "old",
          scanType: "inventory",
          profileIndex: 2,
          rows: 5,
          cols: 12,
          row: 1,
          col: 2,
          x: 115,
          y: 205,
          capturedAt: "2026-08-26T06:00:01Z",
          itemText: "",
        }),
        "",
      ].join("\n"),
      {
        sessionId: "upstream-session",
        context: TEST_SCAN_CONTEXT,
        clientOrigin: { x: 100, y: 200 },
      },
    );

    expect(imported.issues).toEqual([]);
    expect(imported.records.map((record) => record.status)).toEqual([
      "copied",
      "empty",
    ]);
  });

  it("reports malformed complete lines and continues with later valid lines", () => {
    const parsed = parseJsonlWithPartialRecovery(
      '{"value":1}\nnot-json\n{"value":2}\n',
      (value) => value as { value: number },
    );

    expect(parsed.records.map((record) => record.value)).toEqual([1, 2]);
    expect(parsed.issues).toMatchObject([{ lineNumber: 2 }]);
    expect(parsed.recoveredPartialLine).toBe(false);
  });

  it("exports 1-based absolute camelCase and PascalCase legacy JSONL", () => {
    const records = importLegacyScanJsonl(fixture, {
      sessionId: "export-session",
      context: TEST_SCAN_CONTEXT,
    }).records;
    const camel = exportLegacyScanJsonl(records, {
      style: "camelCase",
      clientOrigin: { x: 300, y: 400 },
    });
    const pascal = exportLegacyScanJsonl(records, {
      style: "PascalCase",
      clientOrigin: { x: 300, y: 400 },
    });
    const camelFirst = JSON.parse(camel.split("\n")[0]!) as Record<string, unknown>;
    const pascalFirst = JSON.parse(pascal.split("\n")[0]!) as Record<string, unknown>;

    expect(camelFirst).toMatchObject({
      scanType: "inventory",
      profileIndex: 0,
      rows: 5,
      cols: 12,
      row: 1,
      column: 2,
      x: 310,
      y: 420,
      coordinateSpace: "absolute-screen",
      indexBase: 1,
      capturedAt: "2026-08-26T06:00:00.000Z",
    });
    expect(pascalFirst).toMatchObject({
      ScanType: "inventory",
      ProfileIndex: 0,
      Rows: 5,
      Cols: 12,
      Row: 1,
      Column: 2,
      X: 310,
      Y: 420,
      CoordinateSpace: "absolute-screen",
      IndexBase: 1,
    });
  });
});
