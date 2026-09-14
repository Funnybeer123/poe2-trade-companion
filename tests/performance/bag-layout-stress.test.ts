import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { runBagStage } from "../../src/core/bagSession.js";
import { session, simulator, weakText, wisdom, type FixtureItem } from "../support/bagFixtures.js";
import { strongText, text } from "../support/batchFixtures.js";

it("preserves protected identities across seeded mixed layouts and repeated drop cycles", async () => {
  const started = performance.now(); let totalItems = 0, totalDrops = 0;
  for (let seed = 1; seed <= 32; seed++) {
    let state = seed;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
    const occupied = new Set(["0,0"]), items: FixtureItem[] = [{ text: wisdom(), row: 0, col: 0 }];
    for (let n = 1; n < 60; n++) {
      const row = Math.floor(n / 12), col = n % 12;
      if (occupied.has(row + "," + col) || random() < .12) continue;
      const kind = Math.floor(random() * 5);
      const w = kind === 4 ? 2 : 1, h = kind === 4 ? 2 : 1;
      if (row + h > 5 || col + w > 12) continue;
      const cells = Array.from({ length: w * h }, (_, i) => (row + Math.floor(i / w)) + "," + (col + i % w));
      if (cells.some(c => occupied.has(c))) continue;
      cells.forEach(c => occupied.add(c));
      items.push({ row, col, text: kind < 2 ? weakText() : kind === 2 ? strongText() :
        kind === 4 ? text([], { itemClass: "Boots", rarity: "Normal" }) : text(["Unknown effect"]) });
    }
    let s = session(items);
    expect(s.report.capture?.complete, "seed=" + seed).toBe(true);
    const protectedIds = s.report.rows.filter(r => r.assessment?.outcome !== "low-priority").map(r => r.id);
    totalItems += s.report.rows.length;
    for (let cycle = 0; cycle < 3; cycle++) {
      const sim = simulator(s);
      s = await runBagStage(s, "drop", sim.ports, 4);
      expect(s.droppedIds.every(id => !protectedIds.includes(id)), "seed=" + seed + " cycle=" + cycle).toBe(true);
      expect(s.droppedIds.length).toBe(s.receipts.filter(r => r.action.kind === "drop" && r.state === "verified").length);
    }
    totalDrops += s.droppedIds.length;
  }
  const summary = { seeds: "1..32", cyclesPerSeed: 3, physicalItems: totalItems, verifiedSyntheticDrops: totalDrops,
    milliseconds: Math.round(performance.now() - started), nativeInputs: 0 };
  mkdirSync("artifacts/map-triage", { recursive: true });
  writeFileSync("artifacts/map-triage/stress-summary.json", JSON.stringify(summary, null, 2));
}, 60_000);
