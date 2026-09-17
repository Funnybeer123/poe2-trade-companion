import { describe, expect, it, vi } from "vitest";
import { rescanRingBag, readGambleCell, worldAngeLabels, gambleRingPosition, evaluateGambledRing, runRingGamble, type GambleCell, type RingGamblePort } from "../src/core/ringGamble.js";
import { weakText, unid } from "./support/bagFixtures.js";
import { affix, text, strongText } from "./support/batchFixtures.js";
import liveRings from "../fixtures/ring-gamble/live-rings.json";
it("re-reads a delayed clipboard using a fresh agreeing pair, and bounds failed reads", async () => {
  const raw = strongText(), reads = ["", raw, raw, raw];
  const copy = vi.fn(async () => reads.shift() ?? "");
  expect(await readGambleCell(27, false, copy)).toEqual({ slot: 27, state: "item", text: raw });
  expect(copy).toHaveBeenCalledTimes(4);
  const silent = vi.fn(async () => "");
  expect((await readGambleCell(27, false, silent)).state).toBe("unread");
  expect(silent).toHaveBeenCalledTimes(6);
  expect((await readGambleCell(27, true, silent)).state).toBe("empty");
});
function fixture(stock = [weakText(), strongText()]) {
  const cells: GambleCell[] = Array.from({ length: 60 }, (_, slot) => ({ slot, state: "empty", text: "" }));
  // An existing weak ring MUST survive, even with identical text to a purchase.
  cells[0] = { slot: 0, state: "item", text: weakText() };
  const events: Record<string, unknown>[] = [];
  const port: RingGamblePort = {
    open: vi.fn(async () => {}), snapshot: vi.fn(async () => structuredClone(cells)),
    buy: vi.fn(async () => { const next = stock.shift(), empty = cells.find(c => c.state === "empty"); if (next && empty) Object.assign(empty, { state: "item", text: next }); }),
    sell: vi.fn(async cell => { Object.assign(cells[cell.slot]!, { state: "empty", text: "" }); }),
    evaluate: raw => evaluateGambledRing(raw), record: event => events.push(event),
  };
  return { cells, port, events };
}
describe("gambled ring evaluation", () => {
  it("vendors Brood Circle: isolated T1 mana does not rescue four bad affixes", () => {
    const brood = text([
      "{ Implicit Modifier — Damage, Physical, Attack }\nAdds 1 to 4 Physical Damage to Attacks",
      affix("Prefix", 8, "+31(18-38) to Evasion Rating", "Dancer's"),
      affix("Prefix", 7, "+20(20-29) to maximum Life", "Healthy"),
      affix("Prefix", 1, "+171(165-179) to maximum Mana", "Zaffre"),
      affix("Suffix", 4, "Gain 8(6-9) Mana per enemy killed", "of Infusion"),
      affix("Suffix", 3, "10(8-12)% increased Mana Regeneration Rate\n5% increased Light Radius", "of Warmth"),
    ], { base: "Iron Ring" });
    expect(evaluateGambledRing(brood).action).toBe("vendor");
    expect(evaluateGambledRing(brood).reasons.join(" ")).toContain("Isolated T1/T2");
  });
  it("keeps clean premium bases and supported rares, but not a lone premium roll among junk", () => {
    const mana = affix("Prefix", 1, "+171 to maximum Mana"), badLife = affix("Prefix", 7, "+20 to maximum Life"),
      badRes = affix("Suffix", 7, "+10% to Cold Resistance"), cast = affix("Suffix", 3, "18% increased Cast Speed");
    expect(evaluateGambledRing(text([mana], { rarity: "Magic" })).action).toBe("craft");
    expect(evaluateGambledRing(text([mana, badLife])).action).toBe("craft");
    expect(evaluateGambledRing(text([mana, badLife, badRes])).action).toBe("vendor");
    expect(evaluateGambledRing(text([mana, badLife, cast])).action).toBe("craft");
  });
  it("keeps Glyph Loop for its actual T1 rarity affix, with confirmed open affixes", () => {
    const verdict = evaluateGambledRing(liveRings[0]!.text);
    expect(verdict.action).toBe("craft");
    expect(verdict.reasons.join(" ")).toContain("Observed T1: 17% increased Rarity");
    expect(verdict.reasons.join(" ")).toContain("2 prefix / 2 suffix");
  });
  it("uses observed tiers rather than generic roll thresholds or implicit strength", () => {
    expect(evaluateGambledRing(text([affix("Suffix", 2, "14% increased Rarity of Items found", "of Raiding")], { rarity: "Magic", base: "Emerald Ring" })).action).toBe("craft");
    expect(evaluateGambledRing(text([affix("Suffix", 3, "+32% to Lightning Resistance")])).action).toBe("vendor");
    expect(evaluateGambledRing(text([affix("Suffix", 1, "+33 to Strength")])).action).toBe("craft");
    expect(evaluateGambledRing(text(['{ Implicit Modifier }\n+40% to Cold Resistance', affix("Suffix", 5, "+20 to Strength")])).action).toBe("vendor");
  });
  it("keeps substantial compatible lower-tier combinations but rejects weak or mismatched ones", () => {
    const mana = affix("Prefix", 4, "+109 to maximum Mana"), cast = affix("Suffix", 3, "18% increased Cast Speed"),
      regen = affix("Suffix", 3, "47% increased Mana Regeneration Rate");
    expect(evaluateGambledRing(text([mana, cast, regen])).action).toBe("craft");
    expect(evaluateGambledRing(text([mana, cast])).action).toBe("vendor");
    expect(evaluateGambledRing(text([mana, cast.replace("Cast Speed", "Attack Speed"), regen])).action).toBe("vendor");
    expect(evaluateGambledRing(text([mana.replace("109", "16"), cast, regen])).action).toBe("vendor");
    expect(evaluateGambledRing(text([affix("Prefix", 3, "+80 to maximum Life"), affix("Suffix", 3, "+32% to Fire Resistance"), affix("Suffix", 3, "+32% to Cold Resistance")])).action).toBe("craft");
  });
  it("does not count hybrid lines as separate affixes or assert room from line count", () => {
    const hybrid = affix("Suffix", 3, "47% increased Mana Regeneration Rate\n15% increased Light Radius");
    const verdict = evaluateGambledRing(text([affix("Prefix", 1, "+150 to maximum Life"), hybrid]));
    expect(verdict.action).toBe("craft");
    expect(verdict.reasons.join(" ")).toContain("1 prefix / 1 suffix");
    expect(evaluateGambledRing(text([affix("Prefix", 4, "+100 to maximum Mana\n18% increased Cast Speed\n47% increased Mana Regeneration Rate")])).action).toBe("review");
  });
  it.each(["15% increased Light Radius", "13.1 Life Regeneration per second", "Leech 6.89% of Physical Attack Damage as Mana", "+300 to Accuracy Rating", "18% increased Mana Regeneration Rate"])("rejects a standalone T1 utility roll: %s", mod => {
    expect(evaluateGambledRing(text([affix("Suffix", 1, mod)])).action).toBe("vendor");
  });
  it("retains useful mana sustain but rejects the weak light-radius hybrid", () => {
    expect(evaluateGambledRing(text([affix("Suffix", 2, "60% increased Mana Regeneration Rate")])).action).toBe("craft");
    expect(evaluateGambledRing(text([affix("Suffix", 1, "18% increased Mana Regeneration Rate\n15% increased Light Radius")])).action).toBe("vendor");
    expect(evaluateGambledRing(text([affix("Prefix", 3, "+80 to maximum Life"), affix("Suffix", 1, "13.1 Life Regeneration per second"), affix("Suffix", 3, "+32% to Fire Resistance")])).action).toBe("craft");
  });
  it("requires distinct substantial affixes and compatible subjects for synergy", () => {
    const life = affix("Prefix", 3, "+80 to maximum Life");
    const res = affix("Suffix", 3, "+32% to Cold Resistance");
    expect(evaluateGambledRing(text([life, res, res])).action).toBe("vendor");
    expect(evaluateGambledRing(text([life, res, affix("Suffix", 5, "+25% to Fire Resistance")])).action).toBe("vendor");
    expect(evaluateGambledRing(text([affix("Prefix", 3, "Adds 10 to 18 Fire damage to Attacks"), affix("Suffix", 3, "8% increased Attack Speed"), life])).action).toBe("craft");
    expect(evaluateGambledRing(text([affix("Prefix", 3, "Adds 10 to 18 Fire damage to Attacks"), affix("Suffix", 3, "18% increased Cast Speed"), life])).action).toBe("vendor");
    expect(evaluateGambledRing(text([affix("Prefix", 3, "+120 to maximum Mana of Minions"), affix("Suffix", 3, "18% increased Cast Speed"), life])).action).not.toBe("craft");
  });
  it("replays the actual advanced-copy ring texts from the live buy/sell test", () => {
    for (const ring of liveRings) {
      const verdict = evaluateGambledRing(ring.text);
      expect(verdict.action).toBe(["craft", "vendor", "vendor", "vendor", "craft", "vendor"][liveRings.indexOf(ring)]);
      if (verdict.action === "craft") expect(verdict.reasons.join(" ")).toContain("Observed T");
    }
  });
  it("vendors only recognized weak explicit rolls", () => {
    expect(evaluateGambledRing(weakText()).action).toBe("vendor");
    expect(evaluateGambledRing(strongText()).action).toBe("craft");
  });
  it.each(["", unid(), text(["Uncatalogued special modifier"]), text([]), text(["+8 to maximum Life"], { itemClass: "Amulets" })])("retains uncertain items: %s", raw => {
    expect(evaluateGambledRing(raw).action).toBe("review");
  });
  it.each(["Unique", "Magic"])("does not sell a strong %s ring", rarity => {
    expect(evaluateGambledRing(strongText().replace("Rarity: Rare", `Rarity: ${rarity}`)).action).not.toBe("vendor");
  });
  it("retains special items for separate review", () => {
    expect(evaluateGambledRing(weakText() + "\n--------\nCorrupted").action).toBe("keep");
  });
});
describe("bounded ring gamble replay", () => {
  it("sells the complete reject list once and preserves existing rings", async () => {
    const f = fixture(Array.from({ length: 10 }, () => weakText()));
    f.port.buyMany = async count => { for (let i = 0; i < count; i++) await f.port.buy(); };
    f.port.sellMany = vi.fn(async cells => { for (const cell of cells) await f.port.sell(cell); });
    expect(await runRingGamble(f.port, 10)).toEqual({ purchased: 10, sold: 10, retained: 0 });
    expect(vi.mocked(f.port.sellMany).mock.calls.map(call => call[0].length)).toEqual([10]);
    expect(f.port.snapshot).toHaveBeenCalledTimes(4); // baseline, bought, pre-sale guard, final
    expect(f.cells[0]!.state).toBe("item");
  });
  it("does not start the sale burst if the inventory changed after classification", async () => {
    const f = fixture([weakText()]);
    f.port.sellMany = vi.fn(async () => {});
    f.port.evaluate = () => { f.cells[1]!.text = strongText(); return { action: "vendor", reasons: [] }; };
    await expect(runRingGamble(f.port, 1)).rejects.toThrow("changed before sale");
    expect(f.port.sellMany).not.toHaveBeenCalled();
  });
  it.each(["partial", "unrelated", "throw"])("stops without retry after an ambiguous sale burst: %s", async fault => {
    const f = fixture([weakText(), weakText()]);
    f.port.sellMany = vi.fn(async cells => {
      await f.port.sell(cells[0]!);
      if (fault === "throw") throw new Error("native-stopped");
      if (fault === "unrelated") { await f.port.sell(cells[1]!); f.cells[0]!.text = strongText(); }
    });
    await expect(runRingGamble(f.port, 2)).rejects.toThrow(fault === "throw" ? "native-stopped" : "Sale was not verified");
    expect(f.port.sellMany).toHaveBeenCalledOnce();
  });
  it("buys one bounded burst and verifies every added ring before selling", async () => {
    const f = fixture([weakText(), strongText()]);
    f.port.buyMany = vi.fn(async count => { for (let i = 0; i < count; i++) await f.port.buy(); });
    expect(await runRingGamble(f.port, 2)).toEqual({ purchased: 2, sold: 1, retained: 1 });
    expect(f.port.buyMany).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.cells[0]!.state).toBe("item");
  });
  it("never retries a partial burst and rejects changes to existing items", async () => {
    const f = fixture([weakText()]);
    f.port.buyMany = vi.fn(async () => { await f.port.buy(); });
    expect(await runRingGamble(f.port, 6)).toEqual({ purchased: 1, sold: 1, retained: 0 });
    expect(f.port.buyMany).toHaveBeenCalledOnce();
    const altered = fixture();
    altered.port.buyMany = async () => { altered.cells[0]!.text = strongText(); };
    await expect(runRingGamble(altered.port, 2)).rejects.toThrow("Unexpected purchase");
    expect(altered.port.sell).not.toHaveBeenCalled();
  });
  it("rescans existing rings without buying, protecting good rings and other items", async () => {
    const f = fixture();
    f.cells[1] = { slot: 1, state: "item", text: strongText() };
    f.cells[2] = { slot: 2, state: "item", text: weakText().replace("Item Class: Rings", "Item Class: Amulets") };
    expect(await rescanRingBag(f.port)).toEqual({ inspected: 2, sold: 1, retained: 1 });
    expect(f.port.buy).not.toHaveBeenCalled();
    expect(f.cells[0]!.state).toBe("empty");
    expect(f.cells[1]!.state).toBe("item");
    expect(f.cells[2]!.state).toBe("item");
  });
  it("fills available slots then sells only new weak rings, retaining pre-existing identical rings", async () => {
    const f = fixture();
    expect(await runRingGamble(f.port)).toEqual({ purchased: 2, sold: 1, retained: 1 });
    expect(f.cells[0]!.state).toBe("item"); expect(f.cells[1]!.state).toBe("empty"); expect(f.cells[2]!.state).toBe("item");
    expect(f.port.sell).toHaveBeenCalledOnce();
    expect(f.events.find(e => e.phase === "sell-pending")).toBeDefined();
  });
  it("does not buy again after selling and honors a purchase cap", async () => {
    const f = fixture([weakText(), weakText(), weakText()]);
    expect(await runRingGamble(f.port, 2)).toEqual({ purchased: 2, sold: 2, retained: 0 });
    expect(f.port.buy).toHaveBeenCalledTimes(2);
  });
  it("stops purchases at a full bag", async () => {
    const f = fixture(); for (const c of f.cells) Object.assign(c, { state: "item", text: weakText() });
    expect(await runRingGamble(f.port)).toEqual({ purchased: 0, sold: 0, retained: 0 }); expect(f.port.buy).not.toHaveBeenCalled();
  });
  it("stops on unavailable funds or stock without a retry", async () => {
    const f = fixture([]); await runRingGamble(f.port); expect(f.port.buy).toHaveBeenCalledOnce(); expect(f.port.sell).not.toHaveBeenCalled();
  });
  it("refuses unread inventory before buying", async () => {
    const f = fixture(); f.cells[5]!.state = "unread";
    await expect(runRingGamble(f.port)).rejects.toThrow("fully verified"); expect(f.port.buy).not.toHaveBeenCalled();
  });
  it("halts an unexpected purchase without selling anything", async () => {
    const f = fixture(); f.port.buy = async () => { f.cells[0]!.text = strongText(); };
    await expect(runRingGamble(f.port)).rejects.toThrow("Unexpected purchase"); expect(f.port.sell).not.toHaveBeenCalled();
  });
  it("revalidates the entire inventory before selling", async () => {
    const f = fixture([weakText()]); f.port.evaluate = () => { f.cells[1]!.text = strongText(); return { action: "vendor", reasons: [] }; };
    await expect(runRingGamble(f.port, 1)).rejects.toThrow("changed before sale"); expect(f.port.sell).not.toHaveBeenCalled();
  });
  it("does not retry failed sales", async () => {
    const f = fixture([weakText()]); f.port.sell = vi.fn(async () => {});
    await expect(runRingGamble(f.port, 1)).rejects.toThrow("Sale was not verified"); expect(f.port.sell).toHaveBeenCalledOnce();
  });
  it("propagates emergency stop before any further sale", async () => {
    const f = fixture(); f.port.buy = async () => { throw new Error("native-stopped"); };
    await expect(runRingGamble(f.port)).rejects.toThrow("native-stopped"); expect(f.port.sell).not.toHaveBeenCalled();
  });
  it.each([0, 61, NaN, 1.5])("rejects invalid cap %s before opening", async cap => {
    const f = fixture(); await expect(runRingGamble(f.port, cap)).rejects.toThrow("cap"); expect(f.port.open).not.toHaveBeenCalled();
  });
});

describe("fixed Jewellery ring slot", () => {
  it("targets row two even when legacy stock rows say five, and scales with calibration", () => {
    const grid = { x: 617, y: 535, w: 1285, h: 1182, cols: 12, rows: 5 };
    const point = gambleRingPosition(grid);
    expect(point.x).toBeCloseTo(670.542, 2);
    expect(point.y).toBeCloseTo(695.625, 3);
    expect(gambleRingPosition({ ...grid, rows: 11 })).toEqual(point);
    expect(gambleRingPosition({ ...grid, x: grid.x / 2, y: grid.y / 2, w: grid.w / 2, h: grid.h / 2 }))
      .toEqual({ x: point.x / 2, y: point.y / 2 });
  });
  it("rejects an out-of-grid or invalid target", () => {
    const grid = { x: 617, y: 535, w: 1285, h: 1182, cols: 12, rows: 5 };
    for (const change of [{ h: 100 }, { w: NaN }, { cols: 0 }, { x: -1 }])
      expect(() => gambleRingPosition({ ...grid, ...change })).toThrow("calibration");
  });
});

it("ignores duplicate Ange text on the minimap and respects the game window origin", () => {
  const world = { text: "ANGE", x: 1377, w: 87 }, map = { text: "Ange", x: 3494, w: 40 };
  expect(worldAngeLabels([world, map], 0, 3840)).toEqual([world]);
  expect(worldAngeLabels([world, map].map(l => ({ ...l, x: l.x + 200 })), 200, 3840)).toEqual([{ ...world, x: 1577 }]);
});
