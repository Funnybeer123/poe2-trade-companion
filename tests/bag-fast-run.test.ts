import { describe, expect, it } from "vitest";
import { runFastBag, FastBagStop, type FastBagOptions } from "../src/core/bagFastRun.js";
import { validateBagSession } from "../src/core/bagSession.js";
import { parseItemText } from "../src/core/parseItem.js";
import { strongText, text } from "./support/batchFixtures.js";
import { unid, weakText, wisdom } from "./support/bagFixtures.js";
import { fastSimulator } from "./support/bagFastFixtures.js";

const options = (extra: Partial<FastBagOptions> = {}): FastBagOptions => ({ id: "bag-fast-test", origin: "replay", maxIdentifications: 59, maxDrops: 59, ...extra });
const gloves = (status?: string) => text([], { itemClass: "Gloves", base: "Knightly Mitts", name: "Fixture Mitts", status });
const mixed = () => [{ text: wisdom(5), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 },
  { text: strongText(), row: 0, col: 3 }, { text: weakText(), row: 0, col: 4 }, { text: gloves("Unidentified"), row: 1, col: 0 },
  { text: "Item Class: Stackable Currency\nRarity: Currency\nExalted Orb\n--------\nStack Size: 3 / 20", row: 4, col: 11 }];

describe("one-action fast bag workflow", () => {
  it("reads each physical item once, identifies in one chain with exact scroll accounting, and drops only positive low-priority items", async () => {
    const sim = fastSimulator(mixed()), result = await runFastBag(options(), sim.ports);
    const inputs = sim.inputs();
    // Seven physical items: a 2x2 item costs one read, and empty cells cost none.
    expect(inputs.slice(0, 7).map(i => i.op)).toEqual(Array(7).fill("read"));
    expect(inputs.filter(i => i.op === "arm")).toHaveLength(1);
    expect(inputs.filter(i => i.op === "chain")).toHaveLength(1);
    expect(inputs.find(i => i.op === "chain")!.cells).toEqual([{ row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 0 }]);
    expect(result.scrollsUsed).toBe(3);
    expect(result.session.identifiedIds).toHaveLength(3);
    expect(result.session.report.rows.find(r => r.row === 0 && r.col === 0)!.quantity).toBe(2);
    // The already-identified weak ring and the two now-identified weak rings drop. The strong ring,
    // the currency and the identified gloves the shared policy marks Review all stay.
    expect(result.session.droppedIds).toHaveLength(3);
    expect(sim.ground.map(item => item.text)).toEqual(Array(3).fill(weakText()));
    expect(sim.bag.map(item => parseItemText(item.text).name).sort()).toEqual(["Exalted Orb", "Fixture Mitts", "Fixture Ring", "Scroll of Wisdom"]);
    expect(result.session.original.rows).toHaveLength(7);
    validateBagSession(result.session);
    expect(result.session.receipts.map(r => r.action.kind)).toEqual(["arm", "identify", "identify", "identify", "pickup", "drop", "pickup", "drop", "pickup", "drop"]);
    expect(sim.sessions).toHaveLength(2);
  });

  it("records durable intent before every mutating input and re-reads the exact text before each pickup", async () => {
    const sim = fastSimulator(mixed()); await runFastBag(options(), sim.ports);
    const events = sim.events;
    events.forEach((event, index) => {
      if (event.kind !== "input" || event.op === "read") return;
      const before = events.slice(0, index).reverse().find(e => e.kind === "record");
      expect(before?.kind === "record" && before.entry.kind).toBe("intent");
      if (event.op === "pickup") expect(events[index - 1]).toMatchObject({ kind: "input", op: "read", cell: event.cell });
    });
  });

  it("issues no input when the action log cannot be written", async () => {
    const sim = fastSimulator(mixed(), { record: entry => { if (entry.kind === "intent") throw new Error("disk full"); } });
    await expect(runFastBag(options(), sim.ports)).rejects.toThrow("disk full");
    expect(sim.inputs().every(i => i.op === "read")).toBe(true);
    expect(sim.ground).toHaveLength(0);
  });

  it("never touches protected or retained items and honours both limits", async () => {
    const sim = fastSimulator(mixed()), result = await runFastBag(options({ maxIdentifications: 1, maxDrops: 1 }), sim.ports);
    expect(result.session.identifiedIds).toHaveLength(1);
    expect(result.session.droppedIds).toHaveLength(1);
    expect(result.leftUnidentified).toHaveLength(2);
    const touched = sim.inputs().filter(i => ["pickup", "chain"].includes(i.op)).flatMap(i => i.cells ?? [i.cell!]);
    expect(touched.some(c => c.row === 0 && c.col === 3 || c.row === 4 && c.col === 11)).toBe(false);
  });

  it("keeps unidentified equipment and still drops identified low-priority items when no Wisdom stack is at (0,0)", async () => {
    const sim = fastSimulator([{ text: unid(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }]);
    const result = await runFastBag(options(), sim.ports);
    expect(sim.inputs().some(i => i.op === "arm")).toBe(false);
    expect(result.notes.join(" ")).toContain("No Scroll of Wisdom");
    expect(result.session.droppedIds).toHaveLength(1);
    expect(sim.bag).toHaveLength(1);
  });

  it("accounts for the last scroll leaving (0,0) empty", async () => {
    const sim = fastSimulator([{ text: wisdom(1), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: unid(), row: 0, col: 2 }]);
    const result = await runFastBag(options(), sim.ports);
    expect(result.scrollsUsed).toBe(1);
    expect(result.leftUnidentified).toHaveLength(1);
    expect(result.session.report.rows[0]!.quantity).toBe(0);
    expect(result.session.droppedIds).toHaveLength(1);
    validateBagSession(result.session);
  });

  it("retries a silent fast read with the careful hover and stops on an unreadable occupied cell", async () => {
    const once = fastSimulator(mixed(), { read: (cell, count) => cell.col === 3 && count === 1 ? "" : undefined });
    expect((await runFastBag(options(), once.ports)).session.droppedIds).toHaveLength(3);
    const never = fastSimulator(mixed(), { read: cell => cell.col === 3 ? "" : undefined });
    await expect(runFastBag(options(), never.ports)).rejects.toThrow("could not be read completely");
    expect(never.inputs().every(i => i.op === "read")).toBe(true);
    expect(never.sessions[0]!.report.unreadCells).toHaveLength(1);
  });

  it("re-arms once only with evidence that nothing changed, then stops without spending a scroll", async () => {
    const retry = fastSimulator(mixed(), { armFails: 1 }), result = await runFastBag(options(), retry.ports);
    expect(retry.inputs().filter(i => i.op === "arm")).toHaveLength(2);
    expect(result.scrollsUsed).toBe(3);
    const dead = fastSimulator(mixed(), { armFails: 2 });
    await expect(runFastBag(options(), dead.ports)).rejects.toThrow("did not arm");
    expect(dead.inputs().some(i => i.op === "chain" || i.op === "pickup")).toBe(false);
  });

  it("keeps an item the chain skipped and balances scrolls against verified identifications only", async () => {
    const sim = fastSimulator(mixed(), { chainSkips: item => item.col === 2 }), result = await runFastBag(options(), sim.ports);
    expect(result.scrollsUsed).toBe(2);
    expect(result.leftUnidentified).toHaveLength(1);
    expect(sim.bag.some(item => !parseItemText(item.text).identified)).toBe(true);
    expect(result.session.droppedIds).toHaveLength(2);
  });

  it("stops before any drop when the scroll count does not match verified identifications", async () => {
    const sim = fastSimulator([{ text: wisdom(9), row: 0, col: 0 }, { text: unid(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }], { scrollsPerUse: 2 });
    await expect(runFastBag(options(), sim.ports)).rejects.toThrow("Scroll accounting failed");
    expect(sim.inputs().some(i => i.op === "pickup")).toBe(false);
  });

  it("stops when an identified target no longer matches its captured identity", async () => {
    const sim = fastSimulator(mixed(), { identifiedText: item => item.col === 1 ? text([], { base: "Sapphire Ring" }) : weakText() });
    await expect(runFastBag(options(), sim.ports)).rejects.toThrow("captured identity");
    expect(sim.ground).toHaveLength(0);
  });

  it("does not pick up an item whose text changed after assessment", async () => {
    const sim = fastSimulator([{ text: weakText(), row: 0, col: 1 }], { read: (cell, count) => count > 1 ? strongText() : undefined });
    await expect(runFastBag(options(), sim.ports)).rejects.toThrow("no longer matches the assessed text");
    expect(sim.inputs().some(i => i.op === "pickup")).toBe(false);
  });

  it("retries a missed pickup only after a positively clean cursor, and reports a refused drop as a held item", async () => {
    const missed = fastSimulator([{ text: weakText(), row: 0, col: 1 }], { pickupMisses: 1 });
    expect((await runFastBag(options(), missed.ports)).session.droppedIds).toHaveLength(1);
    expect(missed.inputs().filter(i => i.op === "pickup")).toHaveLength(2);
    const refused = fastSimulator([{ text: weakText(), row: 0, col: 1 }, { text: weakText(), row: 0, col: 2 }], { dropRefused: true });
    const error = await runFastBag(options(), refused.ports).catch(e => e);
    expect(error).toBeInstanceOf(FastBagStop);
    expect(error.held).toBe("item");
    expect(refused.inputs().filter(i => i.op === "pickup")).toHaveLength(1);
    expect(refused.sessions.at(-1)!.droppedIds).toHaveLength(0);
    validateBagSession(refused.sessions.at(-1)!);
  });

  it("stops when an unrelated item changes or a new object appears during drops", async () => {
    const changed = fastSimulator(mixed(), { beforeInput: (op, sim) => { if (op === "release") sim.bag.find(i => i.col === 3)!.id = 999; } });
    await expect(runFastBag(options(), changed.ports)).rejects.toThrow("looks changed");
    const appeared = fastSimulator(mixed(), { beforeInput: (op, sim) => { if (op === "release" && !sim.bag.some(i => i.row === 3)) sim.add({ text: strongText(), row: 3, col: 5 }); } });
    await expect(runFastBag(options(), appeared.ports)).rejects.toThrow("new object appeared");
  });

  it("refreshes life evidence before pickups and stops on death, a modal or a different map", async () => {
    for (const fault of [{ alive: false }, { mapInstance: "another-map" }, { foreground: false }]) {
      const sim = fastSimulator(mixed(), { safety: (scope, count) => count ? fault : {} });
      await expect(runFastBag(options({ safetyFreshMs: -1 }), sim.ports)).rejects.toThrow("unsafe");
      expect(sim.inputs().some(i => i.op === "arm" || i.op === "pickup")).toBe(false);
    }
    const modal = fastSimulator(mixed(), { safety: () => ({ obstructed: true }) });
    await expect(runFastBag(options(), modal.ports)).rejects.toThrow("unsafe");
    expect(modal.inputs()).toHaveLength(0);
  });

  it("refuses to start with a payload on the cursor", async () => {
    const sim = fastSimulator(mixed()); sim.held = "wisdom";
    await expect(runFastBag(options(), sim.ports)).rejects.toThrow("not provably empty");
    expect(sim.inputs()).toHaveLength(0);
  });

  it("keeps touching identical items separate", async () => {
    const sim = fastSimulator([{ text: weakText(), row: 2, col: 4 }, { text: weakText(), row: 2, col: 5 }, { text: gloves(), row: 3, col: 0 }, { text: gloves(), row: 3, col: 2 }]);
    const result = await runFastBag(options(), sim.ports);
    expect(result.session.report.rows).toHaveLength(4);
    expect(sim.inputs().filter(i => i.op === "read").length).toBeGreaterThanOrEqual(4);
  });
});
