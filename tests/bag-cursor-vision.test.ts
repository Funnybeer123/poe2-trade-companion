import { describe, expect, it } from "vitest";
import type { BgrImage } from "../src/core/cellOccupancy.js";
import { proveBagCursorEmpty, proveBagCursorPayload, type BagCursorSource, type CursorVisionFrame } from "../src/core/bagCursorVision.js";
import { weakText, wisdom } from "./support/bagFixtures.js";

const AT = "2026-09-14T12:00:00.000Z", EMPTY_HASH = "a".repeat(64);
const freshImage = (): BgrImage => ({ width: 1200, height: 700, data: Buffer.alloc(1200 * 700 * 3, 20) });
const cloneImage = (image: BgrImage): BgrImage => ({ ...image, data: Buffer.from(image.data) });
function copyBox(source: BgrImage, destination: BgrImage, from: { x: number; y: number; w: number; h: number }, left: number, top: number) {
  for (let y = 0; y < from.h; y++) for (let x = 0; x < from.w; x++) {
    const a = ((from.y + y) * source.width + from.x + x) * 3, b = ((top + y) * destination.width + left + x) * 3;
    for (let channel = 0; channel < 3; channel++) destination.data[b + channel] = source.data[a + channel]!;
  }
}
function fixture(mode: "item" | "wisdom" = "item") {
  const sourceImage = freshImage(), box = { x: 780, y: 350, w: 32, h: 32 };
  for (let y = 5; y < 27; y++) for (let x = 5; x < 27; x++) {
    const offset = ((box.y + y) * sourceImage.width + box.x + x) * 3;
    sourceImage.data[offset] = 80 + (x * 17 + y * 31) % 170;
    sourceImage.data[offset + 1] = 80 + (x * 43 + y * 11) % 170;
    sourceImage.data[offset + 2] = 80 + (x * 7 + y * 29) % 170;
  }
  const rawText = mode === "wisdom" ? wisdom(2) : weakText();
  const source: BagCursorSource = { image: sourceImage, grid: { x: 780, y: 350, w: 384, h: 160, cols: 12, rows: 5 }, cells: [{ row: 0, col: 0 }],
    rawText, confirmation: rawText, evidence: "synthetic:paired-source" };
  const frames = [{ x: 200, y: 200 }, { x: 500, y: 200 }].map((pointer, i): CursorVisionFrame => {
    const image = cloneImage(sourceImage);
    if (mode === "item") for (let y = 350; y < 382; y++) for (let x = 780; x < 812; x++) {
      const offset = (y * image.width + x) * 3;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 20;
    }
    copyBox(sourceImage, image, box, pointer.x - 16, pointer.y - 16);
    return { image, pointer, at: AT, evidence: "synthetic:cursor-position-" + i, cursorHash: EMPTY_HASH };
  }) as [CursorVisionFrame, CursorVisionFrame];
  return { source, frames, box, now: AT };
}

describe("generic cursor payload proof independent of per-item cursor hashes", () => {
  it.each(["item", "wisdom"] as const)("proves %s only from exact source identity and art following two positions", mode => {
    const input = fixture(mode), proof = proveBagCursorPayload(input);
    expect(proof.state).toBe(mode); expect(proof.rawText).toBe(input.source.rawText);
    expect(proof.scores.features).toBeGreaterThanOrEqual(24);
    expect(proof.scores.motion).toBe(1);
    expect(proof.scores.first).toBe(1); expect(proof.scores.second).toBe(1);
  });
  it("recognizes held art even when the OS cursor remains the ordinary empty arrow", () => {
    const input = fixture();
    expect(input.frames.every(frame => frame.cursorHash === EMPTY_HASH)).toBe(true);
    expect(proveBagCursorPayload(input).state).toBe("item");
    expect(proveBagCursorEmpty({ frames: input.frames, knownEmptyCursorHashes: [EMPTY_HASH], payloadSize: { width: 96, height: 160 }, now: AT }).state).toBe("unknown");
  });
  it.each(["screen", "native"])("excludes inventory top-left Wisdom stack digits absent from %s cursor art", channel => {
    const input = fixture("wisdom");
    if (channel === "native") for (const frame of input.frames) {
      const sprite: BgrImage = { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3) };
      copyBox(input.source.image, sprite, input.box, 16, 16);
      frame.cursorSprite = { image: sprite, alpha: new Uint8Array(64 * 64).fill(255), hotspot: { x: 32, y: 32 }, evidence: frame.evidence + ":native-art" };
      for (let y = frame.pointer.y - 16; y < frame.pointer.y + 16; y++) for (let x = frame.pointer.x - 16; x < frame.pointer.x + 16; x++) {
        const index = (y * frame.image.width + x) * 3;
        frame.image.data[index] = frame.image.data[index + 1] = frame.image.data[index + 2] = 20;
      }
    }
    // Stack digits stay in the source bag cell across both observations, but do
    // not appear in either cursor sprite. This reflects the recorded UI layout.
    for (const image of [input.source.image, ...input.frames.map(frame => frame.image)]) {
      for (let y = 4; y < 10; y++) for (let x = 4; x < 14; x++) {
        const index = ((input.box.y + y) * image.width + input.box.x + x) * 3;
        const value = (x + y) % 3 === 0 ? 255 : 30;
        image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
      }
    }
    const proof = proveBagCursorPayload(input);
    expect(proof.state).toBe("wisdom"); expect(proof.scores.features).toBeGreaterThanOrEqual(24);
    expect(proof.scores.first).toBe(1); expect(proof.scores.second).toBe(1);
  });
  it.each([["item", 32], ["item", 0], ["wisdom", 32], ["wisdom", 0]] as const)("matches native %s bitmap art with hotspot %s independently of per-item hashes", (mode, hotspot) => {
    const input = fixture(mode);
    for (const frame of input.frames) {
      for (let y = frame.pointer.y - 16; y < frame.pointer.y + 16; y++) for (let x = frame.pointer.x - 16; x < frame.pointer.x + 16; x++) {
        const offset = (y * frame.image.width + x) * 3;
        frame.image.data[offset] = frame.image.data[offset + 1] = frame.image.data[offset + 2] = 20;
      }
      const sprite: BgrImage = { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 3) };
      copyBox(input.source.image, sprite, input.box, 16, 16);
      frame.cursorSprite = { image: sprite, alpha: new Uint8Array(64 * 64).fill(255), hotspot: { x: hotspot, y: hotspot }, evidence: frame.evidence + ":native-art" };
    }
    const proof = proveBagCursorPayload(input);
    expect(proof.state).toBe(mode);
    expect(proof.scores.first).toBe(1); expect(proof.scores.second).toBe(1);
    const cursor = input.frames[1].cursorSprite!;
    cursor.alpha.fill(0);
    expect(proveBagCursorPayload(input).state).toBe("unknown");
    cursor.alpha.fill(255);
    cursor.hotspot.x = 64;
    expect(proveBagCursorPayload(input).state).toBe("unknown");
    cursor.hotspot.x = hotspot;
    cursor.image.data.fill(0);
    expect(proveBagCursorPayload(input).state).toBe("unknown");
  });
  it.each(["stale", "same-frame", "same-position", "outside", "wrong-text", "source-present", "unrelated-change", "wrong-art", "stationary-art"])("retains unknown for %s evidence", fault => {
    const input = fixture();
    if (fault === "stale") input.frames[0].at = "2026-09-14T11:59:57.999Z";
    if (fault === "same-frame") input.frames[1].evidence = input.frames[0].evidence;
    if (fault === "same-position") input.frames[1].pointer = input.frames[0].pointer;
    if (fault === "outside") input.frames[0].pointer.x = 0;
    if (fault === "wrong-text") input.source.confirmation = wisdom(2);
    if (fault === "source-present") for (const frame of input.frames) copyBox(input.source.image, frame.image, input.box, input.box.x, input.box.y);
    if (fault === "unrelated-change") input.frames[1].image.data.fill(200, (358 * 1200 + 825) * 3, (358 * 1200 + 835) * 3);
    if (fault === "wrong-art") {
      const frame = input.frames[1];
      for (let y = 184; y < 216; y++) for (let x = 484; x < 516; x++) frame.image.data[(y * 1200 + x) * 3] = 0;
    }
    if (fault === "stationary-art") input.frames[1].image = cloneImage(input.frames[0].image);
    expect(proveBagCursorPayload(input).state).toBe("unknown");
  });
  it("does not call a removed Wisdom stack an armed Wisdom mode", () => {
    const input = fixture(); input.source.rawText = input.source.confirmation = wisdom(2);
    expect(proveBagCursorPayload(input).state).toBe("item");
  });
  it("rejects stationary copies of the same art already present at both world positions", () => {
    const input = fixture();
    for (const frame of input.frames) for (const pointer of input.frames.map(other => other.pointer)) {
      copyBox(input.source.image, frame.image, input.box, pointer.x - 16, pointer.y - 16);
    }
    expect(proveBagCursorPayload(input).state).toBe("unknown");
  });
  it("rejects flat bright rectangles with no distinctive sprite features", () => {
    const input = fixture(); input.source.image.data.fill(200);
    expect(proveBagCursorPayload(input).state).toBe("unknown");
  });
});

describe("positive empty cursor evidence", () => {
  function emptyPair(): [CursorVisionFrame, CursorVisionFrame] {
    return [{ x: 200, y: 200 }, { x: 500, y: 200 }].map((pointer, i) => ({ image: freshImage(), pointer,
      at: AT, evidence: "synthetic:empty-" + i, cursorHash: EMPTY_HASH })) as [CursorVisionFrame, CursorVisionFrame];
  }
  it("requires an empty native cursor and stable entire software-payload regions at two separate positions", () => {
    const proof = proveBagCursorEmpty({ frames: emptyPair(), knownEmptyCursorHashes: [EMPTY_HASH], payloadSize: { width: 96, height: 160 }, now: AT });
    expect(proof.state).toBe("empty"); expect(proof.scores.motion).toBe(1);
  });
  it.each(["unknown-native", "animated-world", "tiny-payload", "overlap", "partial-region"])("does not infer empty from %s", fault => {
    const frames = emptyPair();
    if (fault === "unknown-native") frames[0].cursorHash = "unrecognized";
    if (fault === "animated-world") frames[1].image.data[(200 * 1200 + 200) * 3] = 70;
    if (fault === "tiny-payload") frames[0].image.data[(200 * 1200 + 200) * 3] = 200;
    if (fault === "overlap") frames[1].pointer.x = 210;
    if (fault === "partial-region") frames[0].pointer.y = 20;
    expect(proveBagCursorEmpty({ frames, knownEmptyCursorHashes: [EMPTY_HASH], payloadSize: { width: 96, height: 160 }, now: AT }).state).toBe("unknown");
  });
});
