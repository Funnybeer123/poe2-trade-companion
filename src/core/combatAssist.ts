import type { BotDecision } from "./types.js";

export type CombatModule = "health" | "mana" | "unleash";
export type HudRegionName = CombatModule | "anchor";
export interface HudRegion {
  x: number; y: number; width: number; height: number;
  /** Row-major RGB: globes 5 x 100, skill/anchor 16 x 16. */
  reference: number[];
  cooldown?: number[];
}
export interface CombatConfig {
  health: { enabled: boolean; key: string; threshold: number; retryMs: number };
  mana: { enabled: boolean; key: string; threshold: number; retryMs: number };
  unleash: { enabled: boolean; key: string; retryMs: number };
  pollMs: number;
  dryRun: boolean;
  width: number;
  height: number;
  regions: Partial<Record<HudRegionName, HudRegion>>;
}
export interface CombatFrame {
  capturedAt: number;
  hwnd: string;
  process: string;
  width: number;
  height: number;
  samples: Partial<Record<HudRegionName, number[]>>;
}
export interface CombatReading {
  valid: boolean;
  reason: string;
  health?: number;
  mana?: number;
  unleash?: "ready" | "cooldown" | "unknown";
}
export interface CombatStatus {
  running: boolean;
  reason: string;
  config: CombatConfig;
  reading?: CombatReading;
  cycleMs?: number;
  actions: number;
}
export interface CombatPreview { image: string; width: number; height: number }
export interface CombatBridge {
  setGlobalDryRun(enabled: boolean): Promise<void>;
  status(): Promise<CombatStatus>;
  configure(config: CombatConfig): Promise<CombatStatus>;
  start(): Promise<CombatStatus>;
  stop(): Promise<CombatStatus>;
  preview(): Promise<CombatPreview>;
}
export const HUD_NAMES: HudRegionName[] = ["health", "mana", "unleash", "anchor"];
export const COMBAT_PROCESSES = ["PathOfExile", "PathOfExile_x64", "PathOfExileSteam", "PathOfExile_x64Steam", "PathOfExileEGS", "PathOfExile_x64EGS"];
export const COMBAT_BINDINGS = [
  { value: "MOUSE5", label: "Mouse Button 5" },
  ...Array.from("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", (key) => ({ value: key, label: key })),
];

export function normalizeCombatBinding(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toUpperCase().replace(/^MOUSE BUTTON 5$/, "MOUSE5") : "";
  if (!/^(?:[A-Z0-9]|MOUSE5)$/.test(key)) throw new Error("Choose a letter, digit or Mouse Button 5.");
  return key;
}

export function defaultCombatConfig(): CombatConfig {
  return {
    health: { enabled: false, key: "1", threshold: 25, retryMs: 1500 },
    mana: { enabled: false, key: "MOUSE5", threshold: 25, retryMs: 1500 },
    unleash: { enabled: false, key: "R", retryMs: 350 },
    pollMs: 16, dryRun: false, width: 0, height: 0, regions: {},
  };
}

function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label} (${min}–${max}).`);
  return value;
}
function pixels(value: unknown, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size || value.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error("Invalid HUD reference pixels. Recalibrate.");
  return [...value];
}

/** Validate at the IPC/persistence boundary; never trust renderer configuration. */
export function parseCombatConfig(value: unknown): CombatConfig {
  if (!value || typeof value !== "object") throw new Error("Missing combat settings.");
  const c = value as CombatConfig;
  const result = defaultCombatConfig();
  result.pollMs = bounded(c.pollMs, 16, 250, "sampling interval");
  if (typeof c.dryRun !== "boolean") throw new Error("Invalid preview setting.");
  result.dryRun = c.dryRun;
  result.width = bounded(c.width, 0, 16384, "HUD width");
  result.height = bounded(c.height, 0, 16384, "HUD height");
  for (const name of ["health", "mana", "unleash"] as const) {
    const module = c[name];
    if (!module || typeof module.enabled !== "boolean") throw new Error(`Invalid ${name} toggle.`);
    result[name].enabled = module.enabled;
    result[name].key = normalizeCombatBinding(module.key);
    result[name].retryMs = bounded(module.retryMs, name === "unleash" ? 100 : 250, 30000, `${name} minimum interval`);
    if (name !== "unleash") result[name].threshold = bounded(c[name].threshold, 1, 99, `${name} threshold`);
  }
  const activeKeys = [result.health, result.mana, result.unleash].filter((m) => m.enabled).map((m) => m.key);
  if (new Set(activeKeys).size !== activeKeys.length) throw new Error("Enabled features must use different keys.");
  if (!c.regions || typeof c.regions !== "object") throw new Error("Invalid HUD calibration.");
  for (const name of HUD_NAMES) {
    const r = c.regions[name];
    if (!r) continue;
    const size = name === "health" || name === "mana" ? 1500 : 768;
    const region: HudRegion = {
      x: bounded(r.x, 0, c.width, "region X"), y: bounded(r.y, 0, c.height, "region Y"),
      width: bounded(r.width, 3, 1024, "region width"), height: bounded(r.height, 3, 1024, "region height"),
      reference: pixels(r.reference, size),
    };
    if (region.x + region.width > c.width || region.y + region.height > c.height || [region.x, region.y, region.width, region.height].some((n) => !Number.isInteger(n))) throw new Error("HUD region is outside the captured window.");
    if (name === "health" || name === "mana") {
      if (estimateGlobe(region.reference, region.reference) !== 100) throw new Error(`Select a narrow, fully filled ${name} strip without the globe frame or text.`);
    }
    if (r.cooldown) {
      region.cooldown = pixels(r.cooldown, size);
      if (templateMatch(region.reference, region.cooldown) > 0.8) throw new Error("Ready and cooldown images are too similar. Capture the icon early in its cooldown.");
    }
    result.regions[name] = region;
  }
  return result;
}

export function requireCombatCalibration(config: CombatConfig): void {
  if (!config.health.enabled && !config.mana.enabled && !config.unleash.enabled) throw new Error("Enable a flask or Unleash first.");
  if (!config.regions.anchor) throw new Error("Calibrate a fixed HUD ornament first.");
  for (const name of ["health", "mana", "unleash"] as const) {
    if (config[name].enabled && !config.regions[name]) throw new Error(`Calibrate ${name} first.`);
  }
  if (config.unleash.enabled && !config.regions.unleash?.cooldown) throw new Error("Capture Unleash both ready and on cooldown first.");
}

export function templateMatch(actual: number[], expected: number[]): number {
  if (actual.length !== expected.length || !actual.length) return 0;
  let matching = 0;
  for (let i = 0; i < actual.length; i += 3) {
    if ([0, 1, 2].every((c) => Math.abs(actual[i + c] - expected[i + c]) <= 32)) matching++;
  }
  return matching / (actual.length / 3);
}

/** Locate a contiguous liquid surface, ignoring small reflections/ripples. */
export function estimateGlobe(actual: number[], full: number[]): number | undefined {
  if (actual.length !== 1500 || full.length !== 1500) return undefined;
  const rows: boolean[] = [];
  let unexpectedColour = 0;
  for (let y = 0; y < 100; y++) {
    let filled = 0;
    for (let x = 0; x < 5; x++) {
      const i = (y * 5 + x) * 3;
      const a = actual.slice(i, i + 3), b = full.slice(i, i + 3);
      const peak = Math.max(...a), low = Math.min(...a);
      const dot = a.reduce((n, v, c) => n + v * b[c], 0);
      const norm = Math.hypot(...a) * Math.hypot(...b);
      if (peak > 45 && peak - low >= peak * 0.4 && norm > 0 && dot / norm < 0.8) unexpectedColour++;
      if (peak >= Math.max(28, Math.max(...b) * 0.25) && peak - low >= peak * 0.25 && norm > 0 && dot / norm >= 0.94) filled++;
    }
    rows.push(filled >= 3);
  }
  let errors = rows.filter(Boolean).length;
  let bestErrors = errors, surface = 100;
  for (let y = 99; y >= 0; y--) {
    errors += rows[y] ? -1 : 1;
    if (errors < bestErrors) { bestErrors = errors; surface = y; }
  }
  return bestErrors <= 8 && unexpectedColour <= 40 ? 100 - surface : undefined;
}

export function readCombatFrame(config: CombatConfig, frame: CombatFrame, now: number): CombatReading {
  const invalid = (reason: string): CombatReading => ({ valid: false, reason });
  if (now - frame.capturedAt > 120 || now < frame.capturedAt) return invalid("Stale capture");
  if (frame.width !== config.width || frame.height !== config.height) return invalid("Window size changed — recalibrate HUD");
  if (!COMBAT_PROCESSES.some((p) => p.toLowerCase() === frame.process.replace(/\.exe$/i, "").toLowerCase())) return invalid("Game is not foreground");
  const anchor = config.regions.anchor;
  if (!anchor || templateMatch(frame.samples.anchor ?? [], anchor.reference) < 0.94) return invalid("HUD hidden or covered");
  const reading: CombatReading = { valid: true, reason: "Watching HUD" };
  for (const name of ["health", "mana"] as const) {
    const region = config.regions[name];
    if (region) reading[name] = estimateGlobe(frame.samples[name] ?? [], region.reference);
    if (config[name].enabled && reading[name] === undefined) return invalid(`${name} globe unreadable`);
  }
  if (reading.health === 0) return invalid("Health empty or character unavailable");
  const skill = config.regions.unleash;
  if (skill?.cooldown) {
    const actual = frame.samples.unleash ?? [];
    const ready = templateMatch(actual, skill.reference), cooling = templateMatch(actual, skill.cooldown);
    reading.unleash = ready >= 0.94 && ready > cooling + 0.1 ? "ready" : cooling >= 0.85 && cooling > ready + 0.1 ? "cooldown" : "unknown";
  }
  return reading;
}

export class CombatPlanner {
  private last: Partial<Record<CombatModule, number>> = {};
  private skillArmed = true;
  private coolingFrames = 0;
  private low: Record<"health" | "mana", boolean> = { health: false, mana: false };
  decisions(config: CombatConfig, reading: CombatReading, now: number): Array<{ name: CombatModule; decision: BotDecision }> {
    if (!reading.valid) { this.coolingFrames = 0; return []; }
    const actions: Array<{ name: CombatModule; decision: BotDecision }> = [];
    const add = (name: CombatModule, reason: string) => actions.push({ name, decision: {
      module: "combat", rule: `combat-${name}`, reason, confidence: 1,
      intended: [{ kind: "key", key: config[name].key }],
    } });
    for (const name of ["health", "mana"] as const) {
      const value = reading[name], options = config[name];
      if (!options.enabled || value === undefined) continue;
      if (value >= options.threshold + 3) this.low[name] = false;
      if (value < options.threshold) this.low[name] = true;
      if (this.low[name] && value < options.threshold && now - (this.last[name] ?? -Infinity) >= options.retryMs) add(name, `${name} ${value}% below ${options.threshold}%`);
    }
    // Require actual cooldown evidence before rearming: unknown/covered icons
    // must never create a new ready edge. Two frames reject transient flashes.
    this.coolingFrames = reading.unleash === "cooldown" ? this.coolingFrames + 1 : 0;
    if (this.coolingFrames >= 2) this.skillArmed = true;
    if (config.unleash.enabled && this.skillArmed && reading.unleash === "ready" && now - (this.last.unleash ?? -Infinity) >= config.unleash.retryMs) add("unleash", "Unleash icon ready after observed cooldown");
    return actions;
  }
  committed(name: CombatModule, now: number): void {
    this.last[name] = now;
    if (name === "unleash") { this.skillArmed = false; this.coolingFrames = 0; }
  }
}
