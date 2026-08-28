import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClientBox } from "./calibrationProfile.js";
import type { GrayImage } from "./grayImage.js";
import { regionStats } from "./grayImage.js";
import { itemMatchesWantedClass } from "./itemClassFilter.js";
import type { ScreenRect } from "./screenLayout.js";

/**
 * A destination tab: either a canonical dropdown index (preferred — the tab
 * strip reorders itself, the dropdown does not) or a calibrated click point.
 */
export interface TabPoint {
  label: string;
  x?: number;
  y?: number;
  index?: number;
}

export interface TabRoute {
  tab: TabPoint;
  /** Item classes (as printed by the game's "Item Class:" line) this tab receives. */
  classes: string[];
  /** Case-insensitive regex sources matched against item name/base type; wins over classes. */
  namePatterns?: string[];
}

export interface TabRoutesConfig {
  version: 1;
  client: { width: number; height: number };
  /** The dump tab items are drawn from and returned to. */
  source: TabPoint;
  routes: TabRoute[];
}

export function tabRoutesPath(dir: string): string {
  return path.join(dir, "tab-routes.json");
}

export function loadTabRoutes(dir: string): TabRoutesConfig | undefined {
  const file = tabRoutesPath(dir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(
      raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
    ) as TabRoutesConfig;
    if (parsed.version !== 1 || !parsed.source || !Array.isArray(parsed.routes)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveTabRoutes(dir: string, config: TabRoutesConfig): string {
  mkdirSync(dir, { recursive: true });
  const file = tabRoutesPath(dir);
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** Small allowance boxes around calibrated tab points for the input guard. */
export function tabGuardBoxes(config: TabRoutesConfig, halfW = 40, halfH = 24): ClientBox[] {
  const points = [config.source, ...config.routes.map((route) => route.tab)];
  return points
    .filter((point): point is TabPoint & { x: number; y: number } =>
      Number.isFinite(point.x) && Number.isFinite(point.y),
    )
    .map((point) => ({
      x: point.x - halfW,
      y: point.y - halfH,
      w: halfW * 2,
      h: halfH * 2,
    }));
}

export function routeForClass(config: TabRoutesConfig, itemClass: string | undefined): TabRoute | undefined {
  if (!itemClass) return undefined;
  // Routes with no classes are name-pattern-only; an empty wanted list would
  // otherwise match every item.
  return config.routes.find(
    (route) => route.classes.length > 0 && itemMatchesWantedClass(itemClass, route.classes),
  );
}

/** Name-pattern routes win over class routes; first match in config order. */
export function routeForItem(
  config: TabRoutesConfig,
  itemClass: string | undefined,
  name: string | undefined,
): TabRoute | undefined {
  if (name) {
    for (const route of config.routes) {
      for (const source of route.namePatterns ?? []) {
        try {
          if (new RegExp(source, "i").test(name)) return route;
        } catch {
          // Invalid pattern in user config — skip it rather than fail the sort.
        }
      }
    }
  }
  return routeForClass(config, itemClass);
}

export interface RoutedGroups<T> {
  byLabel: Map<string, { route: TabRoute; items: T[] }>;
  unrouted: T[];
}

export function groupItemsByRoute<T extends { itemClass?: string; name?: string }>(
  items: T[],
  config: TabRoutesConfig,
): RoutedGroups<T> {
  const byLabel = new Map<string, { route: TabRoute; items: T[] }>();
  const unrouted: T[] = [];
  for (const item of items) {
    const route = routeForItem(config, item.itemClass, item.name);
    if (!route) {
      unrouted.push(item);
      continue;
    }
    const entry = byLabel.get(route.tab.label) ?? { route, items: [] };
    entry.items.push(item);
    byLabel.set(route.tab.label, entry);
  }
  return { byLabel, unrouted };
}

/**
 * Coarse content signature of the stash grid: mean brightness of an 8x8
 * tiling. Used to verify a tab switch actually changed what is on screen and
 * that switching back restored the source tab.
 */
export function stashContentSignature(
  frame: GrayImage,
  client: ScreenRect,
  region: { x: number; y: number; w: number; h: number },
  tiles = 8,
): number[] {
  const sx = frame.width / client.width;
  const sy = frame.height / client.height;
  const fx = (region.x - client.left) * sx;
  const fy = (region.y - client.top) * sy;
  const fw = region.w * sx;
  const fh = region.h * sy;
  const out: number[] = [];
  for (let ty = 0; ty < tiles; ty += 1) {
    for (let tx = 0; tx < tiles; tx += 1) {
      const stats = regionStats(
        frame,
        fx + (tx * fw) / tiles,
        fy + (ty * fh) / tiles,
        fw / tiles,
        fh / tiles,
      );
      out.push(stats.mean);
    }
  }
  return out;
}

/** Mean absolute tile difference; a real tab change moves this well above noise. */
export function signatureDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Math.abs(a[i]! - b[i]!);
  return sum / length;
}

export const TAB_SWITCH_MIN_DISTANCE = 3;
export const TAB_RETURN_MAX_DISTANCE = 6;
