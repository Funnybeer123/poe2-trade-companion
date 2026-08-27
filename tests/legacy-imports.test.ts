import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_LEGACY_IMPORT_BYTES,
  parseLegacyRegexHistory,
  parseLegacyScanHistory,
  parseLegacyScanJsonl,
  parseLegacyTradePresets,
} from "../src/core/legacyImports.js";

const fixture = (name: string): string =>
  readFileSync(path.join(process.cwd(), "fixtures", "imports", name), "utf8");

describe("legacy import parsers", () => {
  it("parses scan_history.json aliases and warns for dropped records", () => {
    const result = parseLegacyScanHistory(fixture("scan_history.json"));

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "legacy-life",
      name: "Life and resistance",
      regex: "\"maximum Life\"|\"Fire Resistance\"",
      createdAt: "2026-08-20T12:00:00.000Z",
    });
    expect(result.records[1]).toMatchObject({
      id: "legacy-speed",
      name: "Movement speed",
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "missing-regex", recordIndex: 2 }),
    ]);
  });

  it("parses saved regex history strings and PascalCase entries", () => {
    const result = parseLegacyRegexHistory(fixture("regex-history.json"));

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      name: "Imported regex 1",
      regex: "\"Spirit\"",
    });
    expect(result.records[1]).toMatchObject({
      name: "High energy shield",
      regex: "\"Energy Shield\"",
      createdAt: "2026-08-21T20:30:00.000Z",
    });
    expect(result.warnings).toEqual([]);
  });

  it("parses legacy trade presets and embedded query JSON without network access", () => {
    const result = parseLegacyTradePresets(fixture("trade-presets.json"));

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "rings-1",
      name: "Resistance rings",
      league: "Standard",
      sourceUrl:
        "https://www.pathofexile.com/trade2/search/poe2/Standard/opaque123",
      tags: ["resistance", "ring"],
    });
    expect(result.records[1]?.query).toEqual({
      query: { type: "Boots", stats: [] },
      sort: { price: "asc" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("parses camelCase and PascalCase legacy scan JSONL", () => {
    const result = parseLegacyScanJsonl(fixture("legacy-scan.jsonl"));

    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      sessionId: "legacy-run-1",
      slotKey: "0,0",
      scannedAt: "2026-08-20T10:00:00.000Z",
      itemFingerprint: "fp-one",
      status: "matched",
    });
    expect(result.records[1]).toMatchObject({
      sessionId: "legacy-run-1",
      slotKey: "1,0",
      status: "empty",
    });
    expect(result.records[2]).toMatchObject({
      sessionId: "legacy-run-2",
      itemFingerprint: "fp-two",
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps valid JSONL around malformed lines and tolerates a partial final line", () => {
    const valid =
      '{"SessionId":"run","Slot":"0","ScannedAt":"2026-08-20T10:00:00Z"}';
    const input = `${valid}\n{not-json}\n{"SessionId":"run","Slot":"2"`;
    const result = parseLegacyScanJsonl(input);

    expect(result.records).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "malformed-jsonl-line",
      "partial-final-line",
    ]);
    expect(result.warnings.map((warning) => warning.line)).toEqual([2, 3]);

    const validWithoutNewline = parseLegacyScanJsonl(
      '{"SessionId":"run","Slot":"last"}',
    );
    expect(validWithoutNewline.records).toHaveLength(1);
    expect(validWithoutNewline.warnings).toEqual([]);
  });

  it("returns warnings rather than parsing oversized or malformed documents", () => {
    const oversized = parseLegacyScanHistory(
      " ".repeat(MAX_LEGACY_IMPORT_BYTES + 1),
    );
    expect(oversized.records).toEqual([]);
    expect(oversized.warnings[0]?.code).toBe("input-too-large");

    const malformed = parseLegacyTradePresets("{bad");
    expect(malformed.records).toEqual([]);
    expect(malformed.warnings[0]?.code).toBe("malformed-json");
  });
});
