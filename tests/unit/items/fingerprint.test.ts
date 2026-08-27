import { fingerprintItem, parseItem, withFingerprint } from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemFixturePath } from "../../helpers/fixturePaths.js";

describe("fingerprint stability", () => {
  it("is stable across parse order and whitespace-equivalent clipboard text", () => {
    const first = parseItem({
      rawText: readFileSync(itemFixturePath("rare-ring.txt"), "utf8"),
      source: "fixture",
      capturedAtMs: 1,
    });
    const second = parseItem({
      rawText: readFileSync(itemFixturePath("rare-ring.txt"), "utf8").replaceAll("\n", "\r\n"),
      source: "clipboard",
      capturedAtMs: 99,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.item.fingerprint).toBe(second.item.fingerprint);
      expect(fingerprintItem(first.item)).toBe(first.item.fingerprint);
    }
  });

  it("changes when a modifier value changes", () => {
    const base = {
      class: "Ring",
      rarity: "rare",
      name: "Storm Grip",
      base: "Iron Ring",
      modifiers: [{ text: "+20 to Maximum Life", value: 20 }],
      pseudos: {},
    };
    const a = withFingerprint(base);
    const b = withFingerprint({
      ...base,
      modifiers: [{ text: "+21 to Maximum Life", value: 21 }],
    });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
