import { COMBAT_BINDINGS, estimateGlobe, normalizeCombatBinding } from "./combatAssist.js";
import type { BotDecision } from "./types.js";

/**
 * Keeping the follower alive: drink the life flask when the life globe runs low.
 *
 * The follower PC has no combat-assist calibration and cannot run the packaged app to make one, so this
 * does not use that feature's saved HUD regions. It reuses its two proven parts instead — the combat
 * worker's 5 x 100 colour column over a globe, and `estimateGlobe`, which finds the liquid surface in that
 * column against a full-globe reference — with a region derived from the view and a reference taken from
 * the terminal (`--flask-calibrate`, at full life).
 *
 * Pure functions and one small planner; nothing here captures or emits.
 */

/**
 * A column down the middle of the life globe, as fractions of view HEIGHT (the HUD scales with height).
 * Measured on a 2560 x 1440 frame: the liquid spans x 70..280, y 1185..1405 around a centre near (175, 1295).
 * The column sits right of centre, clear of the glossy highlight on the globe's left shoulder.
 */
export function lifeGlobeColumn(view: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const h = view.height;
  return { x: Math.round(h * .1215), y: Math.round(h * .8264), width: Math.max(5, Math.round(h * .0139)), height: Math.max(100, Math.round(h * .1458)) };
}

export interface FlaskCalibration { version: 1; view: { width: number; height: number }; region: ReturnType<typeof lifeGlobeColumn>; reference: number[]; calibratedAt: string }

/**
 * A reference is only worth keeping if it shows a FULL globe: every later reading is measured against it, so
 * one taken at half life would read half life as full and never drink. Life is red: most rows must be
 * clearly red-dominant, top to bottom.
 */
export function flaskReferenceIssue(reference: number[]): string | undefined {
  if (reference.length !== 1500) return "The life globe sample has the wrong size.";
  let redRows = 0, topRed = 0;
  for (let y = 0; y < 100; y++) {
    let red = 0;
    for (let x = 0; x < 5; x++) { const i = (y * 5 + x) * 3, r = reference[i], g = reference[i + 1], b = reference[i + 2]; if (r >= 60 && r >= g * 1.8 && r >= b * 1.8) red++; }
    if (red >= 3) { redRows++; if (y < 15) topRed++; }
  }
  if (redRows < 85) return `The life globe does not look full (${redRows} of 100 rows are red). Calibrate at full life, with nothing covering the globe.`;
  if (topRed < 8) return "The top of the life globe is not red: life is not full, or the column is off the globe.";
  return undefined;
}

export function parseFlaskCalibration(raw: unknown): FlaskCalibration {
  const c = raw as FlaskCalibration | null, n = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  if (!c || c.version !== 1 || !c.view || !n(c.view.width) || !n(c.view.height) || !c.region || ![c.region.x, c.region.y, c.region.width, c.region.height].every(n)
    || !Array.isArray(c.reference) || c.reference.some(v => !Number.isInteger(v) || v < 0 || v > 255) || typeof c.calibratedAt !== "string") throw new Error("Invalid flask calibration.");
  const issue = flaskReferenceIssue(c.reference);
  if (issue) throw new Error(issue);
  return c;
}

export interface FlaskSettings { key: string; below: number; retryMs: number }
export function parseFlaskSettings(raw: { key?: unknown; below?: unknown; retryMs?: unknown }): FlaskSettings {
  const key = normalizeCombatBinding(raw.key), below = Number(raw.below ?? 55), retryMs = Number(raw.retryMs ?? 1500);
  if (!COMBAT_BINDINGS.some(b => b.value === key)) throw new Error("The flask key must be one of the allowed bindings (0-9, A-Z, MOUSE5).");
  if (!Number.isFinite(below) || below < 10 || below > 90) throw new Error("The flask threshold must be between 10 and 90 percent.");
  if (!Number.isFinite(retryMs) || retryMs < 500 || retryMs > 10_000) throw new Error("The flask retry must be between 500 and 10000 ms.");
  return { key, below, retryMs };
}

/** Life as a percentage, or undefined when the column cannot be read (a panel over it, an effect, a death screen). */
export function readLife(sample: number[], calibration: FlaskCalibration): number | undefined {
  const life = estimateGlobe(sample, calibration.reference);
  // No liquid at all is not "0 % life", it is no globe: a loading or teleport screen blacks the column out and
  // estimateGlobe reports an empty globe with perfect confidence. Live, life read 97 % -> 0 % -> 97 % inside three
  // seconds, three times in the first minute, and each one spent a flask charge. A character truly that low is
  // beyond a flask anyway, so nothing is lost by refusing to believe it.
  return life !== undefined && life < MIN_CREDIBLE_LIFE ? undefined : life;
}
const MIN_CREDIBLE_LIFE = 3;

/**
 * When to drink. Two low readings in a row, so one odd frame never spends a charge; then at most one press per
 * `retryMs`, because a flask takes a moment to show in the globe and pressing again at once wastes the next one.
 * An unreadable globe is never evidence of low life: it resets the streak and nothing is pressed.
 */
export class FlaskPlanner {
  private lowReadings = 0;
  private lastPressAt = -Infinity;
  constructor(private readonly settings: FlaskSettings) {}
  decide(life: number | undefined, now: number): BotDecision | undefined {
    if (life === undefined || life >= this.settings.below) { this.lowReadings = 0; return undefined; }
    if (++this.lowReadings < 2 || now - this.lastPressAt < this.settings.retryMs) return undefined;
    return { module: "combat", rule: "follower-life-flask", reason: `Life ${life}% is below ${this.settings.below}%: drink the life flask.`, confidence: 1, intended: [{ kind: "key", key: this.settings.key }] };
  }
  /** Only when the press reached the game (or a dry run showed it): a refusal is not an action. */
  committed(now: number): void { this.lastPressAt = now; }
}
