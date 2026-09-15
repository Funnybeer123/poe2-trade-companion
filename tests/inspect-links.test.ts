import { describe, expect, it } from "vitest";
import {
  ALLOWED_LINK_HOSTS,
  isAllowedInspectLink,
  linkTargets,
  poe2dbUrl,
  wikiUrl,
} from "../src/core/inspectLinks.js";

describe("wikiUrl and poe2dbUrl", () => {
  it("turns a page name into an https URL on the two known hosts", () => {
    expect(wikiUrl("Sapphire Ring")).toBe("https://www.poe2wiki.net/wiki/Sapphire_Ring");
    expect(poe2dbUrl("Sapphire Ring")).toBe("https://poe2db.tw/us/Sapphire_Ring");
    expect(ALLOWED_LINK_HOSTS).toEqual(["www.poe2wiki.net", "poe2db.tw"]);
  });

  it("keeps apostrophes and encodes anything unsafe", () => {
    expect(wikiUrl("Rathbreaker's Coil")).toBe("https://www.poe2wiki.net/wiki/Rathbreaker's_Coil");
    expect(wikiUrl("Ring ? Test")).toContain("%3F");
  });
});

describe("linkTargets", () => {
  it("links a unique by name and by base type", () => {
    const links = linkTargets({
      rarity: "Unique",
      name: "Widowhail",
      baseType: "Crude Bow",
      itemClass: "Bows",
    });
    expect(links.map((link) => link.id)).toEqual(["wiki", "poe2db", "wiki-base", "poe2db-base"]);
    expect(links[0]!.url).toContain("Widowhail");
    expect(links[2]!.url).toContain("Crude_Bow");
  });

  it("links a rare by its base type", () => {
    const links = linkTargets({
      rarity: "Rare",
      name: "Storm Coil",
      baseType: "Sapphire Ring",
      itemClass: "Rings",
    });
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toContain("Sapphire_Ring");
  });

  it("derives a magic item's base type from its name when the parser has none", () => {
    const links = linkTargets({
      rarity: "Magic",
      name: "Sapphire Ring of the Bear",
      baseType: "Sapphire Ring of the Bear",
      itemClass: "Rings",
    });
    expect(links[0]!.url).toBe("https://www.poe2wiki.net/wiki/Sapphire_Ring");
  });

  it("produces nothing when there is no name at all", () => {
    expect(linkTargets({ rarity: "Normal", name: "", baseType: "", itemClass: "" })).toEqual([]);
  });
});

describe("isAllowedInspectLink", () => {
  it("accepts the URLs this module builds", () => {
    expect(isAllowedInspectLink(wikiUrl("Sapphire Ring"))).toBe(true);
    expect(isAllowedInspectLink(poe2dbUrl("Sapphire Ring"))).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isAllowedInspectLink("http://www.poe2wiki.net/wiki/Sapphire_Ring")).toBe(false);
    expect(isAllowedInspectLink("https://example.com/wiki/Sapphire_Ring")).toBe(false);
    expect(isAllowedInspectLink("https://user:pass@poe2db.tw/us/Ring")).toBe(false);
    expect(isAllowedInspectLink("https://poe2db.tw/us/Ring?next=evil")).toBe(false);
    expect(isAllowedInspectLink("https://poe2db.tw/us/Ring#frag")).toBe(false);
    expect(isAllowedInspectLink("https://poe2db.tw/us/../../etc/passwd")).toBe(false);
    expect(isAllowedInspectLink("https://poe2db.tw/us/Ring%00")).toBe(false);
    expect(isAllowedInspectLink("javascript:alert(1)")).toBe(false);
    expect(isAllowedInspectLink("")).toBe(false);
    expect(isAllowedInspectLink("not a url")).toBe(false);
  });
});
