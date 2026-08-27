import { bestNcc, crop, downsample, grayFromJson, type GrayImage } from "./grayImage.js";
import type { ClientBox, NpcMark } from "./calibrationProfile.js";

export const NAMEPLATE_NCC = 0.6;

export interface Nameplate extends ClientBox {
  score: number;
}

const VIEW_W = 480;
const VIEW_W_4K = 960;
const WORLD_RIGHT = 0.72;
const WORLD_TOP = 0.02;
const WORLD_BOTTOM = 0.7;

function viewWidthFor(frame: GrayImage): number {
  return frame.width >= 2560 ? VIEW_W_4K : VIEW_W;
}

export function findNameplates(frame: GrayImage): Nameplate[] {
  const viewW = viewWidthFor(frame);
  const viewH = Math.max(90, Math.round((frame.height / Math.max(frame.width, 1)) * viewW));
  const view = downsample(frame, viewW, viewH);
  const xLimit = Math.floor(viewW * WORLD_RIGHT);
  const y0 = Math.floor(viewH * WORLD_TOP);
  const y1 = Math.floor(viewH * WORLD_BOTTOM);
  const mixed = nameplateRows(view, xLimit, y0, y1);
  const plates: Nameplate[] = [];
  for (const band of mixed) {
    for (const span of nameplateSpans(view, band, xLimit)) {
      const sx = (span.x / viewW) * frame.width;
      const sy = (band.y / viewH) * frame.height;
      const sw = (span.w / viewW) * frame.width;
      const sh = (band.h / viewH) * frame.height;
      const padX = sw * 0.08;
      const padY = sh * 0.35;
      plates.push({
        x: Math.round(sx - padX),
        y: Math.round(sy - padY),
        w: Math.round(sw + padX * 2),
        h: Math.round(sh + padY * 2),
        score: 1,
      });
    }
  }
  return mergeOverlaps(plates);
}

export function locateNameplate(frame: GrayImage, needle: GrayImage, hint?: ClientBox): Nameplate | undefined {
  let best: Nameplate | undefined;
  for (const plate of findNameplates(frame)) {
    if (hint && !similarSize(plate, hint)) continue;
    const box = hint ?? plate;
    const pad = 16;
    const hay = crop(frame, plate.x - pad, plate.y - pad, box.w + pad * 2, box.h + pad * 2);
    const scaled = downsample(needle, Math.min(box.w, hay.width), Math.min(box.h, hay.height));
    const hit = bestNcc(hay, scaled, 1);
    if (hit.score >= NAMEPLATE_NCC && (!best || hit.score > best.score)) {
      best = {
        x: Math.round(plate.x - pad + hit.x),
        y: Math.round(plate.y - pad + hit.y),
        w: scaled.width,
        h: scaled.height,
        score: hit.score,
      };
    }
  }
  return best;
}

export function locateStashNameplate(frame: GrayImage, npc?: NpcMark): Nameplate | undefined {
  if (!npc?.patch) return undefined;
  const size = npc.w && npc.h ? { x: 0, y: 0, w: npc.w, h: npc.h } : undefined;
  return locateNameplate(frame, grayFromJson(npc.patch), size);
}

export function likelyStashNameplates(frame: GrayImage): Nameplate[] {
  const minX = frame.width >= 2560 ? 0.38 : 0.18;
  return findNameplates(frame)
    .filter(
      (plate) =>
        plate.x > frame.width * minX &&
        plate.x + plate.w < frame.width * 0.5 &&
        plate.y > frame.height * 0.07 &&
        plate.y + plate.h < frame.height * 0.28 &&
        plate.w >= 40 &&
        plate.w <= 165 &&
        plate.h >= 14 &&
        plate.h <= 80,
    )
    .sort((a, b) => a.w - b.w || a.y - b.y);
}

/** Short high label above the waypoint — never the wider WAYPOINT plate. */
export function pickStashNameplate(frame: GrayImage): Nameplate | undefined {
  return likelyStashNameplates(frame)[0];
}

/** Dead-center of the STASH label, on the baseline of the A. */
export function stashClickFromNameplate(plate: ClientBox): { x: number; y: number } {
  return {
    x: Math.round(plate.x + plate.w / 2),
    y: Math.round(plate.y + plate.h * 0.78),
  };
}

function nameplateRows(view: GrayImage, xLimit: number, y0: number, y1: number): Array<{ y: number; h: number }> {
  const darkT = 48;
  const brightT = 140;
  const on = new Uint8Array(view.height);
  for (let y = y0; y < y1; y += 1) {
    let dark = 0;
    let bright = 0;
    for (let x = 0; x < xLimit; x += 1) {
      const p = view.pixels[y * view.width + x];
      if (p <= darkT) dark += 1;
      if (p >= brightT) bright += 1;
    }
    on[y] = dark >= 6 && bright >= 2 ? 1 : 0;
  }
  const bands: Array<{ y: number; h: number }> = [];
  let run = -1;
  for (let y = y0; y <= y1; y += 1) {
    const hit = y < y1 && on[y];
    if (hit && run < 0) run = y;
    if (!hit && run >= 0) {
      const h = y - run;
      if (h >= 3 && h <= 28) bands.push({ y: run, h });
      run = -1;
    }
  }
  return bands;
}

function nameplateSpans(view: GrayImage, band: { y: number; h: number }, xLimit: number): Array<{ x: number; w: number }> {
  const darkT = 48;
  const brightT = 140;
  const on = new Uint8Array(xLimit);
  for (let x = 0; x < xLimit; x += 1) {
    let dark = 0;
    let bright = 0;
    for (let y = band.y; y < band.y + band.h; y += 1) {
      const p = view.pixels[y * view.width + x];
      if (p <= darkT) dark += 1;
      if (p >= brightT) bright += 1;
    }
    on[x] = bright >= 1 ? 1 : 0;
  }
  const spans: Array<{ x: number; w: number }> = [];
  let run = -1;
  let gap = 0;
  for (let x = 0; x <= xLimit; x += 1) {
    const hit = x < xLimit && on[x];
    if (hit) {
      if (run < 0) run = x;
      gap = 0;
    } else if (run >= 0) {
      gap += 1;
      if (gap > 3 || x === xLimit) {
        const w = x - gap - run;
        const aspect = w / band.h;
        if (w >= 10 && aspect >= 1.8 && aspect <= 9.5) spans.push({ x: run, w });
        run = -1;
        gap = 0;
      }
    }
  }
  return spans;
}

function similarSize(a: ClientBox, b: ClientBox): boolean {
  const wr = a.w / Math.max(1, b.w);
  const hr = a.h / Math.max(1, b.h);
  return wr > 0.68 && wr < 1.45 && hr > 0.52 && hr < 1.7;
}

function mergeOverlaps(plates: Nameplate[]): Nameplate[] {
  const sorted = [...plates].sort((a, b) => a.x - b.x || a.y - b.y);
  const kept: Nameplate[] = [];
  for (const plate of sorted) {
    const hit = kept.find((other) => overlap(plate, other) > 0.45);
    if (!hit) kept.push(plate);
  }
  return kept;
}

function overlap(a: ClientBox, b: ClientBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = a.w * a.h;
  return area <= 0 ? 0 : (x * y) / area;
}
