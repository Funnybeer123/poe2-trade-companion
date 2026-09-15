/**
 * Auto-flask guard + auto-cast: the pure config, classifier and decision
 * rules shared by the renderer (Tools → Hotkeys panel), the main process
 * (calibration IPC), and the standalone daemon. No fs here — persistence is
 * src/core/flaskGuardConfig.ts; the fast sampling loop itself runs inside
 * scripts/win-input-host.ps1 (op `flaskguard`) and MUST mirror
 * decideFlaskFire() below.
 *
 * Two probe kinds share one loop:
 *
 * Globes (life / mana flasks) — perception model measured on the user's 4K
 * client, 2026-09-07: a globe's fluid is saturated and bright at any height
 * it reaches (life red ~(144,33,41), teal ~(125,206,206) when energy shield
 * covers it, mana blue ~(29,102,155)); the empty glass behind it is dark
 * and grey (~(32,32,37)). So "filled" = chroma AND brightness above a
 * fraction of what the user's own calibration click measured — hue-agnostic
 * on purpose, because the life globe changes hue with energy shield. The
 * flask key is pressed on "low". Anything that is neither fluid nor dark
 * glass — near-black (loading fade, ~(3,3,2)) or bright and desaturated
 * (loading art, dialogs, ~(197,172,179)) — is "unknown" and never pressed
 * on (2026-09-08: 5 of the first 13 live presses were wasted on those).
 *
 * Skills (auto-cast, 2026-09-14) — a skill-bar icon is calibrated while the
 * skill is READY; the game's cooldown sweep darkens the icon, and an
 * unusable skill (its effect still active, no mana) shows it uniformly
 * dimmed to ~50% (measured (88,107,115) against a lit (153,209,231)) — both
 * fall well outside the tolerance. So "filled" (= ready) means the patch
 * colour is within skillMatchTolerance of the calibrated colour on every
 * channel, and the skill key is pressed on "filled" — i.e. whenever the
 * skill is off cooldown. Firing is edge-triggered: a press disarms the
 * probe and a "low" read (the icon going dark after the cast) re-arms it,
 * so a press the game did not take (chat box focused, out of range) is
 * retried only after the per-skill retry gap instead of every tick. Measured
 * live: the sweep is a clockwise pie that starts and ends at 12 o'clock, so
 * the probe must sit at the icon's TOP EDGE — the last spot to relight; the
 * centre reads ready ~1.4 s early on a 5 s cooldown.
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
  /** The in-game flask binding: a digit 1-9, a letter a-z, or m3/m4/m5 for mouse buttons. */
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

/** An auto-cast skill: same shape as a globe probe plus an id and a label. */
export interface SkillProbeConfig extends FlaskProbeConfig {
  /** Stable id (lowercase letters, digits, dashes); the host probe id is `skill:<id>`. */
  id: string;
  /** Shown in the panel and the daemon log, e.g. "Powered by Verisium". */
  label: string;
}

export interface FlaskGuardConfig {
  enabled: boolean;
  /** Extra sleep per tick; the screen readback itself already costs ~17-30ms. */
  intervalMs: number;
  /** "filled" needs chroma >= chromaRatio * chroma(reference) ... */
  chromaRatio: number;
  /** ... and brightness >= brightRatio * brightness(reference). */
  brightRatio: number;
  /** Brightness below this is a blackout (loading fade), not empty glass — never press. */
  blackoutBelow: number;
  /** Brightness above this with no chroma is an overlay (loading art, dialog) — never press. */
  overlayAbove: number;
  /** After this long without a "filled" read the probe is considered stale (dead / menu / loading). */
  staleAfterMs: number;
  /** Press cadence while stale — slow, so a death screen doesn't burn charges. */
  staleCooldownMs: number;
  /** A skill icon reads "ready" while every channel is within this of the calibrated colour. */
  skillMatchTolerance: number;
  life: FlaskProbeConfig;
  mana: FlaskProbeConfig;
  /** Auto-cast skills: pressed whenever their icon reads ready (off cooldown). */
  skills: SkillProbeConfig[];
}

/** Keyboard: one digit 1-9 or letter a-z. Mouse: m3 (middle), m4, m5 (side buttons). */
export const FLASK_KEY_PATTERN = /^([1-9a-z]|m[345])$/;
/** A skill row may carry no key yet (just added in the panel): it is kept, and never runs. */
export const UNBOUND_KEY = "";
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SKILL_PROBE_PREFIX = "skill:";
export const MAX_SKILLS = 8;

/** Floors so a dim calibration click can't produce thresholds that read noise as "filled". */
export const MIN_CHROMA_FLOOR = 18;
export const MIN_BRIGHT_FLOOR = 40;

/** What a calibration click must at least look like to be accepted as "on the fluid". */
export const CALIBRATION_MIN_CHROMA = 25;
export const CALIBRATION_MIN_BRIGHT = 50;
/** A ready skill icon is lit; the cooldown sweep is what makes it dark. */
export const SKILL_CALIBRATION_MIN_BRIGHT = 60;

export function defaultFlaskProbe(globe: FlaskGlobe): FlaskProbeConfig {
  return {
    enabled: true,
    key: globe === "life" ? "1" : "2",
    cooldownMs: globe === "life" ? 2000 : 4000,
    point: null,
    patchSize: 15,
    reference: null,
    calibratedAt: null,
  };
}

export function defaultSkillProbe(id: string, label: string, key: string): SkillProbeConfig {
  return {
    id,
    label,
    enabled: true,
    key,
    // Retry gap: how long a press that did NOT take (the icon stayed lit —
    // chat box had focus, wrong key, out of range) waits before the next
    // try. Not the skill's cooldown: the icon going dark after a real cast
    // re-arms the probe, so a taken press is followed by the next one the
    // moment the icon relights.
    cooldownMs: 3000,
    point: null,
    patchSize: 11,
    reference: null,
    calibratedAt: null,
  };
}

/** The skills a fresh config ships with — the user's T-key skill, next to Unleash. */
export function defaultSkills(): SkillProbeConfig[] {
  return [defaultSkillProbe("verisium", "Powered by Verisium", "t")];
}

export function defaultFlaskGuardConfig(): FlaskGuardConfig {
  return {
    enabled: false,
    intervalMs: 1,
    chromaRatio: 0.4,
    brightRatio: 0.4,
    blackoutBelow: 12,
    overlayAbove: 150,
    staleAfterMs: 12_000,
    staleCooldownMs: 10_000,
    skillMatchTolerance: 40,
    life: defaultFlaskProbe("life"),
    mana: defaultFlaskProbe("mana"),
    skills: defaultSkills(),
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

/** Fills `probe` from an untrusted record; shared by globes and skills. */
function applyProbeFields(
  name: string,
  probe: FlaskProbeConfig,
  source: Record<string, unknown>,
  issues: string[],
): void {
  if (typeof source.enabled === "boolean") probe.enabled = source.enabled;
  if (source.key !== undefined) {
    const key = String(source.key).trim().toLowerCase();
    if (FLASK_KEY_PATTERN.test(key)) probe.key = key;
    else issues.push(`${name}: key must be a digit 1-9, a letter a-z, or m3/m4/m5 — kept "${probe.key}"`);
  }
  if (source.cooldownMs !== undefined) {
    const cooldown = finiteInRange(source.cooldownMs, 250, 60_000);
    if (cooldown === undefined) issues.push(`${name}: cooldownMs must be a number — kept ${probe.cooldownMs}`);
    else probe.cooldownMs = Math.round(cooldown);
  }
  if (source.patchSize !== undefined) {
    const size = finiteInRange(source.patchSize, 3, 61);
    if (size === undefined) issues.push(`${name}: patchSize must be a number — kept ${probe.patchSize}`);
    else probe.patchSize = Math.round(size) | 1;
  }
  if (source.point !== undefined && source.point !== null) {
    const point = asRecord(source.point);
    const x = point ? finiteInRange(point.x, -32_768, 32_767) : undefined;
    const y = point ? finiteInRange(point.y, -32_768, 32_767) : undefined;
    if (x === undefined || y === undefined) issues.push(`${name}: point must be {x, y} — cleared`);
    else probe.point = { x: Math.round(x), y: Math.round(y) };
  }
  if (source.reference !== undefined && source.reference !== null) {
    const rgb = asRgb(source.reference);
    if (!rgb) issues.push(`${name}: reference must be {r, g, b} — cleared`);
    else probe.reference = rgb;
  }
  if (typeof source.calibratedAt === "string" && source.calibratedAt) {
    probe.calibratedAt = source.calibratedAt;
  }
  if ((probe.point === null) !== (probe.reference === null)) {
    issues.push(`${name}: point and reference must be calibrated together — calibration cleared`);
    probe.point = null;
    probe.reference = null;
    probe.calibratedAt = null;
  }
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
  applyProbeFields(globe, probe, source, issues);
  return probe;
}

/** Turns a label into a usable id: "Powered by Verisium" → "powered-by-verisium". */
export function skillIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return SKILL_ID_PATTERN.test(slug) ? slug : "skill";
}

/**
 * `base`, or `base-2`, `base-3`, … — the first not in `taken`. The suffix
 * always fits inside the 32-char id limit (a base already at the limit is
 * shortened to make room), so this terminates and stays pattern-valid.
 */
export function uniqueSkillId(base: string, taken: ReadonlySet<string>): string {
  const id = SKILL_ID_PATTERN.test(base) ? base : "skill";
  let unique = id;
  for (let n = 2; taken.has(unique); n += 1) {
    const suffix = `-${n}`;
    unique = `${id.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  return unique;
}

function normalizeSkills(raw: unknown, issues: string[]): SkillProbeConfig[] {
  if (raw === undefined) return defaultSkills();
  if (!Array.isArray(raw)) {
    issues.push("skills must be a list — defaults kept");
    return defaultSkills();
  }
  const skills: SkillProbeConfig[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (skills.length >= MAX_SKILLS) {
      issues.push(`skills: at most ${MAX_SKILLS} auto-cast skills — the rest were dropped`);
      break;
    }
    const source = asRecord(entry);
    if (!source) {
      issues.push(`skills[${index}]: must be an object — dropped`);
      continue;
    }
    const label = typeof source.label === "string" && source.label.trim() ? source.label.trim().slice(0, 48) : `Skill ${index + 1}`;
    let id = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
    if (!SKILL_ID_PATTERN.test(id)) id = skillIdFromLabel(label);
    const unique = uniqueSkillId(id, seen);
    seen.add(unique);
    const skill = defaultSkillProbe(unique, label, "t");
    if (source.key !== undefined) {
      // A skill row never inherits another skill's key: a blank key (row just
      // added) stays blank silently, and an invalid one is left unbound and
      // reported — either way the row never runs until it has a real key.
      const key = String(source.key).trim().toLowerCase();
      if (key === UNBOUND_KEY || FLASK_KEY_PATTERN.test(key)) skill.key = key;
      else {
        skill.key = UNBOUND_KEY;
        issues.push(`${label}: key must be a digit 1-9, a letter a-z, or m3/m4/m5 — left unbound`);
      }
    }
    applyProbeFields(label, skill, { ...source, key: undefined }, issues);
    skills.push(skill);
  }
  return skills;
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
    ["blackoutBelow", 0, 60, true],
    ["overlayAbove", 80, 255, true],
    ["staleAfterMs", 1_000, 600_000, true],
    ["staleCooldownMs", 1_000, 600_000, true],
    ["skillMatchTolerance", 5, 120, true],
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
  config.skills = normalizeSkills(source.skills, issues);
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
  blackoutBelow: number;
  overlayAbove: number;
  /**
   * Skill icons only: "filled" = every channel within `match` of `ref`
   * (0 = globe rule: chroma / brightness fractions).
   */
  match: number;
  ref: Rgb | null;
}

/** Absolute thresholds the host compares against, derived from the calibration reference. */
export function probeThresholds(config: FlaskGuardConfig, reference: Rgb): ProbeThresholds {
  return {
    minChroma: Math.max(MIN_CHROMA_FLOOR, Math.round(chromaOf(reference) * config.chromaRatio)),
    minBright: Math.max(MIN_BRIGHT_FLOOR, Math.round(brightnessOf(reference) * config.brightRatio)),
    blackoutBelow: config.blackoutBelow,
    overlayAbove: config.overlayAbove,
    match: 0,
    ref: null,
  };
}

/** Thresholds for a skill icon: colour match against the ready-state reference. */
export function skillThresholds(config: FlaskGuardConfig, reference: Rgb): ProbeThresholds {
  return {
    minChroma: 0,
    minBright: 0,
    blackoutBelow: config.blackoutBelow,
    overlayAbove: 255,
    match: config.skillMatchTolerance,
    ref: reference,
  };
}

/**
 * filled = fluid (globe) / ready icon (skill); low = dark glass or cooling
 * icon; unknown = not the HUD element at all (never press).
 */
export type PatchState = "filled" | "low" | "unknown";

export function classifyPatch(rgb: Rgb, thresholds: ProbeThresholds): PatchState {
  const chroma = chromaOf(rgb);
  const bright = brightnessOf(rgb);
  if (thresholds.match > 0 && thresholds.ref) {
    const ref = thresholds.ref;
    const matched =
      Math.abs(rgb.r - ref.r) <= thresholds.match &&
      Math.abs(rgb.g - ref.g) <= thresholds.match &&
      Math.abs(rgb.b - ref.b) <= thresholds.match;
    if (matched) return "filled";
    return bright < thresholds.blackoutBelow ? "unknown" : "low";
  }
  if (chroma >= thresholds.minChroma && bright >= thresholds.minBright) return "filled";
  if (bright < thresholds.blackoutBelow) return "unknown";
  if (bright > thresholds.overlayAbove && chroma < thresholds.minChroma) return "unknown";
  return "low";
}

/** Does a freshly sampled calibration point look like fluid rather than empty glass or chrome? */
export function looksLikeFilledGlobe(rgb: Rgb): boolean {
  return chromaOf(rgb) >= CALIBRATION_MIN_CHROMA && brightnessOf(rgb) >= CALIBRATION_MIN_BRIGHT;
}

/** Does a calibration click look like a lit (ready) skill icon rather than the cooldown shade? */
export function looksLikeReadySkill(rgb: Rgb): boolean {
  return brightnessOf(rgb) >= SKILL_CALIBRATION_MIN_BRIGHT;
}

export interface FlaskKeyInput {
  /** Windows virtual-key code, 0 for a mouse button. */
  vk: number;
  /** 0 for a keyboard key; 3 = middle, 4 = XButton1 (M4), 5 = XButton2 (M5). */
  mouse: number;
}

/** How the host presses a flask binding ("1"-"9", "a"-"z", "m3"/"m4"/"m5"). */
export function flaskKeyInput(key: string): FlaskKeyInput | undefined {
  const normalized = key.trim().toLowerCase();
  if (!FLASK_KEY_PATTERN.test(normalized)) return undefined;
  if (normalized.length === 2) return { vk: 0, mouse: Number(normalized[1]) };
  return { vk: normalized.toUpperCase().charCodeAt(0), mouse: 0 };
}

/** Windows virtual-key code for a keyboard flask key; undefined for mouse buttons and bad keys. */
export function vkForFlaskKey(key: string): number | undefined {
  const input = flaskKeyInput(key);
  return input && input.mouse === 0 ? input.vk : undefined;
}

export function describeFlaskKey(key: string): string {
  if (key.trim() === UNBOUND_KEY) return "no key";
  const input = flaskKeyInput(key);
  if (!input) return `invalid "${key}"`;
  return input.mouse ? `mouse ${input.mouse}` : `key ${key.toLowerCase()}`;
}

export interface ProbeReadiness {
  ready: boolean;
  reason?: string;
}

export function probeReadiness(probe: FlaskProbeConfig): ProbeReadiness {
  if (!probe.enabled) return { ready: false, reason: "disabled" };
  if (!probe.point || !probe.reference) return { ready: false, reason: "not calibrated" };
  if (probe.key.trim() === UNBOUND_KEY) return { ready: false, reason: "no key" };
  if (flaskKeyInput(probe.key) === undefined) return { ready: false, reason: "invalid key" };
  return { ready: true };
}

/** Per-probe continuity carried between host cycles so they behave as one loop. */
export interface ProbeContinuity {
  /**
   * Flask: the HUD has been seen filled at least once. Skill: the icon has
   * been seen dark (cooling) since the last press — or never pressed — so
   * the next "ready" read may press.
   */
  armed: boolean;
  /** -1 = never fired. */
  lastFireMsAgo: number;
  lastFilledMsAgo: number;
}

export function freshContinuity(): ProbeContinuity {
  return { armed: false, lastFireMsAgo: -1, lastFilledMsAgo: 0 };
}

/** A skill starts armed: nothing has been pressed yet, so the first ready read may press. */
export function freshSkillContinuity(): ProbeContinuity {
  return { armed: true, lastFireMsAgo: -1, lastFilledMsAgo: 0 };
}

/** Which patch state presses the key: flasks on "low", skills on "filled" (ready). */
export type FireOn = "low" | "filled";

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
  /** Defaults to "low" (a flask). */
  fireOn?: FireOn;
}

export interface FireDecision {
  fire: boolean;
  armed: boolean;
  stale: boolean;
}

/**
 * TS mirror of the host loop's decision (scripts/win-input-host.ps1,
 * op `flaskguard`). Keep both in sync.
 *
 * Flask (fireOn "low"): a "filled" read arms the probe and never fires;
 * "unknown" (not the globe) never fires and changes nothing; an unarmed
 * probe never fires (login/loading screens before the HUD was ever seen);
 * otherwise fire once the cooldown has elapsed, the cooldown stretching to
 * staleCooldownMs once no "filled" read has been seen for staleAfterMs
 * (death screen, passive tree, menus).
 *
 * Skill (fireOn "filled"): "filled" means the icon is lit = ready. Firing
 * is edge-triggered: a press disarms the probe; a "low" read (the icon went
 * dark — cooldown sweep, or the dimmed unusable state) re-arms it. So a
 * ready read presses when armed, and otherwise only once the retry gap
 * (cooldownMs) has elapsed since the last press — a press the game did not
 * take (chat box focused, out of range) is retried slowly, not every tick.
 * "unknown" never fires and changes nothing. Stale never applies.
 */
export function decideFlaskFire(input: FireDecisionInput): FireDecision {
  if ((input.fireOn ?? "low") === "filled") {
    if (input.state === "low") return { fire: false, armed: true, stale: false };
    if (input.state === "unknown") return { fire: false, armed: input.armed, stale: false };
    const fire = input.armed || input.sinceFireMs >= input.cooldownMs;
    return { fire, armed: fire ? false : input.armed, stale: false };
  }
  if (input.state === "filled") return { fire: false, armed: true, stale: false };
  if (input.state === "unknown") return { fire: false, armed: input.armed, stale: false };
  if (!input.armed) return { fire: false, armed: false, stale: false };
  const stale = input.sinceFilledMs >= input.staleAfterMs;
  const cooldown = stale ? input.staleCooldownMs : input.cooldownMs;
  return { fire: input.sinceFireMs >= cooldown, armed: true, stale };
}

/** The probe rows the host `flaskguard` op consumes, for every ready globe and skill. */
export interface HostProbePayload extends ProbeThresholds, ProbeContinuity, FlaskKeyInput {
  /** "life" | "mana" | "skill:<id>" */
  id: string;
  x: number;
  y: number;
  size: number;
  cooldownMs: number;
  staleAfterMs: number;
  staleCooldownMs: number;
  fireOn: FireOn;
  /** Save a diagnostic screenshot on press (flasks only — skills fire every cooldown). */
  snapshot: boolean;
}

export function skillProbeId(skill: SkillProbeConfig): string {
  return `${SKILL_PROBE_PREFIX}${skill.id}`;
}

export function isSkillProbeId(id: string): boolean {
  return id.startsWith(SKILL_PROBE_PREFIX);
}

/** Config entry for a host probe id, or undefined when it no longer exists. */
export function probeConfigFor(
  config: FlaskGuardConfig,
  id: string,
): { kind: "globe"; probe: FlaskProbeConfig; label: string } | { kind: "skill"; probe: SkillProbeConfig; label: string } | undefined {
  if (id === "life" || id === "mana") return { kind: "globe", probe: config[id], label: `${id} flask` };
  if (!isSkillProbeId(id)) return undefined;
  const skill = config.skills.find((entry) => skillProbeId(entry) === id);
  return skill ? { kind: "skill", probe: skill, label: skill.label } : undefined;
}

export function buildHostProbes(
  config: FlaskGuardConfig,
  continuity: Partial<Record<string, ProbeContinuity>> = {},
): HostProbePayload[] {
  const probes: HostProbePayload[] = [];
  for (const globe of FLASK_GLOBES) {
    const probe = config[globe];
    if (!probeReadiness(probe).ready || !probe.point || !probe.reference) continue;
    const input = flaskKeyInput(probe.key);
    if (!input) continue;
    probes.push({
      id: globe,
      x: probe.point.x,
      y: probe.point.y,
      size: probe.patchSize,
      ...input,
      cooldownMs: probe.cooldownMs,
      staleAfterMs: config.staleAfterMs,
      staleCooldownMs: config.staleCooldownMs,
      fireOn: "low",
      snapshot: true,
      ...probeThresholds(config, probe.reference),
      ...(continuity[globe] ?? freshContinuity()),
    });
  }
  for (const skill of config.skills) {
    if (!probeReadiness(skill).ready || !skill.point || !skill.reference) continue;
    const input = flaskKeyInput(skill.key);
    if (!input) continue;
    const id = skillProbeId(skill);
    probes.push({
      id,
      x: skill.point.x,
      y: skill.point.y,
      size: skill.patchSize,
      ...input,
      cooldownMs: skill.cooldownMs,
      staleAfterMs: config.staleAfterMs,
      staleCooldownMs: config.staleCooldownMs,
      fireOn: "filled",
      snapshot: false,
      ...skillThresholds(config, skill.reference),
      ...(continuity[id] ?? freshSkillContinuity()),
    });
  }
  return probes;
}

export function describeRgb(rgb: Rgb): string {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}
