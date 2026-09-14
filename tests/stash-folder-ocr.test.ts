import { describe, expect, it, vi } from "vitest";
import { findExactWordSegment, selectedTabListRow, StashTabKit, type StripEntry } from "../src/adapters/stashTabKit.js";

const merged: StripEntry = { label: "G A Extra", row: "top", point: { x: 740, y: 212 }, width: 320,
  words: [
    { text: "G", x: 584, y: 200, w: 24, h: 24 },
    { text: "A", x: 668, y: 200, w: 24, h: 24 },
    { text: "Extra", x: 790, y: 200, w: 76, h: 24 },
  ] };

describe("folder navigation from exact OCR words", () => {
  it("locates a one-letter folder at its measured word centre inside a merged line", () => {
    expect(findExactWordSegment([merged], "G")).toMatchObject({ label: "G", row: "top", point: { x: 596, y: 212 }, width: 24 });
  });

  it("refuses duplicates and refuses to infer a short folder from line proportions", () => {
    expect(findExactWordSegment([merged, merged], "G")).toBeUndefined();
    expect(findExactWordSegment([{ ...merged, words: undefined }], "G")).toBeUndefined();
    expect(findExactWordSegment([merged], "Gear")).toBeUndefined();
  });

  it("retains native OCR word boxes through the stash strip parser", () => {
    const kit = new StashTabKit({ send: async () => ({ ok: true }) });
    const parsed = kit.stripEntries([{ text: merged.label, x: 580, y: 200, w: 320, h: 24, words: merged.words }], "top");
    expect(findExactWordSegment(parsed, "G")?.point).toEqual({ x: 596, y: 212 });
  });

  it("finds short headers anywhere across the strip using two agreeing OCR passes and no pointer input", async () => {
    const send = vi.fn(async (request: Record<string, unknown>) => {
      const x = 1034;
      const inside = x >= Number(request.left) + 2 && x + 20 <= Number(request.left) + Number(request.width) - 2;
      return { ok: true, lines: inside ? [{ text: "G", x, y: 206, w: 20, h: 28, words: [{ text: "G", x, y: 206, w: 20, h: 28 }] }] : [] };
    });
    const result = await new StashTabKit({ send }).readShortTopLabel("G");
    expect(result?.point).toEqual({ x: 1044, y: 220 });
    expect(send).toHaveBeenCalledTimes(34);
    expect(send.mock.calls.every(([request]) => request.op === "ocr" && request.neutralContext === true)).toBe(true);
    expect(new Set(send.mock.calls.map(([request]) => request.textThreshold))).toEqual(new Set([90, 120]));
  });

  it("rejects multiple visible short-label boxes, synthetic padding, and disagreement between passes", async () => {
    const box = (x: number) => ({ text: "G", x, y: 206, w: 20, h: 28 });
    const result = async (words: (request: Record<string, unknown>) => ReturnType<typeof box>[]) =>
      new StashTabKit({ send: async request => ({ ok: true, lines: [{ words: words(request) }] }) }).readShortTopLabel("G");
    expect(await result(() => [box(740), box(1000)])).toBeUndefined();
    expect(await result(request => [box(Number(request.left) - 80)])).toBeUndefined();
    expect(await result(request => [box(request.textThreshold === 90 ? 740 : 755)])).toBeUndefined();
  });
});

describe("selected dropdown pointer evidence", () => {
  const rows = [{ index: 0, label: "Amulets", readable: true, clickY: 561 }, { index: 1, label: "Rings", readable: true, clickY: 614 }];
  const client = { left: 1320, top: 480, width: 100, height: 200 };
  const image = (...centres: number[]) => {
    const data = new Uint8Array(client.width * client.height * 3);
    for (const cy of centres) for (let dy = -12; dy <= 12; dy += 1) {
      const dx = Math.round(16 * (1 - Math.abs(dy) / 12));
      for (const x of [1352 - dx, 1352 + dx]) {
        const offset = ((cy + dy - client.top) * client.width + x - client.left) * 3;
        data.set([40, 80, 150], offset);
      }
    }
    return { width: client.width, height: client.height, data };
  };
  it("aligns the sole selected pointer with the observed OCR row", () => {
    expect(selectedTabListRow(rows, image(561), client)).toEqual(rows[0]);
    expect(selectedTabListRow(rows, image(614), client)).toEqual(rows[1]);
  });
  it("refuses missing, duplicate, unreadable, or misaligned pointer evidence", () => {
    expect(selectedTabListRow(rows, image(), client)).toBeUndefined();
    expect(selectedTabListRow(rows, image(561, 614), client)).toBeUndefined();
    expect(selectedTabListRow([{ ...rows[0]!, readable: false }, rows[1]!], image(561), client)).toBeUndefined();
    expect(selectedTabListRow(rows, image(583), client)).toBeUndefined();
  });
});
