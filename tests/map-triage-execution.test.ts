import { describe, expect, it } from "vitest";
import {
  runFastCompactionPass,
  runFastDropPass,
  runFastIdentifyPass,
  sameIdentifyIdentity,
  type FastTriageOps,
  type TriagePoint,
} from "../src/core/mapTriageExecution.js";
import {
  classifyBagRead,
  type CompactionMove,
  type ConfirmedBagItem,
  type SpriteRead,
} from "../src/core/mapTriage.js";

const scrollText = (stack: number) =>
  `Item Class: Stackable Currency\nRarity: Currency\nScroll of Wisdom\n--------\nStack Size: ${stack}/40`;
const gearText = (identified: boolean, name = "Dread Coat", base = "Advanced Maraketh Coat") =>
  `Item Class: Body Armours\nRarity: Rare\n${identified ? `${name}\n` : ""}${base}\n--------\n` +
  `Item Level: 82\n--------\n${identified ? "+30% to Fire Resistance" : "Unidentified"}`;
const cellPoint = (row: number, col: number): TriagePoint => ({ x: col + 0.5, y: row + 0.5 });
const placePoint = (row: number, col: number, w: number, h: number): TriagePoint => ({
  x: col + w / 2 - (w % 2 === 0 ? 0.25 : 0),
  y: row + h / 2 - (h % 2 === 0 ? 0.25 : 0),
});
const returnPoint = ({ sprite }: SpriteRead) => placePoint(sprite.row, sprite.col, sprite.w, sprite.h);
const groundPoint = { x: -10, y: -10 };

interface FakeItem { id: string; row: number; col: number; w: number; h: number; text: string }
const coat = (id: string, col: number, identified = true, row = 0): FakeItem =>
  ({ id, row, col, w: 2, h: 3, text: gearText(identified, `${id} Coat`) });
const scrollItem = (stack = 40): FakeItem =>
  ({ id: "scroll", row: 0, col: 0, w: 1, h: 1, text: scrollText(stack) });
const spriteRead = (item: FakeItem): SpriteRead => ({
  text: item.text,
  sprite: { ...item, ...cellPoint(item.row, item.col), cx: item.col + item.w / 2, cy: item.row + item.h / 2 },
});
const confirmed = (items: FakeItem[]): ConfirmedBagItem[] => items.map((item) => ({
  item: { id: item.id, row: item.row, col: item.col, w: item.w, h: item.h },
  pick: cellPoint(item.row, item.col),
  fingerprint: classifyBagRead(item.text).parsed!.fingerprint,
}));

/** Physical footprints and a held item, including swaps and refused placements. */
function game(initial: FakeItem[], options: {
  ignoreChainIds?: string[];
  failArmNumber?: number;
  refuseDropNumber?: number;
  refusePlacementNumber?: number;
  skipPickupId?: string;
} = {}) {
  const bag = new Map(initial.map((item) => [item.id, { ...item }]));
  const clicks: Array<{ kind: string; point: TriagePoint }> = [];
  const bursts: Array<{ points: TriagePoint[]; gapMs: number; hoverMs?: number; shift?: boolean; label: string }> = [];
  const sleeps: number[] = [];
  const copies: string[] = [];
  const drops: string[] = [];
  let cursor: FakeItem | undefined;
  let armed = false;
  let armCount = 0;
  let shift = false;
  let groundAttempts = 0;
  let placementAttempts = 0;
  let stopped = false;
  let copyHook: ((label: string, texts: string[]) => string[]) | undefined;
  let afterBurst: (() => void) | undefined;
  const at = (point: TriagePoint) => [...bag.values()].find((item) =>
    point.x >= item.col && point.x < item.col + item.w && point.y >= item.row && point.y < item.row + item.h);
  const left = async (point: TriagePoint) => {
    if (stopped) throw new Error("host-emergency-stop");
    clicks.push({ kind: "left", point });
    if (point.x < 0) {
      groundAttempts += 1;
      if (cursor && options.refuseDropNumber !== groundAttempts) {
        drops.push(cursor.id);
        cursor = undefined;
      }
      return;
    }
    const hit = at(point);
    if (armed) {
      if (hit && classifyBagRead(hit.text).kind === "unid-gear" &&
          !(shift && options.ignoreChainIds?.includes(hit.id))) {
        hit.text = gearText(true, `${hit.id} Coat`);
        const scroll = bag.get("scroll")!;
        const stack = classifyBagRead(scroll.text).stack! - 1;
        if (stack > 0) scroll.text = scrollText(stack);
        else { bag.delete("scroll"); armed = false; }
      }
      if (!shift) armed = false;
      return;
    }
    if (!cursor) {
      if (hit && hit.id !== options.skipPickupId) {
        cursor = hit;
        bag.delete(hit.id);
      }
      return;
    }
    placementAttempts += 1;
    if (placementAttempts === options.refusePlacementNumber) return;
    // Cell-boundary placement is ambiguous for even dimensions, hence quarter-cell bias.
    if ((cursor.w % 2 === 0 && Number.isInteger(point.x)) ||
        (cursor.h % 2 === 0 && Number.isInteger(point.y))) return;
    const col = Math.floor(point.x - (cursor.w - 1) / 2);
    const row = Math.floor(point.y - (cursor.h - 1) / 2);
    if (col < 0 || row < 0 || col + cursor.w > 12 || row + cursor.h > 5) return;
    const overlaps = [...bag.values()].filter((item) =>
      col < item.col + item.w && col + cursor!.w > item.col && row < item.row + item.h && row + cursor!.h > item.row);
    if (overlaps.length > 1) return;
    const held = cursor;
    cursor = overlaps[0];
    if (cursor) bag.delete(cursor.id);
    bag.set(held.id, { ...held, row, col });
  };
  const ops: FastTriageOps = {
    copyPoints: async (points, label) => {
      copies.push(label);
      const texts = points.map((point) => at(point)?.text ?? "");
      return copyHook?.(label, texts) ?? texts;
    },
    rightClick: async (point) => {
      if (stopped) throw new Error("host-emergency-stop");
      clicks.push({ kind: "right", point });
      armCount += 1;
      armed = armCount !== options.failArmNumber && (classifyBagRead(at(point)?.text ?? "").stack ?? 0) > 0;
    },
    leftClick: left,
    clickBurst: async (points, settings) => {
      bursts.push({ points, ...settings });
      shift = settings.shift ?? false;
      try { for (const point of points) await left(point); }
      finally { shift = false; armed = false; }
      afterBurst?.();
    },
    identifyBurst: async (points, settings) => {
      bursts.push({ points, ...settings, shift: true });
      const texts: string[] = [];
      let verificationFailed = false;
      shift = true;
      try {
        for (const point of points) {
          await left(point);
          sleeps.push(200);
          copies.push("identify-inline");
          const actual = at(point)?.text ?? "";
          const text = copyHook?.("identify-inline", [actual])[0] ?? actual;
          texts.push(text);
          const item = classifyBagRead(text);
          if (item.kind !== "identified-gear" || item.parsed?.itemClass !== point.itemClass) {
            verificationFailed = true;
            break;
          }
        }
      } finally { shift = false; armed = false; }
      afterBurst?.();
      return { count: texts.length, texts, verificationFailed };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    checkpoint: async () => {},
    shouldStop: () => stopped,
  };
  return {
    ops, bag, clicks, bursts, sleeps, copies, drops,
    get cursor() { return cursor; },
    stop: () => { stopped = true; },
    setCopyHook: (hook: typeof copyHook) => { copyHook = hook; },
    setAfterBurst: (hook: typeof afterBurst) => { afterBurst = hook; },
  };
}

describe("FAST identify execution", () => {
  it("identifies multi-cell items in one shift-held chain with one arm and proven floors", async () => {
    const items = [scrollItem(2), coat("a", 2, false), coat("b", 5, false)];
    const fake = game(items);
    const reads = items.map(spriteRead);
    const result = await runFastIdentifyPass({ reads, scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result).toEqual({ identifiedIds: ["a", "b"], skippedIds: [] });
    expect(fake.clicks).toHaveLength(3);
    expect(fake.bursts).toHaveLength(1);
    expect(fake.bursts[0]).toMatchObject({ shift: true, gapMs: 80 });
    expect(fake.sleeps[0]).toBe(320);
    expect(reads.slice(1).every((read) => classifyBagRead(read.text).kind === "identified-gear")).toBe(true);
    expect(fake.cursor).toBeUndefined();
  });

  it.each(["", scrollText(0), gearText(true)])("refuses missing/empty/wrong scroll before a click: %s", async (text) => {
    const item = coat("a", 2, false);
    const fake = game([{ ...scrollItem(), text }, item]);
    const result = await runFastIdentifyPass({ reads: [spriteRead(item)], scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toMatch(/^scroll-(missing|empty)$/);
    expect(fake.clicks).toHaveLength(0);
  });

  it("budgets by physical items and never arms at the pinned scroll cell as an item", async () => {
    const items = [scrollItem(1), coat("a", 2, false), coat("b", 5, false)];
    const fake = game(items);
    const result = await runFastIdentifyPass({ reads: items.map(spriteRead), scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.identifiedIds).toEqual(["a"]);
    expect(result.skippedIds).toEqual(["b"]);
    expect(fake.bursts[0].points).toHaveLength(1);
  });

  it("pins the pre-identify fingerprint before arming", async () => {
    const item = coat("a", 2, false);
    const fake = game([scrollItem(), { ...item, text: gearText(false, "", "Wrong Coat") }]);
    const result = await runFastIdentifyPass({ reads: [spriteRead(item)], scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-cell-changed");
    expect(fake.clicks).toHaveLength(0);
  });

  it("returns a lifted 2x3 to its exact origin and aborts without a retry", async () => {
    const item = coat("a", 2, false);
    const fake = game([scrollItem(), item], { failArmNumber: 1 });
    const result = await runFastIdentifyPass({ reads: [spriteRead(item)], scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-misfire");
    expect(fake.bag.get("a")).toEqual(item);
    expect(fake.cursor).toBeUndefined();
    expect(fake.clicks).toHaveLength(3);
    expect(fake.clicks.at(-1)?.point).toEqual(placePoint(0, 2, 2, 3));
  });

  it("a failed arm restores the first item before a second-item click can cause a cursor swap", async () => {
    const items = [scrollItem(), coat("a", 2, false, 0), coat("b", 5, false, 2)];
    const fake = game(items, { failArmNumber: 1 });
    const result = await runFastIdentifyPass({ reads: items.map(spriteRead), scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-misfire");
    expect(result.skippedIds).toEqual(["b"]);
    expect(fake.bag.get("a")).toEqual(items[1]);
    expect(fake.bag.get("b")).toEqual(items[2]);
    expect(fake.cursor).toBeUndefined();
    expect(fake.clicks).toHaveLength(3); // arm, first identify click, exact-origin return
    expect(fake.clicks.every((click) => click.point.x < 5)).toBe(true);
    expect(fake.bursts).toHaveLength(1);
  });

  it("uses verified normal-copy fallback if the client cannot copy with Shift held", async () => {
    const items = [scrollItem(), coat("a", 2, false), coat("b", 5, false), coat("c", 8, false)];
    const fake = game(items);
    fake.setCopyHook((label, texts) => label === "identify-inline" ? [""] : texts);
    const result = await runFastIdentifyPass({ reads: items.map(spriteRead), scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result).toEqual({ identifiedIds: ["a", "b", "c"], skippedIds: [], fallbackReason: "inline-copy-unavailable" });
    expect(fake.bursts).toHaveLength(1);
    expect(fake.bursts[0].shift).toBe(true);
    expect(fake.clicks.filter((click) => click.kind === "right")).toHaveLength(3);
    expect(fake.sleeps.filter((ms) => ms === 320)).toHaveLength(3);
    expect(fake.copies).toContain("identify-inline-failure");
    expect(fake.copies.filter((label) => label === "identify-retry-verify")).toHaveLength(2);
    expect(fake.cursor).toBeUndefined();
  });

  it("stops normal-copy fallback immediately after a misfire, leaving the next item untouched", async () => {
    const items = [scrollItem(), coat("a", 2, false), coat("b", 5, false), coat("c", 8, false)];
    const fake = game(items, { failArmNumber: 2 });
    fake.setCopyHook((label, texts) => label === "identify-inline" ? [""] : texts);
    const result = await runFastIdentifyPass({ reads: items.map(spriteRead), scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-misfire");
    expect(result.identifiedIds).toEqual(["a"]);
    expect(fake.bag.get("b")).toEqual(items[2]);
    expect(fake.bag.get("c")).toEqual(items[3]);
    expect(fake.cursor).toBeUndefined();
    expect(fake.clicks.filter((click) => click.kind === "right")).toHaveLength(2);
    expect(fake.bursts).toHaveLength(1);
  });

  it("stops at the first still-unidentified inline copy without clicking the next item", async () => {
    const items = [scrollItem(), coat("a", 2, false), coat("b", 5, false)];
    const fake = game(items, { ignoreChainIds: ["a", "b"], failArmNumber: 2 });
    const result = await runFastIdentifyPass({ reads: items.map(spriteRead), scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-not-working");
    expect(fake.clicks.filter((click) => click.kind === "right")).toHaveLength(1);
    expect(fake.bag.get("a")).toEqual(items[1]);
    expect(fake.bag.get("b")).toEqual(items[2]);
    expect(fake.cursor).toBeUndefined();
  });

  it.each(["unreadable clipboard", gearText(true, "Wrong Name", "Wrong Coat")])("aborts an unexplained post-identify result", async (text) => {
    const item = coat("a", 2, false);
    const fake = game([scrollItem(), item]);
    fake.setCopyHook((label, texts) => label === "identify-inline" || label === "identify-inline-failure" ? [text] : texts);
    const result = await runFastIdentifyPass({ reads: [spriteRead(item)], scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("identify-item-changed");
    expect(result.identifiedIds).toEqual([]);
    expect(fake.bursts).toHaveLength(1);
  });

  it("accepts revealed rare names and magic affixes, but rejects changed item levels", () => {
    const unid = classifyBagRead(gearText(false)).parsed!;
    const identified = classifyBagRead(gearText(true)).parsed!;
    expect(sameIdentifyIdentity(unid, identified)).toBe(true);
    expect(sameIdentifyIdentity(unid, { ...identified, itemLevel: 83 })).toBe(false);
    expect(sameIdentifyIdentity({ ...unid, rarity: "Magic" }, {
      ...identified, rarity: "Magic", baseType: "Stout Advanced Maraketh Coat of the Fox",
    })).toBe(true);
  });

  it("does not emit any mutation after an emergency stop", async () => {
    const item = coat("a", 2, false);
    const fake = game([scrollItem(), item]);
    fake.stop();
    const result = await runFastIdentifyPass({ reads: [spriteRead(item)], scrollPoint: cellPoint(0, 0), ops: fake.ops, returnPoint });
    expect(result.aborted).toBe("stop-requested");
    expect(fake.clicks).toHaveLength(0);
  });
});

describe("FAST drop execution", () => {
  it("uses exactly pickup, ground, truth probe for each item with a 200ms floor", async () => {
    const items = [coat("a", 2), coat("b", 5)];
    const fake = game([scrollItem(), ...items]);
    const result = await runFastDropPass({ candidates: items.map(spriteRead), groundPoint, ops: fake.ops, dropGapMs: 35, returnPoint });
    expect(result).toEqual({ droppedIds: ["a", "b"], skipped: [] });
    expect(fake.clicks).toHaveLength(6);
    expect(fake.bursts.every((burst) => burst.gapMs === 200)).toBe(true);
    expect(fake.bursts.every((burst) => burst.hoverMs === 100)).toBe(true);
    expect(fake.copies).toEqual(["drop-pin", "drop-origin", "drop-probe", "drop-pin", "drop-origin", "drop-probe"]);
    expect(fake.cursor).toBeUndefined();
    expect(fake.bag.get("scroll")?.text).toBe(scrollText(40));
  });

  it.each([1, 2])("aborts on refused drop %s before the next pickup", async (refuseDropNumber) => {
    const items = [coat("a", 2), coat("b", 5), coat("c", 8)];
    const fake = game([scrollItem(), ...items], { refuseDropNumber });
    const result = await runFastDropPass({ candidates: items.map(spriteRead), groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.aborted).toBe("drop-refused");
    expect(result.droppedIds).toEqual(items.slice(0, refuseDropNumber - 1).map((item) => item.id));
    expect(fake.bag.get(items[refuseDropNumber - 1].id)).toEqual(items[refuseDropNumber - 1]);
    expect(fake.bag.get("c")).toEqual(items[2]);
    expect(fake.cursor).toBeUndefined();
    expect(fake.clicks).toHaveLength(refuseDropNumber * 3);
  });

  it("does not pick up the origin as a probe if the original pickup missed", async () => {
    const item = coat("a", 2);
    const fake = game([scrollItem(), item], { skipPickupId: "a" });
    const result = await runFastDropPass({ candidates: [spriteRead(item)], groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.aborted).toBe("drop-pickup-missed");
    expect(fake.clicks).toHaveLength(2);
    expect(fake.bag.get("a")).toEqual(item);
  });

  it("aborts immediately on an already-gone source without touching the next item", async () => {
    const first = coat("gone", 2);
    const changed = coat("changed", 5);
    const fake = game([scrollItem(), { ...changed, text: gearText(true, "Unexpected Coat") }]);
    const result = await runFastDropPass({ candidates: [first, changed].map(spriteRead), groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.aborted).toBe("drop-source-missing");
    expect(result.skipped).toEqual([{ id: "gone", reason: "already-gone" }]);
    expect(fake.copies).toEqual(["drop-pin"]);
    expect(fake.clicks).toHaveLength(0);
  });

  it("pins exact fingerprints before touching a changed source", async () => {
    const changed = coat("changed", 5);
    const fake = game([scrollItem(), { ...changed, text: gearText(true, "Unexpected Coat") }]);
    const result = await runFastDropPass({ candidates: [spriteRead(changed)], groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.aborted).toBe("drop-cell-changed");
    expect(result.skipped).toEqual([{ id: "changed", reason: "cell-changed" }]);
    expect(fake.clicks).toHaveLength(0);
  });

  it("never drops unidentified gear, scrolls, non-gear, unreadable text or cell 0,0", async () => {
    const items = [scrollItem(), coat("unid", 2, false),
      { ...coat("garbage", 5), text: "garbage" },
      { ...coat("map", 8), text: "Item Class: Waystones\nRarity: Rare\nWaystone (Tier 12)\n--------\nItem Level: 82" },
      { ...coat("pinned", 0), row: 0 }];
    const fake = game(items.slice(0, 4));
    const result = await runFastDropPass({ candidates: items.map(spriteRead), groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.skipped).toHaveLength(items.length);
    expect(result.droppedIds).toEqual([]);
    expect(fake.clicks).toHaveLength(0);
  });

  it("honors a stop after a safe drop unit without picking another item up", async () => {
    const items = [coat("a", 2), coat("b", 5)];
    const fake = game([scrollItem(), ...items]);
    fake.setCopyHook((label, texts) => { if (label === "drop-probe") fake.stop(); return texts; });
    const result = await runFastDropPass({ candidates: items.map(spriteRead), groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint });
    expect(result.aborted).toBe("stop-requested");
    expect(result.droppedIds).toEqual(["a"]);
    expect(fake.clicks).toHaveLength(3);
    expect(fake.bag.get("b")).toEqual(items[1]);
  });

  it("treats partial copy responses as failures, never as empty bag cells", async () => {
    const item = coat("a", 2);
    const fake = game([scrollItem(), item]);
    fake.setCopyHook(() => []);
    await expect(runFastDropPass({ candidates: [spriteRead(item)], groundPoint, ops: fake.ops, dropGapMs: 200, returnPoint })).rejects.toThrow("clipboard-incomplete");
    expect(fake.clicks).toHaveLength(0);
  });
});

describe("FAST compaction execution", () => {
  const move = (id: string, fromCol: number, toCol: number): CompactionMove =>
    ({ id, from: { row: 0, col: fromCol }, to: { row: 0, col: toCol }, w: 2, h: 3 });
  const compact = (fake: ReturnType<typeof game>, items: FakeItem[], moves: CompactionMove[]) =>
    runFastCompactionPass({ confirmed: confirmed(items), moves, cols: 12, rows: 5,
      cellPoint, placePoint, ops: fake.ops, moveGapMs: 10 });

  it("moves correct 2x3 footprints in two clicks each, verifies origin and exact target, and pins scroll", async () => {
    const items = [scrollItem(), coat("a", 5), coat("b", 8)];
    const fake = game(items);
    const result = await compact(fake, items, [move("a", 5, 1), move("b", 8, 3)]);
    expect(result).toEqual({ movedIds: ["a", "b"] });
    expect(fake.clicks).toHaveLength(4);
    expect(fake.bag.get("a")).toMatchObject({ row: 0, col: 1, w: 2, h: 3 });
    expect(fake.bag.get("b")).toMatchObject({ row: 0, col: 3, w: 2, h: 3 });
    expect(fake.bag.get("scroll")).toEqual(items[0]);
    expect(fake.bursts.every((burst) => burst.gapMs === 35)).toBe(true);
    expect(fake.cursor).toBeUndefined();
  });

  it("performs zero reads or clicks for an already compact bag", async () => {
    const items = [scrollItem(), coat("a", 1)];
    const fake = game(items);
    expect(await compact(fake, items, [])).toEqual({ movedIds: [] });
    expect(fake.copies).toEqual([]);
    expect(fake.clicks).toEqual([]);
  });

  it("verifies a vacated cell when source and target footprints overlap", async () => {
    const items = [scrollItem(), coat("a", 2)];
    const fake = game(items);
    expect(await compact(fake, items, [move("a", 2, 1)])).toEqual({ movedIds: ["a"] });
    expect(fake.bag.get("a")?.col).toBe(1);
    expect(fake.cursor).toBeUndefined();
  });

  it("rejects moving the scroll or targeting its reserved cell before any click", async () => {
    const items = [scrollItem(), coat("a", 4)];
    for (const moves of [[move("a", 4, 0)], [{ id: "scroll", from: { row: 0, col: 0 }, to: { row: 4, col: 0 }, w: 1, h: 1 }]]) {
      const fake = game(items);
      expect((await compact(fake, items, moves)).aborted).toMatch(/^compact-/);
      expect(fake.clicks).toEqual([]);
    }
  });

  it("rejects out-of-bounds, overlapping, and unpinned models before a click", async () => {
    const variants = [
      [scrollItem(), coat("a", 11)],
      [scrollItem(), coat("a", 4), coat("b", 5)],
    ];
    for (const items of variants) {
      const fake = game(items);
      expect((await compact(fake, items, [move("a", items[1].col, 1)])).aborted).toMatch(/^compact-/);
      expect(fake.clicks).toEqual([]);
    }
  });

  it("returns a refused placement to the fully verified empty origin, then aborts before another move", async () => {
    const items = [scrollItem(), coat("a", 5), coat("b", 8)];
    const fake = game(items, { refusePlacementNumber: 1 });
    const result = await compact(fake, items, [move("a", 5, 1), move("b", 8, 3)]);
    expect(result.aborted).toBe("compact-placement-refused-recovered");
    expect(fake.clicks).toHaveLength(3);
    expect(fake.cursor).toBeUndefined();
    expect(fake.bag.get("a")).toEqual(items[1]);
    expect(fake.bag.get("b")).toEqual(items[2]);
  });

  it("rejects a wrong fingerprint at the destination even when the cell is nonempty", async () => {
    const items = [scrollItem(), coat("a", 5), coat("b", 8)];
    const fake = game(items);
    fake.setCopyHook((label, texts) => label === "compact-verify" ? texts.map((text, index) =>
      index === 0 ? gearText(true, "Other Item") : text) : texts);
    expect((await compact(fake, items, [move("a", 5, 1), move("b", 8, 3)])).aborted).toBe("compact-verify-failed");
    expect(fake.clicks).toHaveLength(2);
  });

  it("refuses a newly occupied destination cell before pickup, including the middle of a 2x3", async () => {
    const items = [scrollItem(), coat("a", 5)];
    const fake = game(items);
    fake.bag.set("intruder", { id: "intruder", row: 1, col: 1, w: 1, h: 1, text: scrollText(4) });
    expect((await compact(fake, items, [move("a", 5, 1)])).aborted).toBe("compact-target-occupied");
    expect(fake.clicks).toHaveLength(0);
    expect(fake.bag.get("a")).toEqual(items[1]);
  });

  it("rejects a one-cell-shifted placement whose top-left target still copies the correct item", async () => {
    const items = [scrollItem(), coat("a", 5)];
    const fake = game(items);
    // A shift left has the intended top-left inside the shifted footprint.
    fake.setAfterBurst(() => { fake.bag.get("a")!.col = 1; });
    expect((await compact(fake, items, [move("a", 5, 2)])).aborted).toBe("compact-verify-failed");
    expect(fake.clicks).toHaveLength(2);
  });

  it("does not recover into a changed source footprint", async () => {
    const items = [scrollItem(), coat("a", 5)];
    const fake = game(items, { refusePlacementNumber: 1 });
    fake.setAfterBurst(() => {
      fake.bag.set("intruder", { id: "intruder", row: 1, col: 5, w: 1, h: 1, text: scrollText(4) });
    });
    expect((await compact(fake, items, [move("a", 5, 1)])).aborted).toBe("compact-verify-failed");
    expect(fake.clicks).toHaveLength(2);
    expect(fake.cursor?.id).toBe("a");
  });

  it("rejects moving fixed items away from the scroll cell", async () => {
    const items = [scrollItem(), coat("a", 5)];
    const fake = game(items);
    const model = confirmed(items);
    model[1].item.fixed = true;
    const result = await runFastCompactionPass({ confirmed: model, moves: [move("a", 5, 1)], cols: 12, rows: 5,
      cellPoint, placePoint, ops: fake.ops, moveGapMs: 35 });
    expect(result.aborted).toBe("compact-invalid-plan");
    expect(fake.clicks).toHaveLength(0);
  });

  it("stops after one completed host move without sending later moves", async () => {
    const items = [scrollItem(), coat("a", 5), coat("b", 8)];
    const fake = game(items);
    fake.setAfterBurst(fake.stop);
    expect((await compact(fake, items, [move("a", 5, 1), move("b", 8, 3)])).aborted).toBe("stop-requested");
    expect(fake.clicks).toHaveLength(2);
    expect(fake.bag.get("b")).toEqual(items[2]);
  });
});
