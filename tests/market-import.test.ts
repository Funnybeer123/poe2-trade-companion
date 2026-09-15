import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importMarketText } from "../src/core/marketImport.js";
import { toTradeSearchBody } from "../src/core/tradeQuery.js";

const urls = readFileSync(path.join(process.cwd(), "fixtures", "market", "trade-urls.txt"), "utf8");
const lines = urls.split(/\r?\n/).filter(Boolean);

describe("importMarketText", () => {
  it("refuses an empty or oversized paste", () => {
    expect(importMarketText("").errors[0]).toContain("Paste a trade2 URL");
    expect(importMarketText("x".repeat(300_000)).errors[0]).toContain("too large");
  });

  it("turns a ?q= URL into an editable draft", () => {
    const result = importMarketText(lines[0]!);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0]!;
    expect(draft.label).toBe("Ruby Ring");
    expect(draft.league).toBe("Runes of Aldur");
    if (draft.draft.kind !== "search") throw new Error("expected a search draft");
    expect(draft.draft.query.type).toBe("Ruby Ring");
    expect(draft.draft.query.stats[0]!.filters[0]).toEqual({
      id: "explicit.stat_3299347043",
      value: { min: 100 },
    });
    expect(toTradeSearchBody(draft.draft.query)).toMatchObject({ sort: { price: "asc" } });
  });

  it("keeps an id-form search URL as an id-only entry", () => {
    const result = importMarketText(lines[1]!);
    expect(result.drafts).toEqual([]);
    expect(result.idOnly).toEqual([
      { kind: "search", league: "Runes of Aldur", searchId: "AbCdEfGh", source: lines[1] },
    ]);
  });

  it("keeps an exchange id the same way", () => {
    const result = importMarketText(lines[2]!);
    expect(result.idOnly[0]).toMatchObject({ kind: "exchange", searchId: "XyZ12345" });
  });

  it("refuses a foreign host by name", () => {
    const result = importMarketText(lines[3]!);
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain("not a pathofexile.com trade2 URL");
  });

  it("reads the whole fixture in one paste", () => {
    const result = importMarketText(urls);
    expect(result.drafts).toHaveLength(1);
    expect(result.idOnly).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it("keeps a line with an unencoded space in one piece", () => {
    const result = importMarketText(`  ${lines[0]!}  `);
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(1);
  });

  it("splits a line that really holds two links", () => {
    const result = importMarketText(`${lines[1]} ${lines[2]}`);
    expect(result.idOnly).toHaveLength(2);
  });

  it("reads a raw query document", () => {
    const document = JSON.stringify({
      query: { type: "Sapphire Ring", status: { option: "online" } },
      sort: { price: "asc" },
    });
    const result = importMarketText(document);
    expect(result.drafts).toHaveLength(1);
    if (result.drafts[0]!.draft.kind !== "search") throw new Error("expected a search draft");
    expect(result.drafts[0]!.draft.query.type).toBe("Sapphire Ring");
  });

  it("warns about filters it had to drop", () => {
    const document = JSON.stringify({
      query: { type: "Ruby Ring", filters: { armour_filters: { filters: { ar: { min: 1 } } } } },
    });
    const result = importMarketText(document);
    expect(result.warnings.join(" ")).toMatch(/dropped/);
  });

  it("says so when a document holds nothing importable", () => {
    expect(importMarketText("{}").errors.length).toBeGreaterThan(0);
  });

  it("caps how many links one paste may open", () => {
    const many = Array.from({ length: 60 }, () => lines[1]!).join("\n");
    const result = importMarketText(many);
    expect(result.idOnly).toHaveLength(50);
    expect(result.warnings.some((warning) => warning.includes("first 50"))).toBe(true);
  });
});
