import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deathCaptureId,
  deathFileNames,
  parseDeathIndex,
  pruneDeathPlan,
  sanitizeDeathCapture,
  serializeDeathCapture,
  type DeathCapture,
} from "../src/core/sessionDeaths.js";

const INDEX = readFileSync(
  path.resolve(__dirname, "..", "fixtures", "session", "deaths.jsonl"),
  "utf8",
);

function capture(id: string, at: string): DeathCapture {
  return {
    id,
    at,
    kind: "death",
    file: `${id}.jpg`,
    thumbFile: `${id}.thumb.jpg`,
    width: 1920,
    height: 1080,
    bytes: 1000,
    sourceName: "Path of Exile 2",
  };
}

describe("death capture ids and names", () => {
  it("builds a file-safe id from the timestamp", () => {
    expect(deathCaptureId("2026-09-11T21:03:10.000Z", "death")).toBe(
      "cap-2026-09-11T21-03-10-000Z-death",
    );
    expect(deathCaptureId("2026-09-11T21:03:10.000Z", "manual")).toMatch(/-manual$/);
  });

  it("sanitizes the area token into the file name", () => {
    expect(deathFileNames("cap-1", "MapSunTemple")).toEqual({
      file: "cap-1-MapSunTemple.jpg",
      thumbFile: "cap-1-MapSunTemple.thumb.jpg",
    });
    expect(deathFileNames("cap-1", "../../etc/passwd").file).toBe("cap-1-etcpasswd.jpg");
    expect(deathFileNames("cap-1").file).toBe("cap-1.jpg");
    expect(deathFileNames("cap-1", "X".repeat(80)).file.length).toBeLessThan(60);
  });
});

describe("death index", () => {
  it("parses the fixture, dropping the torn line, the path escape and the duplicate", () => {
    const records = parseDeathIndex(INDEX);
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("cap-2026-09-11T21-03-10-000Z-death");
    expect(records[0].areaName).toBe("Sun Temple");
    expect(records[1].kind).toBe("manual");
  });

  it("refuses a record whose file name is not a basename", () => {
    expect(sanitizeDeathCapture({ ...capture("a", "2026-09-11T21:00:00.000Z"), file: "sub/dir.jpg" })).toBeUndefined();
    expect(sanitizeDeathCapture({ ...capture("a", "2026-09-11T21:00:00.000Z"), file: "..\\up.jpg" })).toBeUndefined();
    expect(sanitizeDeathCapture({ ...capture("a", "2026-09-11T21:00:00.000Z"), thumbFile: "C:\\x.jpg" })).toBeUndefined();
    expect(sanitizeDeathCapture({ ...capture("a", "not-a-date") })).toBeUndefined();
    expect(sanitizeDeathCapture({ ...capture("a", "2026-09-11T21:00:00.000Z"), kind: "video" })).toBeUndefined();
  });

  it("clamps impossible sizes", () => {
    const entry = sanitizeDeathCapture({
      ...capture("a", "2026-09-11T21:00:00.000Z"),
      width: Number.NaN,
      bytes: -5,
      areaLevel: 0,
    });
    expect(entry?.width).toBe(0);
    expect(entry?.bytes).toBe(0);
    expect(entry?.areaLevel).toBeUndefined();
  });

  it("round-trips one record", () => {
    const entry = capture("cap-round", "2026-09-11T21:00:00.000Z");
    expect(sanitizeDeathCapture(JSON.parse(serializeDeathCapture(entry)))).toEqual(entry);
  });
});

describe("prune plan", () => {
  it("removes the oldest beyond the cap", () => {
    const records = [
      capture("c", "2026-09-11T21:30:00.000Z"),
      capture("a", "2026-09-11T21:00:00.000Z"),
      capture("b", "2026-09-11T21:15:00.000Z"),
    ];
    const plan = pruneDeathPlan(records, 2);
    expect(plan.remove.map((entry) => entry.id)).toEqual(["a"]);
    expect(plan.keep.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  it("keeps everything under the cap and never drops the last one", () => {
    const records = [capture("a", "2026-09-11T21:00:00.000Z")];
    expect(pruneDeathPlan(records, 60).remove).toEqual([]);
    expect(pruneDeathPlan(records, 0).keep).toHaveLength(1);
  });
});
