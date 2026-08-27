import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseItemText } from "../src/core/parseItem.js";

const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "fixtures", "items", name), "utf8");

describe("item parser", () => {
  it("parses rare body armour", () => {
    const item = parseItemText(fixture("rare-body.txt"));
    expect(item.itemClass).toBe("Body Armours");
    expect(item.rarity).toBe("Rare");
    expect(item.name).toBe("Storm Veil");
    expect(item.baseType).toBe("Advanced Maraketh Coat");
    expect(item.itemLevel).toBe(82);
    expect(item.quality).toBe(20);
    expect(item.requirements.Level).toBe(62);
    expect(item.mods.length).toBeGreaterThanOrEqual(3);
    expect(item.fingerprint).toHaveLength(16);
  });

  it("parses currency and uniques", () => {
    const orb = parseItemText(fixture("exalted.txt"));
    expect(orb.itemClass).toBe("Currency");
    const bow = parseItemText(fixture("unique-bow.txt"));
    expect(bow.rarity).toBe("Unique");
    expect(bow.name).toBe("Widowhail");
  });

  it("reads name and base type from the header only, ignoring implicit blocks", () => {
    const item = parseItemText(fixture("poe2-amulet.txt"));
    expect(item.itemClass).toBe("Amulets");
    expect(item.name).toBe("Soul Thread");
    expect(item.baseType).toBe("Stellar Amulet");
    expect(item.itemLevel).toBe(67);
  });
});
