import { crop, downsample, grayFromJson, grayToJson, ncc, type GrayImage } from "./grayImage.js";
import type { ScreenRect, SelectedMonitor } from "./screenLayout.js";

export interface ClientBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackedPatch {
  width: number;
  height: number;
  pixels: number[];
}

export interface ChromeMark {
  box: ClientBox;
  patch: PackedPatch;
}

export interface GridMark extends ClientBox {
  cols: number;
  rows: number;
  patch?: PackedPatch;
}

export type StashTabKind = "normal" | "quad";

export const NORMAL_STASH_CELLS = { cols: 12, rows: 12 } as const;
export const QUAD_STASH_CELLS = { cols: 24, rows: 24 } as const;
export const BAG_CELLS = { cols: 12, rows: 5 } as const;
export const VENTOR_BAG_CELLS = { cols: 12, rows: 5 } as const;

export interface NpcMark {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  patch?: PackedPatch;
}

export interface CalibrationProfile {
  version: 1;
  client: { width: number; height: number };
  monitor?: SelectedMonitor;
  stashOpenChrome?: ChromeMark;
  bagOpenChrome?: ChromeMark;
  stashGrid?: GridMark;
  quadStashGrid?: GridMark;
  activeStashTab?: StashTabKind;
  bagGrid?: GridMark;
  ventorBagGrid?: GridMark;
  stashSearch?: ClientBox;
  npcs: NpcMark[];
  updatedAt: string;
}

export const CHROME_NCC = 0.72;
export const GRID_NCC = 0.64;
export const GRID_LAYOUT_NCC = 0.22;
export const NPC_NCC = 0.58;
const PATCH_MAX = 96;

export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyProfile(width = 3840, height = 2160): CalibrationProfile {
  return {
    version: 1,
    client: { width, height },
    npcs: [],
    updatedAt: new Date().toISOString(),
  };
}

export function clientBoxesMatch(a?: ClientBox, b?: ClientBox, slop = 8): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= slop &&
    Math.abs(a.y - b.y) <= slop &&
    Math.abs(a.w - b.w) <= slop &&
    Math.abs(a.h - b.h) <= slop
  );
}

export function applyStashPanel(box: ClientBox, patch?: PackedPatch): {
  stashGrid: GridMark;
  quadStashGrid: GridMark;
} {
  const area = { x: box.x, y: box.y, w: box.w, h: box.h, ...(patch ? { patch } : {}) };
  return {
    stashGrid: { ...area, ...NORMAL_STASH_CELLS },
    quadStashGrid: { ...area, ...QUAD_STASH_CELLS },
  };
}

export function stampStashPanel(
  profile: CalibrationProfile,
  box: ClientBox,
  patch?: PackedPatch,
): CalibrationProfile {
  const grids = applyStashPanel(box, patch);
  return {
    ...profile,
    stashGrid: grids.stashGrid,
    quadStashGrid: grids.quadStashGrid,
  };
}

export interface ResolvedStashGrids {
  normal?: GridMark;
  quad?: GridMark;
  shared: boolean;
}

/** One on-screen stash panel serves both 12×12 and 24×24. Divergent old marks stay independent. */
export function resolveStashGrids(profile?: CalibrationProfile): ResolvedStashGrids {
  if (!profile) return { shared: false };
  const { stashGrid, quadStashGrid } = profile;
  if (stashGrid && quadStashGrid) {
    if (clientBoxesMatch(stashGrid, quadStashGrid)) {
      return {
        normal: { ...stashGrid, ...NORMAL_STASH_CELLS },
        quad: {
          ...stashGrid,
          ...QUAD_STASH_CELLS,
          patch: quadStashGrid.patch ?? stashGrid.patch,
        },
        shared: true,
      };
    }
    return { normal: stashGrid, quad: quadStashGrid, shared: false };
  }
  if (stashGrid) {
    return {
      normal: { ...stashGrid, ...NORMAL_STASH_CELLS },
      quad: { ...stashGrid, ...QUAD_STASH_CELLS },
      shared: true,
    };
  }
  if (quadStashGrid) {
    return {
      normal: { ...quadStashGrid, ...NORMAL_STASH_CELLS },
      quad: { ...quadStashGrid, ...QUAD_STASH_CELLS },
      shared: true,
    };
  }
  return { shared: false };
}

export function stashAreasDiverge(profile?: CalibrationProfile): boolean {
  return Boolean(
    profile?.stashGrid && profile.quadStashGrid && !clientBoxesMatch(profile.stashGrid, profile.quadStashGrid),
  );
}

export function stashTabFromGridSize(
  size?: { cols?: number; rows?: number } | StashTabKind,
): StashTabKind | undefined {
  if (size === "quad" || size === "normal") return size;
  if (size && typeof size === "object") {
    if (size.cols === 24) return "quad";
    if (size.cols === 12) return "normal";
  }
  return undefined;
}

export function withDetectedStashTab(
  profile: CalibrationProfile,
  detected?: { cols?: number; rows?: number } | StashTabKind,
): CalibrationProfile {
  const tab = stashTabFromGridSize(detected);
  return tab ? { ...profile, activeStashTab: tab } : profile;
}

export function stashGridForKind(
  profile: CalibrationProfile | undefined,
  kind: "stash-normal" | "stash-quad",
): GridMark | undefined {
  const grids = resolveStashGrids(profile);
  return kind === "stash-quad" ? grids.quad : grids.normal;
}

export function profileHasGrids(profile?: CalibrationProfile): boolean {
  return Boolean(profile?.bagGrid || profile?.ventorBagGrid || profile?.stashGrid || profile?.quadStashGrid);
}

export function profileReadyForDeposit(profile?: CalibrationProfile): boolean {
  return Boolean(profile?.bagGrid && (profile?.stashGrid || profile?.quadStashGrid));
}

export function stashSearchBox(profile?: CalibrationProfile): ClientBox | undefined {
  const box = profile?.stashSearch;
  if (!box || box.w < 8 || box.h < 8) return undefined;
  return box;
}

export function profileReadyForWalk(profile?: CalibrationProfile): boolean {
  return Boolean(profile?.npcs.length);
}

export function activeStashGrid(
  profile?: CalibrationProfile,
  detected?: { cols?: number; rows?: number } | StashTabKind,
): GridMark | undefined {
  if (!profile) return undefined;
  const grids = resolveStashGrids(profile);
  const tab = stashTabFromGridSize(detected) ?? profile.activeStashTab;
  if (tab === "quad") return grids.quad ?? grids.normal;
  return grids.normal ?? grids.quad;
}

export function cropClientBox(frame: GrayImage, client: ScreenRect, box: ClientBox): GrayImage {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  return crop(frame, box.x * sx, box.y * sy, Math.max(1, box.w * sx), Math.max(1, box.h * sy));
}

export function packPatch(frame: GrayImage, client: ScreenRect, box: ClientBox): PackedPatch {
  const raw = cropClientBox(frame, client, box);
  const width = Math.min(PATCH_MAX, Math.max(8, raw.width));
  const height = Math.min(PATCH_MAX, Math.max(8, raw.height));
  return grayToJson(downsample(raw, width, height));
}

export function packNpcPatch(frame: GrayImage, client: ScreenRect, x: number, y: number, size = 64): PackedPatch {
  return packPatch(frame, client, { x: x - size / 2, y: y - size / 2, w: size, h: size });
}

export function matchChrome(frame: GrayImage, client: ScreenRect, mark: ChromeMark): number {
  const live = cropClientBox(frame, client, mark.box);
  const needle = grayFromJson(mark.patch);
  const scaled = downsample(live, needle.width, needle.height);
  return ncc(scaled, needle, 0, 0);
}

/** Frame/border only, so item cells can change without looking "closed". */
export function matchGridRim(frame: GrayImage, client: ScreenRect, mark: ChromeMark): number {
  const live = cropClientBox(frame, client, mark.box);
  const needle = grayFromJson(mark.patch);
  const scaled = downsample(live, needle.width, needle.height);
  const tw = Math.max(3, Math.floor(needle.width * 0.12));
  const th = Math.max(3, Math.floor(needle.height * 0.12));
  const strips = [
    [crop(scaled, 0, 0, scaled.width, th), crop(needle, 0, 0, needle.width, th)],
    [crop(scaled, 0, scaled.height - th, scaled.width, th), crop(needle, 0, needle.height - th, needle.width, th)],
    [crop(scaled, 0, 0, tw, scaled.height), crop(needle, 0, 0, tw, needle.height)],
    [crop(scaled, scaled.width - tw, 0, tw, scaled.height), crop(needle, needle.width - tw, 0, tw, needle.height)],
  ] as const;
  let sum = 0;
  for (const [hay, pin] of strips) sum += ncc(hay, pin, 0, 0);
  return sum / strips.length;
}

/** Coarse panel shape, ignoring individual item icons. */
export function matchGridLayout(frame: GrayImage, client: ScreenRect, mark: ChromeMark): number {
  const live = downsample(cropClientBox(frame, client, mark.box), 24, 16);
  const needle = downsample(grayFromJson(mark.patch), 24, 16);
  return ncc(live, needle, 0, 0);
}

export function matchNpc(frame: GrayImage, client: ScreenRect, npc: NpcMark): number {
  if (!npc.patch) return 1;
  const live = cropClientBox(frame, client, { x: npc.x - 32, y: npc.y - 32, w: 64, h: 64 });
  const needle = grayFromJson(npc.patch);
  const scaled = downsample(live, needle.width, needle.height);
  return ncc(scaled, needle, 0, 0);
}

export function toScreenBox(client: ScreenRect, box: ClientBox) {
  return {
    x: Math.round(client.left + box.x),
    y: Math.round(client.top + box.y),
    w: Math.round(box.w),
    h: Math.round(box.h),
  };
}
