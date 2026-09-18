import type { BgrImage } from "./cellOccupancy.js";
import type { ClientBox, GridMark } from "./calibrationProfile.js";
import { bagCellPixels, emptyBagPixels, sameBagPixels } from "./bagPixels.js";
import { exactText, validCell, wisdomCount, type BagPosition } from "./bagAssessment.js";
import { looksLikePoeItemText } from "./parseItem.js";
import { bagArtMask, bagFootprintLook, bagProbeDelta, emptyBagCell, type BagView } from "./bagFastVision.js";

export interface CursorVisionFrame {
  image: BgrImage;
  pointer: { x: number; y: number };
  at: string;
  evidence: string;
  cursorHash?: string;
  /** Native cursor art is separate from screen pixels. Alpha has one byte per pixel. */
  cursorSprite?: { image: BgrImage; alpha: Uint8Array; hotspot: { x: number; y: number }; evidence: string };
}
export interface BagCursorSource {
  image: BgrImage;
  grid: GridMark;
  cells: BagPosition[];
  rawText: string;
  confirmation: string;
  evidence: string;
}
export interface CursorVisionProof {
  state: "item" | "wisdom" | "empty" | "unknown";
  rawText?: string;
  reason: string;
  evidence: string[];
  scores: { features: number; first: number; second: number; motion: number };
}
type Feature = { x: number; y: number; b: number; g: number; r: number };
type Match = { score: number; scale: number; dx: number; dy: number; channel: "screen" | "native" };
const pixel = (image: BgrImage, x: number, y: number) => {
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 3;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!] as const;
};
const validImage = (image: BgrImage) => !!image && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) &&
  image.width > 0 && image.height > 0 && image.data.length === image.width * image.height * 3;
const inImage = (image: BgrImage, box: ClientBox) => [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
  box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 && box.x + box.w <= image.width && box.y + box.h <= image.height;
const overlaps = (a: ClientBox, b: ClientBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centered = (pointer: { x: number; y: number }, w: number, h: number): ClientBox => ({ x: Math.floor(pointer.x - w / 2), y: Math.floor(pointer.y - h / 2), w, h });
const wholeView = (image: BgrImage, pointer: { x: number; y: number }, evidence: string): BagView =>
  ({ at: "", evidence, pointer, parts: [{ x: 0, y: 0, w: image.width, h: image.height, image }] });
const unknown = (reason: string, evidence: string[] = []): CursorVisionProof => ({ state: "unknown", reason, evidence,
  scores: { features: 0, first: 0, second: 0, motion: 0 } });

function validPair(frames: readonly [CursorVisionFrame, CursorVisionFrame], now: string): boolean {
  const [a, b] = frames, time = Date.parse(now);
  return Number.isFinite(time) && frames.every(frame => validImage(frame.image) && !!frame.evidence &&
    Number.isFinite(Date.parse(frame.at)) && time - Date.parse(frame.at) >= 0 && time - Date.parse(frame.at) <= 2000 &&
    Number.isFinite(frame.pointer.x) && Number.isFinite(frame.pointer.y)) && a.evidence !== b.evidence &&
    Date.parse(a.at) <= Date.parse(b.at) && a.image.width === b.image.width && a.image.height === b.image.height;
}
function sourceBox(source: BagCursorSource): ClientBox | undefined {
  const { grid, cells } = source;
  if (!validImage(source.image) || !grid || grid.cols !== 12 || grid.rows !== 5 || !inImage(source.image, grid) ||
    grid.w / 12 < 12 || grid.h / 5 < 12 || !cells.length || cells.some(cell => !validCell(cell)) ||
    new Set(cells.map(cell => `${cell.row},${cell.col}`)).size !== cells.length) return;
  const row = Math.min(...cells.map(cell => cell.row)), col = Math.min(...cells.map(cell => cell.col));
  const rows = Math.max(...cells.map(cell => cell.row)) - row + 1, cols = Math.max(...cells.map(cell => cell.col)) - col + 1;
  if (rows * cols !== cells.length) return;
  return { x: grid.x + col * grid.w / 12, y: grid.y + row * grid.h / 5, w: cols * grid.w / 12, h: rows * grid.h / 5 };
}

/** Bright edge features exclude flat inventory tints and stack-count text. For a
 * pickup, the now-empty source additionally masks pixels unrelated to the art. */
function sourceFeatures(source: BagCursorSource, box: ClientBox, departed?: BgrImage): Feature[] {
  const bins = new Map<string, { strength: number; feature: Feature }>();
  const cellW = source.grid.w / 12, cellH = source.grid.h / 5;
  for (let y = 4; y < box.h - 4; y += 2) for (let x = 4; x < box.w - 4; x += 2) {
    if (x % cellW < 4 || x % cellW > cellW - 4 || y % cellH < 4 || y % cellH > cellH - 4) continue;
    // PoE2 inventory stack counts occupy the top-left corner. The lower scroll
    // illustration remains part of the matching art; cursor use has no count.
    if (!departed && x <= box.w * .45 && y <= box.h * .33) continue;
    const color = pixel(source.image, box.x + x, box.y + y), light = Math.max(...color);
    const nearby = pixel(source.image, box.x + x + 2, box.y + y + 2);
    const edge = Math.max(...color.map((value, i) => Math.abs(value - nearby[i]!)));
    if (light < 80 || edge < 18) continue;
    if (departed && light - Math.max(...pixel(departed, box.x + x, box.y + y)) < 24) continue;
    const key = Math.floor(x * 16 / box.w) + "," + Math.floor(y * 16 / box.h);
    const strength = light + edge, previous = bins.get(key);
    if (!previous || previous.strength < strength) bins.set(key, { strength, feature: { x, y, b: color[0], g: color[1], r: color[2] } });
  }
  return [...bins.values()].map(value => value.feature);
}
function matchFeatures(image: BgrImage, alpha: Uint8Array | undefined, pointer: { x: number; y: number }, box: ClientBox,
  features: Feature[], channel: Match["channel"]): Match[] {
  const matches: Match[] = [];
  // These are candidate render transforms, not permission. Every selected
  // transform must independently match the same art in both fresh frames.
  for (const scale of [.5, 1]) for (let dy = -12; dy <= 12; dy += 2) for (let dx = -12; dx <= 12; dx += 2) {
    const left = Math.round(pointer.x - box.w * scale / 2 + dx), top = Math.round(pointer.y - box.h * scale / 2 + dy);
    let error = 0, good = 0;
    for (const feature of features) {
      const x = Math.round(left + feature.x * scale), y = Math.round(top + feature.y * scale);
      if (x < 0 || y < 0 || x >= image.width || y >= image.height || alpha && alpha[y * image.width + x]! < 240) { error = Infinity; break; }
      const color = pixel(image, x, y), deltas = [Math.abs(color[0] - feature.b), Math.abs(color[1] - feature.g), Math.abs(color[2] - feature.r)];
      error += (deltas[0]! + deltas[1]! + deltas[2]!) / 3;
      if (Math.max(...deltas) <= 24) good++;
    }
    if (good / features.length >= .98 && error / features.length <= 12) matches.push({ score: 1 - error / features.length / 255, scale, dx, dy, channel });
  }
  return matches.sort((a, b) => b.score - a.score);
}
function frameMatches(frame: CursorVisionFrame, box: ClientBox, features: Feature[]): Match[] {
  const screen = matchFeatures(frame.image, undefined, frame.pointer, box, features, "screen"), cursor = frame.cursorSprite;
  if (!cursor || !validImage(cursor.image) || cursor.alpha.length !== cursor.image.width * cursor.image.height || !cursor.evidence ||
    !Number.isSafeInteger(cursor.hotspot.x) || !Number.isSafeInteger(cursor.hotspot.y) || cursor.hotspot.x < 0 || cursor.hotspot.y < 0 ||
    cursor.hotspot.x >= cursor.image.width || cursor.hotspot.y >= cursor.image.height) return screen;
  // The hotspot locates clicks, not the art within the native cursor bitmap.
  const center = { x: cursor.image.width / 2, y: cursor.image.height / 2 };
  return [...screen, ...matchFeatures(cursor.image, cursor.alpha, center, box, features, "native")];
}

/** Mean colour of the source art (pixels far from the cell's own background) and of the
 * pixels a payload changed. Live, the downsampled armed scroll stayed within 13 per channel
 * of its inventory art; grossly different art is not the verified source. */
function sourceArtColour(source: BagCursorSource, box: ClientBox, skipCount: boolean): number[] | undefined {
  const all: Array<readonly [number, number, number]> = [];
  for (let y = 5; y < box.h - 5; y++) for (let x = 5; x < box.w - 5; x++) {
    if (skipCount && x <= box.w * .5 && y <= box.h * .38) continue;
    all.push(pixel(source.image, box.x + x, box.y + y));
  }
  if (!all.length) return;
  const median = [0, 1, 2].map(c => all.map(p => p[c]!).sort((a, b) => a - b)[all.length >> 1]!);
  const art = all.filter(p => Math.max(...p.map((v, c) => Math.abs(v - median[c]!))) > 40);
  return art.length >= 24 ? [0, 1, 2].map(c => art.reduce((sum, p) => sum + p[c]!, 0) / art.length) : undefined;
}
function changedColour(frame: BgrImage, other: BgrImage, region: ClientBox): number[] | undefined {
  const sum = [0, 0, 0]; let count = 0;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
    const a = pixel(frame, x, y), b = pixel(other, x, y);
    if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= 6) continue;
    sum[0]! += a[0]; sum[1]! += a[1]; sum[2]! += a[2]; count++;
  }
  return count ? sum.map(v => v / count) : undefined;
}

/** Generic evidence for a specific physical item. A caller still checks map,
 * focus, modal state, the durable action receipt and shared disposal policy.
 * Never infer this result from an intended action or an OS cursor hash. */
export function proveBagCursorPayload(input: { source: BagCursorSource; frames: readonly [CursorVisionFrame, CursorVisionFrame]; now: string;
  /** Known physical footprints. With them, identity is judged on item art, because armed
   * Wisdom and a held item legitimately pulse and re-tint cell backgrounds (live 2026-09-14). */
  items?: readonly BagPosition[][] }): CursorVisionProof {
  const { source, frames, now } = input, box = sourceBox(source);
  const evidence = [source.evidence, ...frames.map(frame => frame.evidence)];
  if (!box || !validPair(frames, now) || !source.evidence || !looksLikePoeItemText(source.rawText) ||
    exactText(source.rawText) !== exactText(source.confirmation) || frames.some(frame => frame.image.width !== source.image.width || frame.image.height !== source.image.height)) return unknown("Source identity, geometry, or fresh independent frame pair is missing.", evidence);
  const regions = frames.map(frame => centered(frame.pointer, box.w + 24, box.h + 24));
  if (regions.some(region => !inImage(source.image, region) || overlaps(region, source.grid)) || overlaps(regions[0]!, regions[1]!)) return unknown("Cursor probes must be separate world regions outside inventory.", evidence);
  let departed = true, unchanged = true;
  const target = new Set(source.cells.map(cell => `${cell.row},${cell.col}`));
  const before = wholeView(source.image, { x: 0, y: 0 }, source.evidence), views = frames.map(frame => wholeView(frame.image, frame.pointer, frame.evidence));
  const byArt = new Set<string>();
  for (const cells of input.items ?? []) {
    if (cells.some(cell => target.has(`${cell.row},${cell.col}`))) continue;
    const mask = bagArtMask(before, source.grid, cells);
    if (views.some(view => bagFootprintLook(view, source.grid, mask) !== "same")) return unknown("An unrelated bag item changed during cursor observation.", evidence);
    for (const cell of cells) byArt.add(`${cell.row},${cell.col}`);
  }
  for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) {
    if (byArt.has(`${row},${col}`)) continue;
    const pixels = bagCellPixels(source.image, source.grid, { row, col });
    for (const frame of frames) {
      const after = bagCellPixels(frame.image, source.grid, { row, col }), same = sameBagPixels(pixels, after);
      if (target.has(`${row},${col}`)) { unchanged &&= same; departed &&= !same && emptyBagPixels(after); }
      else if (!same) return unknown("An unrelated bag cell changed during cursor observation.", evidence);
    }
  }
  if (input.items && !departed && !unchanged) {
    // The used stack turns olive and an emptied source is re-tinted; judge the art and the full-resolution emptiness instead.
    const mask = bagArtMask(before, source.grid, source.cells, { excludeCount: true });
    unchanged = !mask.weak && views.every(view => bagFootprintLook(view, source.grid, mask) === "same");
    departed = !emptyBagCell(before, source.grid, source.cells[0]!) && views.every(view => source.cells.every(cell => emptyBagCell(view, source.grid, cell)));
  }
  const state = departed ? "item" : unchanged && wisdomCount(source.rawText) ? "wisdom" : "unknown";
  if (state === "unknown") return unknown("The source neither departed completely nor remained a verified Wisdom stack.", evidence);
  const features = sourceFeatures(source, box, departed ? frames[0].image : undefined);
  if (features.length < 24 || Math.max(...features.map(f => f.x)) - Math.min(...features.map(f => f.x)) < box.w * .25 ||
    Math.max(...features.map(f => f.y)) - Math.min(...features.map(f => f.y)) < box.h * .25) return unknown("Source art has too few distinct distributed features for cursor identity.", evidence);
  const first = frameMatches(frames[0], box, features), second = frameMatches(frames[1], box, features);
  const pairs = first.flatMap(a => second.filter(b => a.channel === b.channel && a.scale === b.scale && a.dx === b.dx && a.dy === b.dy).map(b => [a, b] as const));
  const pair = pairs.find(([a]) => {
    if (a.channel === "native") return true; // Native art is attached to the independently observed OS pointer.
    // Matching art already present at both world positions is scenery, not
    // cursor-following evidence. Require disappearance in each off-pointer view.
    return !frames.some((frame, i) => matchFeatures(frames[1 - i]!.image, undefined, frame.pointer, box, features, "screen")
      .some(match => match.scale === a.scale && match.dx === a.dx && match.dy === a.dy));
  });
  if (!pair) {
    // The game renders cursor payloads in software, downsampled and blended, so a template
    // match can fail on a genuine payload. Over static probe artwork, one compact object that
    // is present only under the pointer in EACH frame, with the same size and offset, is a
    // payload following the pointer; the verified source state above says which one.
    const deltas = [bagProbeDelta(views[1]!, views[0]!, regions[0]!), bagProbeDelta(views[0]!, views[1]!, regions[1]!)];
    const near = deltas.every((delta, i) => delta.changed >= 120 && !!delta.box && frames[i]!.pointer.x >= delta.box.x - 24 && frames[i]!.pointer.x <= delta.box.x + delta.box.w + 24 &&
      frames[i]!.pointer.y >= delta.box.y - 24 && frames[i]!.pointer.y <= delta.box.y + delta.box.h + 24);
    const [a, b] = deltas.map(delta => delta.box);
    const wanted = sourceArtColour(source, box, state === "wisdom");
    const coloured = !!wanted && frames.every((frame, i) => {
      const seen = changedColour(frame.image, frames[1 - i]!.image, regions[i]!);
      return !!seen && seen.every((value, channel) => Math.abs(value - wanted[channel]!) <= 32);
    });
    const follows = !!input.items && coloured && near && !!a && !!b && Math.abs(a.w - b.w) <= Math.max(4, a.w * .15) && Math.abs(a.h - b.h) <= Math.max(4, a.h * .15) &&
      Math.abs((a.x - frames[0].pointer.x) - (b.x - frames[1].pointer.x)) <= 6 && Math.abs((a.y - frames[0].pointer.y) - (b.y - frames[1].pointer.y)) <= 6;
    if (!follows) return { ...unknown("The same source sprite was not independently observed following both pointer positions.", evidence), scores: { features: features.length, first: first[0]?.score ?? 0, second: second[0]?.score ?? 0, motion: 0 } };
    return { state, rawText: source.rawText, reason: "Exact paired source text, physical source state, and one compact software payload present only under the pointer in both frames.", evidence,
      scores: { features: features.length, first: first[0]?.score ?? 0, second: second[0]?.score ?? 0, motion: 1 } };
  }
  return { state, rawText: source.rawText, reason: "Exact paired source text, physical source state, and matching art following two pointer positions.", evidence,
    scores: { features: features.length, first: pair[0].score, second: pair[1].score, motion: 1 } };
}

/** Positive empty evidence: an independently known empty native cursor AND both
 * complete potential-payload regions remain visually unchanged when the pointer
 * moves away. No payload-template hit by itself never means empty. Animated or
 * occluded world regions return unknown and require different probe positions. */
export function proveBagCursorEmpty(input: { frames: readonly [CursorVisionFrame, CursorVisionFrame]; knownEmptyCursorHashes: readonly string[];
  payloadSize: { width: number; height: number }; now: string }): CursorVisionProof {
  const { frames, payloadSize, now } = input, evidence = frames.map(frame => frame.evidence);
  if (!validPair(frames, now) || frames.some(frame => !frame.cursorHash || !input.knownEmptyCursorHashes.includes(frame.cursorHash)) ||
    ![payloadSize.width, payloadSize.height].every(value => Number.isSafeInteger(value) && value >= 48)) return unknown("Known empty native cursor and fresh complete payload regions are required.", evidence);
  const boxes = frames.map(frame => centered(frame.pointer, payloadSize.width, payloadSize.height));
  if (boxes.some(box => !inImage(frames[0].image, box)) || overlaps(boxes[0]!, boxes[1]!)) return unknown("Empty cursor probes overlap or leave the frame.", evidence);
  const scores: number[] = [];
  for (const box of boxes) {
    let error = 0, changed = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
      const a = pixel(frames[0].image, x, y), b = pixel(frames[1].image, x, y);
      const delta = Math.max(...a.map((value, i) => Math.abs(value - b[i]!))); error += delta;
      if (delta > 3) changed++;
    }
    const count = box.w * box.h;
    if (changed !== 0 || error / count > 1) return unknown("Pixels near a cursor position changed; a software-held payload cannot be excluded.", evidence);
    scores.push(1 - error / count / 255);
  }
  return { state: "empty", reason: "Known empty native art and both entire software-payload regions are unchanged with the pointer elsewhere.", evidence,
    scores: { features: payloadSize.width * payloadSize.height, first: scores[0]!, second: scores[1]!, motion: 1 } };
}
