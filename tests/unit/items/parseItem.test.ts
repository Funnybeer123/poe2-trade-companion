import { parseItem } from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemFixturePath } from "../../helpers/fixturePaths.js";

function snapshot(name: string) {
  return {
    rawText: readFileSync(itemFixturePath(name), "utf8"),
    source: "fixture" as const,
    capturedAtMs: 1,
  };
}

describe("parseItem corpus", () => {
  it("parses currency, unique, rare, waystone, and gem fixtures", () => {
    const divine = parseItem(snapshot("currency-divine.txt"));
    expect(divine.ok).toBe(true);
    if (divine.ok) {
      expect(divine.item.name).toBe("Divine Orb");
      expect(divine.item.rarity).toBe("currency");
      expect(divine.item.class?.toLowerCase()).toContain("currency");
      expect(divine.item.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }

    const unique = parseItem(snapshot("unique-amulet.txt"));
    expect(unique.ok).toBe(true);
    if (unique.ok) {
      expect(unique.item.name).toBe("Astramentis");
      expect(unique.item.base).toBe("Stellar Amulet");
      expect(unique.item.rarity).toBe("unique");
      expect(unique.item.itemLevel).toBe(75);
      expect(unique.item.modifiers.some((mod) => mod.text.includes("all Attributes"))).toBe(true);
    }

    const rare = parseItem(snapshot("rare-ring.txt"));
    expect(rare.ok).toBe(true);
    if (rare.ok) {
      expect(rare.item.name).toBe("Storm Grip");
      expect(rare.item.base).toBe("Iron Ring");
      expect(rare.item.rarity).toBe("rare");
      expect(rare.item.itemLevel).toBe(45);
    }

    const waystone = parseItem(snapshot("waystone.txt"));
    expect(waystone.ok).toBe(true);
    if (waystone.ok) {
      expect(waystone.item.name).toContain("Waystone");
      expect(waystone.item.pseudos.areaLevel).toBe(65);
    }

    const gem = parseItem(snapshot("gem-spark.txt"));
    expect(gem.ok).toBe(true);
    if (gem.ok) {
      expect(gem.item.name).toBe("Spark");
      expect(gem.item.rarity).toBe("gem");
      expect(gem.item.quality).toBe(0);
      expect(gem.item.pseudos.gemLevel).toBe(5);
    }
  });

  it("returns ManualReview for malformed text and never throws", () => {
    const malformed = parseItem(snapshot("malformed.txt"));
    expect(malformed).toEqual({ ok: false, error: expect.any(String), category: "ManualReview" });
    expect(parseItem({ rawText: "", source: "clipboard", capturedAtMs: 0 }).ok).toBe(false);
  });
});
