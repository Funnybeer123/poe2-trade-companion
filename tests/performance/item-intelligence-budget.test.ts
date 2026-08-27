import { describe, expect, it } from "vitest";
import { parseItemText } from "../../src/core/parseItem.js";
import {
  compileRules,
  matchCompiledRules,
  type ScanHistoryItem,
} from "../../src/core/scanRules.js";

const ITEM_BUDGET = 2_048;
const RULE_BUDGET = 64;

function generatedItem(index: number): string {
  return [
    "Item Class: Rings",
    "Rarity: Rare",
    `Generated Ring ${index}`,
    "Ruby Ring",
    "--------",
    `Item Level: ${60 + (index % 40)}`,
    "--------",
    `+${20 + (index % 80)} to maximum Life`,
    `+${10 + (index % 50)}% to Fire Resistance`,
    `Generated Marker ${index % RULE_BUDGET}`,
  ].join("\n");
}

const rules: ScanHistoryItem[] = Array.from(
  { length: RULE_BUDGET },
  (_, index) => ({
    id: `marker-${index}`,
    name: `Marker ${index}`,
    regex: `regex:^Generated Marker ${index}$\nmaximum Life`,
  }),
);

function runWorkload(texts: readonly string[]) {
  const compiled = compileRules(rules);
  return texts.map((text) => {
    const parsed = parseItemText(text);
    const matches = matchCompiledRules(compiled, text);
    return {
      fingerprint: parsed.fingerprint,
      matchIds: matches.map((rule) => rule.id),
      modCount: parsed.mods.length,
    };
  });
}

describe("item-intelligence deterministic work budget", () => {
  it(
    "parses and evaluates a fixed sizable fixture without output drift",
    { timeout: 15_000 },
    () => {
      const texts = Array.from({ length: ITEM_BUDGET }, (_, index) =>
        generatedItem(index),
      );

      const first = runWorkload(texts);
      const second = runWorkload(texts);

      expect(first).toEqual(second);
      expect(new Set(first.map((result) => result.fingerprint))).toHaveLength(
        ITEM_BUDGET,
      );
      expect(
        first.every(
          (result, index) =>
            result.matchIds.length === 1 &&
            result.matchIds[0] === `marker-${index % RULE_BUDGET}` &&
            result.modCount === 3,
        ),
      ).toBe(true);
    },
  );
});
