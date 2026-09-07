/**
 * Auto-flask guard: the pure config, classifier and decision rules shared by
 * the renderer (Tools → Hotkeys panel), the main process (calibration IPC),
 * and the standalone daemon. No fs here — persistence is
 * src/core/flaskGuardConfig.ts; the fast sampling loop itself runs inside
 * scripts/win-input-host.ps1 (op `flaskguard`) and MUST mirror
 * decideFlaskFire() below.
 *
 * Perception model (measured on the user's 4K client, 2026-09-07): a globe's
 * fluid is saturated and bright at any height it reaches (life red
 * ~(144,33,41), teal ~(125,206,206) when energy shield covers it, mana blue
 * ~(29,102,155)); the empty glass behind it is dark and grey (~(32,32,37)).
 * So "filled" = chroma AND brightness above a fraction of what the user's
 * own calibration click measured — hue-agnostic on purpose, because the
 * life globe changes hue with energy shield.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type FlaskGlobe = "life" | "mana";
export const FLASK_GLOBES: readonly FlaskGlobe[] = ["life", "mana"];

export interface FlaskProbeConfig {
  enabled: boolean;
  /** The in-game flask key: a single digit 1-9 or letter a-z. */
  key: string;
  /** Minimum gap between two presses while the globe stays low. */
  cooldownMs: number;
  /** Absolute screen point (physical pixels) the user clicked as the trigger height. */
  point: { x: number; y: number } | null;
  /** Side of the averaged square patch around the point. */
  patchSize: number;
  /** Average colour at the point when it was calibrated (globe filled there). */
  reference: Rgb | null;
  calibratedAt: string | null;
}

export interface FlaskGuardConfig {
  enabled: boolean;
  /** Extra sleep per tick; the screen readback itself already costs ~17-30ms. */
  intervalMs: number;
  /** "filled" needs chroma >= chromaRatio * chroma(reference) ... */
  chromaRatio: number;
  /** ... and brightness >= brightRatio * brightness(reference). */
  brightRatio: number;
  /** After this long without a "filled" read the probe is considered stale (dead / menu / loading). */
  staleAfterMs: number;
  /** Press cadence while stale — slow, so a death screen doesn't burn charges. */
  staleCooldownMs: number;
  life: FlaskProbeConfig;
  mana: FlaskProbeConfig;
}

export const FLASK_KEY_PATTERN = /^[1-9a-z]$/;

/** Floors so a dim calibration click can't produce thresholds that read noise as "filled". */
export const MIN_CHROMA_FLOOR = 18;
export const MIN_BRIGHT_FLOOR = 40;

/** What a calibration click must at least look like to be accepted as "on the fluid". */
export const CALIBRATION_MIN_CHROMA = 25;
export const CALIBRATION_MIN_BRIGHT = 50;

export function defaultFlaskProbe(globe: FlaskGlobe): FlaskProbeConfig {
  return {
    enabled: true,
    key: globe === "life" ? "1" : "2",
    cooldownMs: globe === "life" ? 3000 : 4000,
    point: null,
    patchSize: 15,
    reference: null,
    calibratedAt: null,
  };
}

export function defaultFlaskGuardConfig(): FlaskGuardConfig {
  return {
    enabled: false,
    intervalMs: 1,
    chromaRatio: 0.4,
    brightRatio: 0.4,
    staleAfterMs: 12_000,
    staleCooldownMs: 10_000,
    life: defaultFlaskProbe("life"),
    mana: defaultFlaskProbe("mana"),
  };
}

export interface FlaskGuardValidation {
  config: FlaskGuardConfig;
  issues: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(max, Math.max(min, num));
}

function asRgb(value: unknown): Rgb | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const r = finiteInRange(rec.r, 0, 255);
  const g = finiteInRange(rec.g, 0, 255);
  const b = finiteInRange(rec.b, 0, 255);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

function normalizeProbe(
  globe: FlaskGlobe,
  raw: unknown,
  issues: string[],
): FlaskProbeConfig {
  const probe = defaultFlaskProbe(globe);
  const source = asRecord(raw);
  if (raw !== undefined && !source) {
    issues.push(`${globe}: probe config must be an object — defaults kept`);
    return probe;
  }
  if (!source) return probe;
  if (typeof source.enabled === "boolean") probe.enabled = source.enabled;
  if (source.key !== undefined) {
    const key = String(source.key).trim().toLowerCase();
    if (FLASK_KEY_PATTERN.test(key)) probe.key = key;
    else issues.push(`${globe}: key must be a single digit 1-9 or letter a-z — kept "${probe.key}"`);
  }
  if (source.cooldownMs !== undefined) {
    const cooldown = finiteInRange(source.cooldownMs, 250, 60_000);
    if (cooldown === undefined) issues.push(`${globe}: cooldownMs must be a number — kept ${probe.cooldownMs}`);
    else probe.cooldownMs = Math.round(cooldown);
  }
  if (source.patchSize !== undefined) {
    const size = finiteInRange(source.patchSize, 3, 61);
    if (size === undefined) issues.push(`${globe}: patchSize must be a number — kept ${probe.patchSize}`);
    else probe.patchSize = Math.round(size) | 1;
  }
  if (source.point !== undefined && source.point !== null) {
    const point = asRecord(source.point);
    const x = point ? finiteInRange(point.x, -32_768, 32_767) : undefined;
    const y = point ? finiteInRange(point.y, -32_768, 32_767) : undefined;
    if (x === undefined || y === undefined) issues.push(`${globe}: point must be {x, y} — cleared`);
    else probe.point = { x: Math.round(x), y: Math.round(y) };
  }
  if (source.reference !== undefined && source.reference !== null) {
    const rgb = asRgb(source.reference);
    if (!rgb) issues.push(`${globe}: reference must be {r, g, b} — cleared`);
    else probe.reference = rgb;
  }
  if (typeof source.calibratedAt === "string" && source.calibratedAt) {
    probe.calibratedAt = source.calibratedAt;
  }
  if ((probe.point === null) !== (probe.reference === null)) {
    issues.push(`${globe}: point and reference must be calibrated together — calibration cleared`);
    probe.point = null;
    probe.reference = null;
    probe.calibratedAt = null;
  }
  return probe;
}

/** Normalize an untrusted config object; bad fields fall back to defaults and are reported. */
export function normalizeFlaskGuardConfig(raw: unknown): FlaskGuardValidation {
  const issues: string[] = [];
  const config = defaultFlaskGuardConfig();
  const source = asRecord(raw);
  if (raw !== undefined && !source) {
    issues.push("flask guard config must be an object — defaults used");
    return { config, issues };
  }
  if (!source) return { config, issues };
  if (typeof source.enabled === "boolean") config.enabled = source.enabled;
  const numeric: Array<[keyof FlaskGuardConfig, number, number, boolean]> = [
    ["intervalMs", 0, 500, true],
    ["chromaRatio", 0.1, 0.95, false],
    ["brightRatio", 0.1, 0.95, false],
    ["staleAfterMs", 1_000, 600_000, true],
    ["staleCooldownMs", 1_000, 600_000, true],
  ];
  for (const [field, min, max, integer] of numeric) {
    if (source[field] === undefined) continue;
    const value = finiteInRange(source[field], min, max);
    if (value === undefined) {
      issues.push(`${field} must be a number between ${min} and ${max} — kept ${String(config[field])}`);
      continue;
    }
    (config as unknown as Record<string, number>)[field] = integer ? Math.round(value) : value;
  }
  config.life = normalizeProbe("life", source.life, issues);
  config.mana = normalizeProbe("mana", source.mana, issues);
  return { config, issues };
}

export function chromaOf(rgb: Rgb): number {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
}

export function brightnessOf(rgb: Rgb): number {
  return Math.max(rgb.r, rgb.g, rgb.b);
}

export interface ProbeThresholds {
  minChroma: number;
  minBright: number;
}

/** Absolute thresholds the host compares against, derived from the calibration reference. */
export function probeThresholds(config: FlaskGuardConfig, reference: Rgb): ProbeThresholds {
  return {
    minChroma: Math.max(MIN_CHROMA_FLOOR, Math.round(chromaOf(reference) * config.chromaRatio)),
    minBright: Math.max(MIN_BRIGHT_FLOOR, Math.round(brightnessOf(reference) * config.brightRatio)),
  };
}

export type PatchState = "filled" | "low";

export function classifyPatch(rgb: Rgb, thresholds: ProbeThresholds): PatchState {
  return chromaOf(rgb) >= thresholds.minChroma && brightnessOf(rgb) >= thresholds.minBright
    ? "filled"
    : "low";
}

/** Does a freshly sampled calibration point look like fluid rather than empty glass or chrome? */
export function looksLikeFilledGlobe(rgb: Rgb): boolean {
  return chromaOf(rgb) >= CALIBRATION_MIN_CHROMA && brightnessOf(rgb) >= CALIBRATION_MIN_BRIGHT;
}

/** Windows virtual-key code for a flask key ("1"-"9", "a"-"z"). */
export function vkForFlaskKey(key: string): number | undefined {
  const normalized = key.trim().toLowerCase();
  if (!FLASK_KEY_PATTERN.test(normalized)) return undefined;
  return normalized.toUpperCase().charCodeAt(0);
}

export interface ProbeReadiness {
  ready: boolean;
  reason?: string;
}

export function probeReadiness(probe: FlaskProbeConfig): ProbeReadiness {
  if (!probe.enabled) return { ready: false, reason: "disabled" };
  if (!probe.point || !probe.reference) return { ready: false, reason: "not calibrated" };
  if (vkForFlaskKey(probe.key) === undefined) return { ready: false, reason: "invalid key" };
  return { ready: true };
}

/** Per-probe continuity carried between host cycles so they behave as one loop. */
export interface ProbeContinuity {
  armed: boolean;
  /** -1 = never fired. */
  lastFireMsAgo: number;
  lastFilledMsAgo: number;
}

export function freshContinuity(): ProbeContinuity {
  return { armed: false, lastFireMsAgo: -1, lastFilledMsAgo: 0 };
}

export interface FireDecisionInput {
  state: PatchState;
  armed: boolean;
  /** ms since the last press; Infinity when never. */
  sinceFireMs: number;
  /** ms since the probe last read "filled". */
  sinceFilledMs: number;
  cooldownMs: number;
  staleAfterMs: number;
  staleCooldownMs: number;
}

export interface FireDecision {
  fire: boolean;
  armed: boolean;
  stale: boolean;
}

/**
 * TS mirror of the host loop's decision (scripts/win-input-host.ps1,
 * op `flaskguard`). Keep both in sync: a "filled" read arms the probe and
 * never fires; an unarmed probe never fires (login/loading screens before
 * the HUD was ever seen); otherwise fire once the cooldown has elapsed, the
 * cooldown stretching to staleCooldownMs once no "filled" read has been seen
 * for staleAfterMs (death screen, passive tree, menus).
 */
export function decideFlaskFire(input: FireDecisionInput): FireDecision {
  if (input.state === "filled") return { fire: false, armed: true, stale: false };
  if (!input.armed) return { fire: false, armed: false, stale: false };
  const stale = input.sinceFilledMs >= input.staleAfterMs;
  const cooldown = stale ? input.staleCooldownMs : input.cooldownMs;
  return { fire: input.sinceFireMs >= cooldown, armed: true, stale };
}

/** The probe rows the host `flaskguard` op consumes, for every ready globe. */
export interface HostProbePayload extends ProbeThresholds, ProbeContinuity {
  id: FlaskGlobe;
  x: number;
  y: number;
  size: number;
  vk: number;
  cooldownMs: number;
  staleAfterMs: number;
  staleCooldownMs: number;
}

export function buildHostProbes(
  config: FlaskGuardConfig,
  continuity: Partial<Record<FlaskGlobe, ProbeContinuity>> = {},
): HostProbePayload[] {
  const probes: HostProbePayload[] = [];
  for (const globe of FLASK_GLOBES) {
    const probe = config[globe];
    if (!probeReadiness(probe).ready || !probe.point || !probe.reference) continue;
    const vk = vkForFlaskKey(probe.key);
    if (vk === undefined) continue;
    probes.push({
      id: globe,
      x: probe.point.x,
      y: probe.point.y,
      size: probe.patchSize,
      vk,
      cooldownMs: probe.cooldownMs,
      staleAfterMs: config.staleAfterMs,
      staleCooldownMs: config.staleCooldownMs,
      ...probeThresholds(config, probe.reference),
      ...(continuity[globe] ?? freshContinuity()),
    });
  }
  return probes;
}

export function describeRgb(rgb: Rgb): string {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}
