import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARKET_STAT_TYPES,
  indexStatOptions,
  searchStats,
  statIdForText,
  statOptionById,
  statOptionsFromPayload,
} from "../src/core/marketStatSearch.js";

const payload = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "trade", "stats-subset.json"), "utf8"),
) as unknown;

const options = statOptionsFromPayload(payload);
const index = indexStatOptions(options);

describe("statOptionsFromPayload", () => {
  it("keeps every offered type and flags the local variants", () => {
    expect(options.length).toBeGreaterThan(80);
    const types = new Set(options.map((option) => option.type));
    expect(types.has("explicit")).toBe(true);
    expect(types.has("pseudo")).toBe(true);
    for (const type of types) expect(MARKET_STAT_TYPES).toContain(type);
    const local = options.find((option) => option.id === "explicit.stat_4052037485");
    expect(local?.local).toBe(true);
    expect(options.find((option) => option.id === "explicit.stat_3299347043")?.local).toBe(false);
  });

  it("never repeats an id", () => {
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
  });

  it("answers nothing for a junk payload", () => {
    expect(statOptionsFromPayload(undefined)).toEqual([]);
    expect(statOptionsFromPayload({ result: "nope" })).toEqual([]);
  });
});

describe("searchStats", () => {
  it("puts the exact modifier first for 'max life'", () => {
    const hits = searchStats(index, "max life");
    expect(hits[0]?.id).toBe("explicit.stat_3299347043");
  });

  it("ignores the numbers a player pastes", () => {
    const withNumbers = searchStats(index, "+35% to Lightning Resistance");
    expect(withNumbers[0]?.id).toBe("explicit.stat_1671376347");
  });

  it("finds 'fire res' by token prefixes", () => {
    const ids = searchStats(index, "fire res").map((option) => option.id);
    expect(ids).toContain("explicit.stat_3372524247");
  });

  it("honours the type filter and the limit", () => {
    const pseudo = searchStats(index, "resistance", { types: ["pseudo"] });
    expect(pseudo.length).toBeGreaterThan(0);
    expect(pseudo.every((option) => option.type === "pseudo")).toBe(true);
    expect(searchStats(index, "resistance", { limit: 3 })).toHaveLength(3);
  });

  it("lists explicit entries alphabetically for an empty query", () => {
    const empty = searchStats(index, "   ", { limit: 5 });
    expect(empty).toHaveLength(5);
    expect(empty.every((option) => option.type === "explicit")).toBe(true);
    expect([...empty].sort((a, b) => a.text.localeCompare(b.text)).map((o) => o.id)).toEqual(
      empty.map((o) => o.id),
    );
  });

  it("returns nothing for a query no modifier resembles", () => {
    expect(searchStats(index, "zzzzqqqq wobble")).toEqual([]);
  });
});

describe("statOptionById / statIdForText", () => {
  it("finds an option by id", () => {
    expect(statOptionById(index, "explicit.stat_3299347043")?.text).toContain("maximum Life");
    expect(statOptionById(index, "nope")).toBeUndefined();
  });

  it("maps a printed mod line to its stat id", () => {
    expect(statIdForText(index, "+110 to maximum Life")).toBe("explicit.stat_3299347043");
    expect(statIdForText(index, "+35% to Lightning Resistance")).toBe("explicit.stat_1671376347");
    expect(statIdForText(index, "a mod that does not exist")).toBeUndefined();
  });

  it("prefers the non-local variant", () => {
    const id = statIdForText(index, "+42 to maximum Energy Shield");
    expect(id).toBe("explicit.stat_3489782002");
  });
});
