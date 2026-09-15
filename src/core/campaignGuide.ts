/**
 * Campaign guide — the pure half (package "campaign-guide", P8).
 *
 * Everything here is data shuffling: the bundled route file's sanitizer, the
 * settings namespace sanitizer, the merge that folds the user's corrections
 * and progress into the bundled route, the current-area resolution against
 * Client.txt ids, the community XP-penalty estimate and the customisation
 * patches. No I/O, no Electron, no clock of its own (callers pass `now`), so
 * both processes and the tests share one source of truth.
 *
 * WHY a sanitizer for both files: the route ships with the app but the
 * customisations come from `companion-settings.json` and from JSON the user
 * pasted, so every field is treated as hostile — nothing here throws, bad
 * entries are dropped with an `issue` string the UI can show.
 *
 * WHY nothing is "verified": the route content is community knowledge, not
 * vendor data. Every bundled area and objective carries `verified: false`
 * and both surfaces say so; the user fixes what is wrong in-app.
 */
import { areaInfo } from "./areaCatalog.js";
import type { AreaInfo } from "./clientLog.js";

export const CAMPAIGN_ROUTE_SCHEMA_VERSION = 1 as const;

export type RewardTag =
  | "gems"
  | "passives"
  | "stats"
  | "currency"
  | "unlocks"
  | "ascendancy"
  | "league";

export const REWARD_TAGS: readonly RewardTag[] = [
  "gems",
  "passives",
  "stats",
  "currency",
  "unlocks",
  "ascendancy",
  "league",
];

export type ObjectiveKind =
  | "boss"
  | "quest"
  | "reach"
  | "waypoint"
  | "trial"
  | "optional"
  | "note";

export const OBJECTIVE_KINDS: readonly ObjectiveKind[] = [
  "boss",
  "quest",
  "reach",
  "waypoint",
  "trial",
  "optional",
  "note",
];

/** Hard caps; they bound the settings document (one atomic rewrite per change). */
export const CAMPAIGN_LIMITS = {
  areas: 400,
  objectivesPerArea: 40,
  noteChars: 2000,
  visited: 500,
  exits: 12,
  aliases: 8,
  titleChars: 120,
  detailChars: 600,
  nameChars: 80,
} as const;

/** `campaign:import` refuses anything larger BEFORE parsing (settings growth guard). */
export const CAMPAIGN_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export const DEFAULT_COMMUNITY_NOTE =
  "Community-maintained route. Nothing here is verified against the current game build — check in game, then fix it under Tools → Campaign guide → Edit (and export your corrections).";

export interface CampaignObjective {
  /** "<areaId>.<slug>" for bundled entries, "c_<base36>_<rand>" for the user's own. */
  id: string;
  title: string;
  kind: ObjectiveKind;
  rewards: RewardTag[];
  detail?: string;
  /** kind "reach": auto-done once this area (or an alias of it) is visited. */
  targetAreaId?: string;
  optional?: boolean;
  /** Bundled entries are always false — the route is community knowledge. */
  verified: boolean;
}

export interface CampaignArea {
  /** The Client.txt id ("G1_3"); custom areas may use any /^[A-Za-z0-9_]{1,40}$/. */
  id: string;
  /** Other ids that are the same place ("G2_12_1" for "G2_12"). */
  aliases?: string[];
  name: string;
  part: 1 | 2;
  act: number;
  /** Recommended level = the observed instance level on the normal path. */
  level: number;
  town?: boolean;
  waypoint?: boolean;
  /** Area ids reachable from here (the map's edges). */
  exits: string[];
  /** Side area, drawn below the spine; default false = main path. */
  branch?: boolean;
  objectives: CampaignObjective[];
  notes?: string;
  /** Page title for https://www.poe2wiki.net/wiki/<title>. */
  wiki?: string;
  verified: boolean;
}

export interface CampaignAct {
  part: 1 | 2;
  act: number;
  name: string;
  townId?: string;
  areas: CampaignArea[];
}

export interface CampaignRouteFile {
  schemaVersion: 1;
  source: string;
  updatedAt: string;
  /** The visible "community-maintained, verify in game" text. */
  communityNote: string;
  acts: CampaignAct[];
}

export interface CampaignRouteParse {
  route: CampaignRouteFile;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Small sanitizing helpers
// ---------------------------------------------------------------------------

const AREA_ID = /^[A-Za-z0-9_]{1,40}$/;
const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f]+", "g");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, " ").trim().slice(0, max);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function idList(value: unknown, cap: number): string[] {
  const raw = asArray(value)
    .map((entry) => cleanText(entry, 40))
    .filter((entry) => AREA_ID.test(entry));
  return dedupe(raw).slice(0, cap);
}

function rewardList(value: unknown, issues?: string[], where?: string): RewardTag[] {
  const out: RewardTag[] = [];
  for (const entry of asArray(value)) {
    const tag = cleanText(entry, 20) as RewardTag;
    if ((REWARD_TAGS as readonly string[]).includes(tag)) {
      if (!out.includes(tag)) out.push(tag);
    } else if (issues && where && tag) {
      issues.push(`${where}: unknown reward tag "${tag}"`);
    }
  }
  return out;
}

export const WIKI_HOST = "www.poe2wiki.net";

/**
 * A wiki URL for an area, or undefined when the (user-editable) `wiki`/`name`
 * would escape the host or the /wiki/ path. The check runs on the FINAL
 * string, not on the inputs, so "../../evil" and "http://x" never leave.
 */
export function wikiUrl(area: Pick<CampaignArea, "name" | "wiki">): string | undefined {
  const title = cleanText(area.wiki ?? area.name, 120).replace(/\s+/g, "_");
  if (!title) return undefined;
  // Refuse anything that looks like a path, a scheme or a query BEFORE encoding:
  // percent-encoding would make "../../evil" harmless but unreadable, and a
  // title that needs those characters is a mistake, not a page name. The
  // backslash is in the class in its own right (inside a character class "\:"
  // is only a colon, so it has to be written out).
  if (/[/\\:?#]/.test(title) || title.startsWith(".")) return undefined;
  const candidate = `https://${WIKI_HOST}/wiki/${encodeURIComponent(title)}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return undefined;
    if (url.host !== WIKI_HOST) return undefined;
    if (!url.pathname.startsWith("/wiki/")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function actKey(part: 1 | 2, act: number): string {
  return `${part}-${act}`;
}

export function actLabel(part: 1 | 2, act: number): string {
  return part === 1 ? `Act ${act}` : `Act ${act} · second half`;
}

export function emptyCampaignRoute(): CampaignRouteFile {
  return {
    schemaVersion: CAMPAIGN_ROUTE_SCHEMA_VERSION,
    source: "",
    updatedAt: "",
    communityNote: DEFAULT_COMMUNITY_NOTE,
    acts: [],
  };
}

// ---------------------------------------------------------------------------
// Route sanitizer
// ---------------------------------------------------------------------------

function sanitizeObjective(
  raw: unknown,
  areaId: string,
  index: number,
  issues: string[],
): CampaignObjective | undefined {
  if (!isPlainObject(raw)) {
    issues.push(`${areaId}.objectives[${index}]: not an object`);
    return undefined;
  }
  const title = cleanText(raw.title, CAMPAIGN_LIMITS.titleChars);
  if (!title) {
    issues.push(`${areaId}.objectives[${index}]: missing title`);
    return undefined;
  }
  const rawId = cleanText(raw.id, 80);
  const id = rawId || `${areaId}.o${index}`;
  const kindText = cleanText(raw.kind, 20) as ObjectiveKind;
  const kind: ObjectiveKind = (OBJECTIVE_KINDS as readonly string[]).includes(kindText)
    ? kindText
    : "note";
  const detail = cleanText(raw.detail, CAMPAIGN_LIMITS.detailChars);
  const target = cleanText(raw.targetAreaId, 40);
  const objective: CampaignObjective = {
    id,
    title,
    kind,
    rewards: rewardList(raw.rewards, issues, `${areaId}.${id}`),
    verified: raw.verified === true,
  };
  if (detail) objective.detail = detail;
  if (target && AREA_ID.test(target)) objective.targetAreaId = target;
  if (raw.optional === true) objective.optional = true;
  return objective;
}

function sanitizeArea(raw: unknown, act: CampaignAct, issues: string[]): CampaignArea | undefined {
  if (!isPlainObject(raw)) {
    issues.push(`${actKey(act.part, act.act)}: an area is not an object`);
    return undefined;
  }
  const id = cleanText(raw.id, 40);
  if (!AREA_ID.test(id)) {
    issues.push(`area "${id || "(missing id)"}": invalid id`);
    return undefined;
  }
  const catalogue = areaInfo(id);
  const name = cleanText(raw.name, CAMPAIGN_LIMITS.nameChars) || catalogue.name || id;
  const level = clampInt(raw.level, 1, 100) ?? catalogue.level ?? 1;
  const area: CampaignArea = {
    id,
    name,
    part: act.part,
    act: act.act,
    level,
    exits: idList(raw.exits, CAMPAIGN_LIMITS.exits),
    objectives: [],
    verified: raw.verified === true,
  };
  const aliases = idList(raw.aliases, CAMPAIGN_LIMITS.aliases).filter((alias) => alias !== id);
  if (aliases.length) area.aliases = aliases;
  if (raw.town === true) area.town = true;
  if (raw.waypoint === true) area.waypoint = true;
  if (raw.branch === true) area.branch = true;
  const notes = cleanText(raw.notes, CAMPAIGN_LIMITS.detailChars);
  if (notes) area.notes = notes;
  const wiki = cleanText(raw.wiki, 120);
  if (wiki) {
    if (wikiUrl({ name, wiki })) area.wiki = wiki;
    else issues.push(`${id}.wiki: "${wiki}" is not a usable wiki page title`);
  }

  const seen = new Set<string>();
  const objectives = asArray(raw.objectives);
  for (const [index, entry] of objectives.entries()) {
    if (area.objectives.length >= CAMPAIGN_LIMITS.objectivesPerArea) {
      issues.push(`${id}: more than ${CAMPAIGN_LIMITS.objectivesPerArea} objectives — the rest were dropped`);
      break;
    }
    const objective = sanitizeObjective(entry, id, index, issues);
    if (!objective) continue;
    if (seen.has(objective.id)) {
      issues.push(`${id}: duplicate objective id "${objective.id}"`);
      continue;
    }
    seen.add(objective.id);
    area.objectives.push(objective);
  }
  return area;
}

/** Never throws; caps everything; drops dangling exits and reach targets. */
export function sanitizeCampaignRoute(raw: unknown): CampaignRouteParse {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return { route: emptyCampaignRoute(), issues: ["route: not an object"] };
  }
  const route = emptyCampaignRoute();
  if (raw.schemaVersion !== CAMPAIGN_ROUTE_SCHEMA_VERSION) {
    issues.push(`route: unexpected schemaVersion ${String(raw.schemaVersion)} (expected 1)`);
  }
  route.source = cleanText(raw.source, 120);
  route.updatedAt = cleanText(raw.updatedAt, 40);
  route.communityNote = cleanText(raw.communityNote, CAMPAIGN_LIMITS.noteChars) || DEFAULT_COMMUNITY_NOTE;

  const acts = asArray(raw.acts);
  if (!Array.isArray(raw.acts)) issues.push("route.acts: not an array");

  const seenAreaIds = new Set<string>();
  let areaCount = 0;
  for (const [index, entry] of acts.entries()) {
    if (!isPlainObject(entry)) {
      issues.push(`acts[${index}]: not an object`);
      continue;
    }
    const part = entry.part === 2 ? 2 : entry.part === 1 ? 1 : undefined;
    const actNumber = clampInt(entry.act, 1, 9);
    if (!part || actNumber === undefined) {
      issues.push(`acts[${index}]: missing part/act`);
      continue;
    }
    const maxAct = part === 1 ? 4 : 3;
    if (actNumber > maxAct) {
      issues.push(`acts[${index}]: part ${part} has no act ${actNumber}`);
      continue;
    }
    const act: CampaignAct = {
      part,
      act: actNumber,
      name: cleanText(entry.name, CAMPAIGN_LIMITS.nameChars) || actLabel(part, actNumber),
      areas: [],
    };
    const townId = cleanText(entry.townId, 40);
    if (townId && AREA_ID.test(townId)) act.townId = townId;
    for (const areaRaw of asArray(entry.areas)) {
      if (areaCount >= CAMPAIGN_LIMITS.areas) {
        issues.push(`route: more than ${CAMPAIGN_LIMITS.areas} areas — the rest were dropped`);
        break;
      }
      const area = sanitizeArea(areaRaw, act, issues);
      if (!area) continue;
      if (seenAreaIds.has(area.id)) {
        issues.push(`route: duplicate area id "${area.id}" — the first one wins`);
        continue;
      }
      seenAreaIds.add(area.id);
      areaCount += 1;
      act.areas.push(area);
    }
    route.acts.push(act);
  }

  // Second pass: everything that points at an area must point at one we kept.
  for (const act of route.acts) {
    for (const area of act.areas) {
      const exits = area.exits.filter((exit) => {
        if (seenAreaIds.has(exit)) return true;
        issues.push(`${area.id}.exits: unknown area ${exit}`);
        return false;
      });
      area.exits = exits;
      for (const objective of area.objectives) {
        if (objective.targetAreaId && !seenAreaIds.has(objective.targetAreaId)) {
          issues.push(`${objective.id}.targetAreaId: unknown area ${objective.targetAreaId}`);
          delete objective.targetAreaId;
        }
      }
    }
  }
  return { route, issues };
}

/** Length cap → JSON.parse → sanitize. Junk or oversize yields an empty route. */
export function parseCampaignRoute(text: string): CampaignRouteParse {
  if (typeof text !== "string") {
    return { route: emptyCampaignRoute(), issues: ["route: not text"] };
  }
  if (text.length > CAMPAIGN_IMPORT_MAX_BYTES) {
    return { route: emptyCampaignRoute(), issues: ["route: larger than 2 MiB"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { route: emptyCampaignRoute(), issues: [`route: not valid JSON (${message})`] };
  }
  return sanitizeCampaignRoute(parsed);
}

// ---------------------------------------------------------------------------
// Customisations + progress (the settings namespace payload)
// ---------------------------------------------------------------------------

export interface CampaignCustomisations {
  hiddenAreaIds: string[];
  hiddenObjectiveIds: string[];
  areaOrder: Record<string, string[]>;
  objectiveOrder: Record<string, string[]>;
  areaNotes: Record<string, string>;
  customObjectives: Record<string, CampaignObjective[]>;
  objectiveOverrides: Record<
    string,
    Partial<Pick<CampaignObjective, "title" | "kind" | "rewards" | "detail" | "targetAreaId" | "optional">>
  >;
  areaOverrides: Record<
    string,
    Partial<Pick<CampaignArea, "name" | "level" | "exits" | "waypoint" | "town" | "branch" | "notes" | "wiki" | "aliases">>
  >;
  customAreas: CampaignArea[];
}

/** Named apart from P7's session `CampaignProgress` — different scope, different file. */
export interface CampaignGuideProgress {
  /** canonical areaId → ISO of the FIRST visit; the 500 newest are kept. */
  visited: Record<string, string>;
  done: Record<string, string>;
  /** Manual "not done" for auto-completed reach objectives. */
  undone: string[];
}

export type CampaignOverlayAnchor =
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const OVERLAY_ANCHORS: readonly CampaignOverlayAnchor[] = [
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export interface CampaignGuideSettings {
  autoShowInCampaign: boolean;
  hideOutsideCampaign: boolean;
  overlayAnchor: CampaignOverlayAnchor;
  /** Compact = header + next step only. */
  overlayCompact: boolean;
  rewardFilters: Record<RewardTag, boolean>;
  showOptional: boolean;
  characterLevelOverride: number | null;
  customisations: CampaignCustomisations;
  progress: CampaignGuideProgress;
}

export function emptyCampaignCustomisations(): CampaignCustomisations {
  return {
    hiddenAreaIds: [],
    hiddenObjectiveIds: [],
    areaOrder: {},
    objectiveOrder: {},
    areaNotes: {},
    customObjectives: {},
    objectiveOverrides: {},
    areaOverrides: {},
    customAreas: [],
  };
}

export function defaultCampaignGuideSettings(): CampaignGuideSettings {
  return {
    autoShowInCampaign: true,
    hideOutsideCampaign: true,
    overlayAnchor: "right",
    overlayCompact: false,
    rewardFilters: {
      gems: true,
      passives: true,
      stats: true,
      currency: true,
      unlocks: true,
      ascendancy: true,
      league: true,
    },
    showOptional: true,
    characterLevelOverride: null,
    customisations: emptyCampaignCustomisations(),
    progress: { visited: {}, done: {}, undone: [] },
  };
}

function sanitizeCustomObjective(raw: unknown, areaId: string, index: number): CampaignObjective | undefined {
  const objective = sanitizeObjective(raw, areaId, index, []);
  if (!objective) return undefined;
  objective.verified = false;
  return objective;
}

function sanitizeCustomArea(raw: unknown): CampaignArea | undefined {
  if (!isPlainObject(raw)) return undefined;
  const part = raw.part === 2 ? 2 : 1;
  const actNumber = clampInt(raw.act, 1, part === 1 ? 4 : 3) ?? 1;
  const area = sanitizeArea(raw, { part, act: actNumber, name: "", areas: [] }, []);
  if (!area) return undefined;
  area.verified = false;
  for (const objective of area.objectives) objective.verified = false;
  return area;
}

function stringMap(raw: unknown, valueCap: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = cleanText(key, 80);
    const text = cleanText(value, valueCap);
    if (id && text) out[id] = text;
  }
  return out;
}

function idListMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = cleanText(key, 80);
    if (!id) continue;
    const list = dedupe(asArray(value).map((entry) => cleanText(entry, 80)).filter(Boolean)).slice(
      0,
      CAMPAIGN_LIMITS.areas,
    );
    if (list.length) out[id] = list;
  }
  return out;
}

function sanitizeObjectiveOverrides(raw: unknown): CampaignCustomisations["objectiveOverrides"] {
  const out: CampaignCustomisations["objectiveOverrides"] = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = cleanText(key, 80);
    if (!id || !isPlainObject(value)) continue;
    const patch: CampaignCustomisations["objectiveOverrides"][string] = {};
    const title = cleanText(value.title, CAMPAIGN_LIMITS.titleChars);
    if (title) patch.title = title;
    const kind = cleanText(value.kind, 20) as ObjectiveKind;
    if ((OBJECTIVE_KINDS as readonly string[]).includes(kind)) patch.kind = kind;
    if (Array.isArray(value.rewards)) patch.rewards = rewardList(value.rewards);
    if (typeof value.detail === "string") patch.detail = cleanText(value.detail, CAMPAIGN_LIMITS.detailChars);
    const target = cleanText(value.targetAreaId, 40);
    if (target && AREA_ID.test(target)) patch.targetAreaId = target;
    if (typeof value.optional === "boolean") patch.optional = value.optional;
    if (Object.keys(patch).length) out[id] = patch;
  }
  return out;
}

function sanitizeAreaOverrides(raw: unknown): CampaignCustomisations["areaOverrides"] {
  const out: CampaignCustomisations["areaOverrides"] = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = cleanText(key, 40);
    if (!AREA_ID.test(id) || !isPlainObject(value)) continue;
    const patch: CampaignCustomisations["areaOverrides"][string] = {};
    const name = cleanText(value.name, CAMPAIGN_LIMITS.nameChars);
    if (name) patch.name = name;
    const level = clampInt(value.level, 1, 100);
    if (level !== undefined) patch.level = level;
    if (Array.isArray(value.exits)) patch.exits = idList(value.exits, CAMPAIGN_LIMITS.exits);
    if (Array.isArray(value.aliases)) patch.aliases = idList(value.aliases, CAMPAIGN_LIMITS.aliases);
    if (typeof value.waypoint === "boolean") patch.waypoint = value.waypoint;
    if (typeof value.town === "boolean") patch.town = value.town;
    if (typeof value.branch === "boolean") patch.branch = value.branch;
    if (typeof value.notes === "string") patch.notes = cleanText(value.notes, CAMPAIGN_LIMITS.noteChars);
    if (typeof value.wiki === "string") {
      const wiki = cleanText(value.wiki, 120);
      if (wiki && wikiUrl({ name: name || id, wiki })) patch.wiki = wiki;
    }
    if (Object.keys(patch).length) out[id] = patch;
  }
  return out;
}

export function sanitizeCampaignCustomisations(raw: unknown): CampaignCustomisations {
  const out = emptyCampaignCustomisations();
  if (!isPlainObject(raw)) return out;
  out.hiddenAreaIds = idList(raw.hiddenAreaIds, CAMPAIGN_LIMITS.areas);
  out.hiddenObjectiveIds = dedupe(
    asArray(raw.hiddenObjectiveIds).map((entry) => cleanText(entry, 80)).filter(Boolean),
  ).slice(0, CAMPAIGN_LIMITS.areas * 4);
  out.areaOrder = idListMap(raw.areaOrder);
  out.objectiveOrder = idListMap(raw.objectiveOrder);
  out.areaNotes = stringMap(raw.areaNotes, CAMPAIGN_LIMITS.noteChars);
  out.objectiveOverrides = sanitizeObjectiveOverrides(raw.objectiveOverrides);
  out.areaOverrides = sanitizeAreaOverrides(raw.areaOverrides);
  if (isPlainObject(raw.customObjectives)) {
    for (const [key, value] of Object.entries(raw.customObjectives)) {
      const areaId = cleanText(key, 40);
      if (!AREA_ID.test(areaId)) continue;
      const list: CampaignObjective[] = [];
      for (const [index, entry] of asArray(value).entries()) {
        if (list.length >= CAMPAIGN_LIMITS.objectivesPerArea) break;
        const objective = sanitizeCustomObjective(entry, areaId, index);
        if (objective && !list.some((other) => other.id === objective.id)) list.push(objective);
      }
      if (list.length) out.customObjectives[areaId] = list;
    }
  }
  const customAreas: CampaignArea[] = [];
  for (const entry of asArray(raw.customAreas)) {
    if (customAreas.length >= CAMPAIGN_LIMITS.areas) break;
    const area = sanitizeCustomArea(entry);
    if (area && !customAreas.some((other) => other.id === area.id)) customAreas.push(area);
  }
  out.customAreas = customAreas;
  return out;
}

function sanitizeProgress(raw: unknown): CampaignGuideProgress {
  const progress: CampaignGuideProgress = { visited: {}, done: {}, undone: [] };
  if (!isPlainObject(raw)) return progress;
  const visited: Array<[string, string]> = [];
  if (isPlainObject(raw.visited)) {
    for (const [key, value] of Object.entries(raw.visited)) {
      const id = cleanText(key, 40);
      const at = cleanText(value, 40);
      if (!AREA_ID.test(id) || !at || Number.isNaN(Date.parse(at))) continue;
      visited.push([id, at]);
    }
  }
  visited.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  for (const [id, at] of visited.slice(0, CAMPAIGN_LIMITS.visited)) progress.visited[id] = at;
  if (isPlainObject(raw.done)) {
    for (const [key, value] of Object.entries(raw.done)) {
      const id = cleanText(key, 80);
      const at = cleanText(value, 40);
      if (!id || !at || Number.isNaN(Date.parse(at))) continue;
      progress.done[id] = at;
    }
  }
  progress.undone = dedupe(asArray(raw.undone).map((entry) => cleanText(entry, 80)).filter(Boolean)).slice(
    0,
    CAMPAIGN_LIMITS.areas * 4,
  );
  return progress;
}

/** The namespace sanitizer. Never throws; unknown keys are dropped. */
export function normalizeCampaignGuideSettings(raw: unknown): CampaignGuideSettings {
  const defaults = defaultCampaignGuideSettings();
  if (!isPlainObject(raw)) return defaults;
  const anchorText = cleanText(raw.overlayAnchor, 20) as CampaignOverlayAnchor;
  const filtersRaw = isPlainObject(raw.rewardFilters) ? raw.rewardFilters : {};
  const rewardFilters = { ...defaults.rewardFilters };
  for (const tag of REWARD_TAGS) rewardFilters[tag] = filtersRaw[tag] !== false;
  const override = clampInt(raw.characterLevelOverride, 1, 100);
  return {
    autoShowInCampaign: raw.autoShowInCampaign !== false,
    hideOutsideCampaign: raw.hideOutsideCampaign !== false,
    // "cursor" is deliberately not accepted: an auto-shown panel must not chase the pointer.
    overlayAnchor: OVERLAY_ANCHORS.includes(anchorText) ? anchorText : defaults.overlayAnchor,
    overlayCompact: raw.overlayCompact === true,
    rewardFilters,
    showOptional: raw.showOptional !== false,
    characterLevelOverride:
      raw.characterLevelOverride === null || raw.characterLevelOverride === undefined
        ? null
        : (override ?? null),
    customisations: sanitizeCampaignCustomisations(raw.customisations),
    progress: sanitizeProgress(raw.progress),
  };
}

/**
 * True when anything but `progress` differs. Progress-only writes emit
 * `campaign:state` alone (§4.1) so walking through 100 areas never pushes
 * the whole merged route 100 times.
 */
export function routeAffectingSettingsChanged(
  next: CampaignGuideSettings,
  previous: CampaignGuideSettings,
): boolean {
  if (
    next.autoShowInCampaign !== previous.autoShowInCampaign ||
    next.hideOutsideCampaign !== previous.hideOutsideCampaign ||
    next.overlayAnchor !== previous.overlayAnchor ||
    next.overlayCompact !== previous.overlayCompact ||
    next.showOptional !== previous.showOptional ||
    next.characterLevelOverride !== previous.characterLevelOverride
  ) {
    return true;
  }
  if (JSON.stringify(next.rewardFilters) !== JSON.stringify(previous.rewardFilters)) return true;
  // The sanitizer builds a fresh object per write, so identity is useless here.
  return JSON.stringify(next.customisations) !== JSON.stringify(previous.customisations);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergedObjective extends CampaignObjective {
  areaId: string;
  custom: boolean;
  edited: boolean;
  hidden: boolean;
  done: boolean;
  doneAt?: string;
  /** Completed by walking into `targetAreaId` rather than by a tick. */
  auto: boolean;
}

export interface MergedArea extends Omit<CampaignArea, "objectives"> {
  /** actKey of the act it is rendered in. */
  key: string;
  objectives: MergedObjective[];
  custom: boolean;
  edited: boolean;
  hidden: boolean;
  visitedAt?: string;
  userNote?: string;
}

export interface MergedAct extends Omit<CampaignAct, "areas"> {
  key: string;
  label: string;
  areas: MergedArea[];
}

export interface MergedRoute {
  acts: MergedAct[];
  areaIndex: Record<string, MergedArea>;
  /** alias (and every `C_<id>` form) → canonical id. */
  aliasIndex: Record<string, string>;
  communityNote: string;
  source: string;
  updatedAt: string;
}

/** User order first (unknown ids skipped), then the rest in bundled order. */
export function applyOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || !order.length) return [...items];
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) {
      out.push(item);
      byId.delete(id);
    }
  }
  for (const item of items) if (byId.has(item.id)) out.push(item);
  return out;
}

function mergeObjective(
  objective: CampaignObjective,
  areaId: string,
  custom: boolean,
  settings: CampaignGuideSettings,
  visited: (id: string) => boolean,
): MergedObjective {
  const override = settings.customisations.objectiveOverrides[objective.id];
  const merged: MergedObjective = {
    ...objective,
    ...(override ?? {}),
    verified: false,
    areaId,
    custom,
    edited: Boolean(override),
    hidden: settings.customisations.hiddenObjectiveIds.includes(objective.id),
    done: false,
    auto: false,
  };
  const undone = settings.progress.undone.includes(objective.id);
  const doneAt = settings.progress.done[objective.id];
  if (doneAt && !undone) {
    merged.done = true;
    merged.doneAt = doneAt;
  }
  if (merged.kind === "reach" && merged.targetAreaId && visited(merged.targetAreaId)) {
    merged.auto = true;
  }
  return merged;
}

function mergeArea(
  area: CampaignArea,
  key: string,
  custom: boolean,
  settings: CampaignGuideSettings,
  visited: (id: string) => boolean,
): MergedArea {
  const override = settings.customisations.areaOverrides[area.id];
  const custom0 = settings.customisations.customObjectives[area.id] ?? [];
  const objectives = applyOrder(
    [
      ...area.objectives.map((objective) => ({ objective, custom })),
      ...custom0.map((objective) => ({ objective, custom: true })),
    ].map((entry) => ({ ...entry.objective, __custom: entry.custom })),
    settings.customisations.objectiveOrder[area.id],
  ).map((entry) => {
    const { __custom, ...objective } = entry as CampaignObjective & { __custom: boolean };
    return mergeObjective(objective, area.id, __custom, settings, visited);
  });
  const merged: MergedArea = {
    ...area,
    ...(override ?? {}),
    verified: false,
    key,
    objectives,
    custom,
    edited: Boolean(override),
    hidden: settings.customisations.hiddenAreaIds.includes(area.id),
  };
  const visitedAt = settings.progress.visited[area.id];
  if (visitedAt) merged.visitedAt = visitedAt;
  const userNote = settings.customisations.areaNotes[area.id];
  if (userNote) merged.userNote = userNote;
  return merged;
}

/** Bundled route + the user's corrections + progress → what both UIs render. */
export function mergeCampaignRoute(
  route: CampaignRouteFile,
  settings: CampaignGuideSettings,
): MergedRoute {
  // A hand-edited settings file could carry a "custom" area whose id is also a
  // bundled one; `applyOrder` would then keep BOTH and the area would render
  // twice (with `areaIndex` silently taking the custom one). `add-area` and the
  // importer already refuse that case — this is the last line of defence.
  const bundledIds = bundledAreaIds(route);
  const customAreas = settings.customisations.customAreas.filter((area) => !bundledIds.has(area.id));

  const customByAct = new Map<string, CampaignArea[]>();
  for (const area of customAreas) {
    const key = actKey(area.part, area.act);
    const list = customByAct.get(key) ?? [];
    list.push(area);
    customByAct.set(key, list);
  }

  // The alias index must exist before merge so `reach` auto-completion can
  // canonicalise a visited alias.
  const aliasIndex: Record<string, string> = {};
  const allAreas: CampaignArea[] = [...route.acts.flatMap((act) => act.areas), ...customAreas];
  for (const area of allAreas) {
    aliasIndex[area.id] = area.id;
    aliasIndex[`C_${area.id}`] = area.id;
    const aliases = settings.customisations.areaOverrides[area.id]?.aliases ?? area.aliases ?? [];
    for (const alias of aliases) {
      aliasIndex[alias] = area.id;
      aliasIndex[`C_${alias}`] = area.id;
    }
  }
  const visited = (id: string): boolean => {
    const canonical = aliasIndex[id] ?? id;
    if (settings.progress.visited[canonical]) return true;
    // An alias may have been visited under its own id (older progress).
    return Boolean(settings.progress.visited[id]);
  };

  const acts: MergedAct[] = [];
  const usedKeys = new Set<string>();
  for (const act of route.acts) {
    const key = actKey(act.part, act.act);
    usedKeys.add(key);
    const areas = applyOrder(
      [...act.areas.map((area) => ({ area, custom: false })), ...(customByAct.get(key) ?? []).map((area) => ({ area, custom: true }))].map(
        (entry) => ({ ...entry.area, __custom: entry.custom }),
      ),
      settings.customisations.areaOrder[key],
    ).map((entry) => {
      const { __custom, ...area } = entry as CampaignArea & { __custom: boolean };
      return mergeArea(area, key, __custom, settings, visited);
    });
    acts.push({ ...act, key, label: actLabel(act.part, act.act), areas });
  }
  // Custom areas in an act the bundled route does not have get their own act.
  for (const [key, areas] of [...customByAct.entries()].sort()) {
    if (usedKeys.has(key)) continue;
    const first = areas[0];
    acts.push({
      part: first.part,
      act: first.act,
      name: actLabel(first.part, first.act),
      key,
      label: actLabel(first.part, first.act),
      areas: applyOrder(areas, settings.customisations.areaOrder[key]).map((area) =>
        mergeArea(area, key, true, settings, visited),
      ),
    });
  }

  const areaIndex: Record<string, MergedArea> = {};
  for (const act of acts) for (const area of act.areas) areaIndex[area.id] = area;

  return {
    acts,
    areaIndex,
    aliasIndex,
    communityNote: route.communityNote || DEFAULT_COMMUNITY_NOTE,
    source: route.source,
    updatedAt: route.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Current area
// ---------------------------------------------------------------------------

export interface AreaResolution {
  kind: "known" | "unknown-campaign" | "outside";
  /** As seen in the log. */
  areaId: string;
  /** Canonical route id (alias/cruel resolved), or the stripped id. */
  normalizedId: string;
  isCruel: boolean;
  area?: MergedArea;
  /** kind "unknown-campaign": pre-fills "Add area". */
  guess?: { name: string; part: 1 | 2; act: number; level?: number };
}

/**
 * Part/act straight from the id text. NOT from `areaInfo().part`: the
 * catalogue reports `part: 2` for every legacy Cruel id, which would pre-fill
 * an unknown `C_G4_99` as a second-half area.
 */
export function campaignIdParts(
  areaId: string,
): { stripped: string; isCruel: boolean; part: 1 | 2; act: number } | undefined {
  if (typeof areaId !== "string" || !areaId) return undefined;
  const isCruel = areaId.startsWith("C_");
  // The log writes some ids with a trailing underscore ("C_G3_16_").
  const stripped = areaId.replace(/^C_/, "").replace(/_$/, "");
  const part1 = /^G(\d+)_/.exec(stripped);
  if (part1) return { stripped, isCruel, part: 1, act: Number(part1[1]) };
  const part2 = /^P(\d+)_/.exec(stripped);
  if (part2) return { stripped, isCruel, part: 2, act: Number(part2[1]) };
  return undefined;
}

export function resolveArea(merged: MergedRoute, areaId: string, info: AreaInfo): AreaResolution {
  const parts = campaignIdParts(areaId);
  const stripped = parts?.stripped ?? areaId;
  const normalizedId = merged.aliasIndex[areaId] ?? merged.aliasIndex[stripped] ?? stripped;
  const isCruel = parts?.isCruel ?? false;
  const area = merged.areaIndex[normalizedId];
  if (area) return { kind: "known", areaId, normalizedId, isCruel, area };
  if (parts) {
    return {
      kind: "unknown-campaign",
      areaId,
      normalizedId,
      isCruel,
      guess: {
        name: info?.name || stripped,
        part: parts.part,
        act: parts.act,
        ...(typeof info?.level === "number" ? { level: info.level } : {}),
      },
    };
  }
  return { kind: "outside", areaId, normalizedId, isCruel };
}

export type NextStep =
  | { kind: "objective"; objective: MergedObjective }
  | { kind: "exit"; area: MergedArea }
  | { kind: "act-complete"; town?: MergedArea }
  | { kind: "none" };

/** Objectives the current filters let through (hidden ones only on request). */
export function visibleObjectives(
  area: MergedArea,
  settings: CampaignGuideSettings,
  includeHidden = false,
): MergedObjective[] {
  return area.objectives.filter((objective) => {
    if (objective.hidden && !includeHidden) return false;
    if (objective.optional && !settings.showOptional) return false;
    if (!objective.rewards.length) return true;
    return objective.rewards.some((tag) => settings.rewardFilters[tag] !== false);
  });
}

export function nextStep(
  merged: MergedRoute,
  area: MergedArea,
  settings: CampaignGuideSettings,
): NextStep {
  const open = visibleObjectives(area, settings).find(
    (objective) => !objective.done && !objective.auto,
  );
  if (open) return { kind: "objective", objective: open };
  for (const exitId of area.exits) {
    const exit = merged.areaIndex[exitId];
    if (exit && !exit.hidden && !exit.visitedAt) return { kind: "exit", area: exit };
  }
  const act = merged.acts.find((entry) => entry.key === area.key);
  const town = act?.areas.find((entry) => entry.town);
  if (act) return { kind: "act-complete", ...(town ? { town } : {}) };
  return { kind: "none" };
}

export function actProgress(act: MergedAct): {
  areas: number;
  visited: number;
  objectives: number;
  done: number;
} {
  let areas = 0;
  let visited = 0;
  let objectives = 0;
  let done = 0;
  for (const area of act.areas) {
    if (area.hidden) continue;
    areas += 1;
    if (area.visitedAt) visited += 1;
    for (const objective of area.objectives) {
      if (objective.hidden) continue;
      objectives += 1;
      if (objective.done || objective.auto) done += 1;
    }
  }
  return { areas, visited, objectives, done };
}

// ---------------------------------------------------------------------------
// Experience helper
// ---------------------------------------------------------------------------

export type XpBand = "on-level" | "over-levelled" | "under-levelled";
export type XpSeverity = "none" | "minor" | "moderate" | "severe";

export interface ExperienceEstimate {
  band: XpBand;
  severity: XpSeverity;
  safeZone: number;
  effectiveDifference: number;
  multiplier: number;
  percent: number;
  message: string;
  formula: "poe1-community";
}

/**
 * The community XP-penalty formula (PoE1's, the closest public model): a
 * safe zone of `3 + floor(level/16)`, then a steep falloff. An ESTIMATE —
 * every surface that shows the percentage says so.
 */
export function experienceBand(characterLevel: number, areaLevel: number): ExperienceEstimate {
  const level = Math.min(100, Math.max(1, Math.round(characterLevel || 1)));
  const area = Math.min(100, Math.max(1, Math.round(areaLevel || 1)));
  const safeZone = 3 + Math.floor(level / 16);
  const diff = Math.abs(level - area);
  const effective = Math.max(0, diff - safeZone);
  const multiplier =
    effective === 0 ? 1 : ((level + 5) / (level + 5 + effective ** 2.5)) ** 1.5;
  const percent = Math.round(multiplier * 100);
  const band: XpBand = effective === 0 ? "on-level" : level > area ? "over-levelled" : "under-levelled";
  const severity: XpSeverity =
    percent >= 100 ? "none" : percent >= 90 ? "minor" : percent >= 50 ? "moderate" : "severe";
  const message =
    band === "on-level"
      ? "On pace for this area."
      : band === "over-levelled"
        ? `You are ${diff} levels above this area — about ${percent} % experience; move on.`
        : `You are ${diff} levels below this area — about ${percent} % experience; monsters are ${diff} levels above you.`;
  return {
    band,
    severity,
    safeZone,
    effectiveDifference: effective,
    multiplier,
    percent,
    message,
    formula: "poe1-community",
  };
}

export function experienceChipTone(estimate: ExperienceEstimate): "safe" | "warning" | "danger" {
  if (estimate.band === "under-levelled" && estimate.effectiveDifference >= 3) return "danger";
  if (estimate.severity === "none" || estimate.severity === "minor") return "safe";
  if (estimate.severity === "moderate") return "warning";
  return "danger";
}

// ---------------------------------------------------------------------------
// Mutations (pure; the module wraps them in settings.set(fn))
// ---------------------------------------------------------------------------

export type CampaignCustomisePatch =
  | { op: "hide-objective" | "restore-objective" | "hide-area" | "restore-area"; id: string }
  | { op: "move-area"; actKey: string; orderedIds: string[] }
  | { op: "move-objective"; areaId: string; orderedIds: string[] }
  | { op: "set-note"; areaId: string; note: string }
  | { op: "add-objective"; areaId: string; objective: Omit<CampaignObjective, "id" | "verified"> }
  | { op: "edit-objective"; id: string; patch: CampaignCustomisations["objectiveOverrides"][string] }
  | { op: "delete-objective"; id: string }
  | {
      op: "add-area";
      area: Omit<CampaignArea, "objectives" | "verified"> & {
        objectives?: Array<Omit<CampaignObjective, "id" | "verified">>;
      };
    }
  | { op: "edit-area"; id: string; patch: CampaignCustomisations["areaOverrides"][string] }
  | { op: "delete-area"; id: string }
  | { op: "set-done"; id: string; done: boolean; at: string }
  | { op: "reset"; what: "progress" | "customisations" | "all" };

export const CAMPAIGN_PATCH_OPS: readonly CampaignCustomisePatch["op"][] = [
  "hide-objective",
  "restore-objective",
  "hide-area",
  "restore-area",
  "move-area",
  "move-objective",
  "set-note",
  "add-objective",
  "edit-objective",
  "delete-objective",
  "add-area",
  "edit-area",
  "delete-area",
  "set-done",
  "reset",
];

/** "c_<base36 time>_<4 base36>" — stable enough for a per-user list. */
export function newObjectiveId(now: () => number = Date.now, random: () => number = Math.random): string {
  const stamp = Math.floor(now()).toString(36);
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `c_${stamp}_${tail}`;
}

function cloneSettings(settings: CampaignGuideSettings): CampaignGuideSettings {
  return JSON.parse(JSON.stringify(settings)) as CampaignGuideSettings;
}

function bundledObjectiveIds(route: CampaignRouteFile): Set<string> {
  const out = new Set<string>();
  for (const act of route.acts) {
    for (const area of act.areas) for (const objective of area.objectives) out.add(objective.id);
  }
  return out;
}

function bundledAreaIds(route: CampaignRouteFile): Set<string> {
  const out = new Set<string>();
  for (const act of route.acts) for (const area of act.areas) out.add(area.id);
  return out;
}

function pushUnique(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

/**
 * Applies one customisation patch. Pure: the input is never touched, and a
 * rejected patch returns the ORIGINAL settings plus an `issue` so the channel
 * can refuse without persisting anything.
 */
export function applyCustomisePatch(
  settings: CampaignGuideSettings,
  patch: CampaignCustomisePatch,
  route: CampaignRouteFile,
  now: () => number = Date.now,
): { settings: CampaignGuideSettings; issue?: string } {
  const next = cloneSettings(settings);
  const c = next.customisations;
  switch (patch.op) {
    case "hide-objective": {
      pushUnique(c.hiddenObjectiveIds, patch.id);
      return { settings: next };
    }
    case "restore-objective": {
      c.hiddenObjectiveIds = c.hiddenObjectiveIds.filter((id) => id !== patch.id);
      return { settings: next };
    }
    case "hide-area": {
      pushUnique(c.hiddenAreaIds, patch.id);
      return { settings: next };
    }
    case "restore-area": {
      c.hiddenAreaIds = c.hiddenAreaIds.filter((id) => id !== patch.id);
      return { settings: next };
    }
    case "move-area": {
      if (!patch.actKey || !Array.isArray(patch.orderedIds)) return { settings, issue: "move-area: bad payload" };
      c.areaOrder[patch.actKey] = dedupe(patch.orderedIds.map((id) => String(id)));
      return { settings: next };
    }
    case "move-objective": {
      if (!patch.areaId || !Array.isArray(patch.orderedIds)) {
        return { settings, issue: "move-objective: bad payload" };
      }
      c.objectiveOrder[patch.areaId] = dedupe(patch.orderedIds.map((id) => String(id)));
      return { settings: next };
    }
    case "set-note": {
      const note = cleanText(patch.note, CAMPAIGN_LIMITS.noteChars);
      if (note) c.areaNotes[patch.areaId] = note;
      else delete c.areaNotes[patch.areaId];
      return { settings: next };
    }
    case "add-objective": {
      const known = new Set([...bundledAreaIds(route), ...c.customAreas.map((area) => area.id)]);
      if (!known.has(patch.areaId)) return { settings, issue: `add-objective: unknown area ${patch.areaId}` };
      const objective = sanitizeCustomObjective(
        { ...patch.objective, id: newObjectiveId(now), verified: false },
        patch.areaId,
        0,
      );
      if (!objective) return { settings, issue: "add-objective: a title is required" };
      const list = c.customObjectives[patch.areaId] ?? [];
      if (list.length >= CAMPAIGN_LIMITS.objectivesPerArea) {
        return { settings, issue: `add-objective: ${patch.areaId} already has the maximum number of objectives` };
      }
      list.push(objective);
      c.customObjectives[patch.areaId] = list;
      return { settings: next };
    }
    case "edit-objective": {
      const sanitized = sanitizeObjectiveOverrides({ [patch.id]: patch.patch })[patch.id];
      if (!sanitized) return { settings, issue: "edit-objective: nothing to change" };
      // A custom objective is edited in place so export/import stays lossless.
      for (const [areaId, list] of Object.entries(c.customObjectives)) {
        const index = list.findIndex((objective) => objective.id === patch.id);
        if (index >= 0) {
          c.customObjectives[areaId][index] = { ...list[index], ...sanitized, verified: false };
          return { settings: next };
        }
      }
      c.objectiveOverrides[patch.id] = { ...(c.objectiveOverrides[patch.id] ?? {}), ...sanitized };
      return { settings: next };
    }
    case "delete-objective": {
      if (bundledObjectiveIds(route).has(patch.id)) {
        return { settings, issue: `delete-objective: ${patch.id} is bundled — hide it instead` };
      }
      let removed = false;
      for (const [areaId, list] of Object.entries(c.customObjectives)) {
        const kept = list.filter((objective) => objective.id !== patch.id);
        if (kept.length !== list.length) removed = true;
        if (kept.length) c.customObjectives[areaId] = kept;
        else delete c.customObjectives[areaId];
      }
      if (!removed) return { settings, issue: `delete-objective: unknown objective ${patch.id}` };
      delete c.objectiveOverrides[patch.id];
      delete next.progress.done[patch.id];
      return { settings: next };
    }
    case "add-area": {
      const known = new Set([...bundledAreaIds(route), ...c.customAreas.map((area) => area.id)]);
      const id = cleanText(patch.area?.id, 40);
      if (!AREA_ID.test(id)) return { settings, issue: "add-area: invalid area id" };
      if (known.has(id)) return { settings, issue: `add-area: ${id} already exists` };
      if (c.customAreas.length >= CAMPAIGN_LIMITS.areas) {
        return { settings, issue: "add-area: too many custom areas" };
      }
      const objectives = (patch.area.objectives ?? []).map((objective, index) => ({
        ...objective,
        id: `${id}.c${index}`,
        verified: false,
      }));
      const area = sanitizeCustomArea({ ...patch.area, id, objectives });
      if (!area) return { settings, issue: "add-area: invalid area" };
      c.customAreas.push(area);
      return { settings: next };
    }
    case "edit-area": {
      const known = new Set([...bundledAreaIds(route), ...c.customAreas.map((area) => area.id)]);
      if (!known.has(patch.id)) return { settings, issue: `edit-area: unknown area ${patch.id}` };
      const sanitized = sanitizeAreaOverrides({ [patch.id]: patch.patch })[patch.id];
      if (!sanitized) return { settings, issue: "edit-area: nothing to change" };
      if (sanitized.exits) {
        const unknown = sanitized.exits.filter((exit) => !known.has(exit));
        if (unknown.length) return { settings, issue: `edit-area: unknown exit ${unknown[0]}` };
      }
      const customIndex = c.customAreas.findIndex((area) => area.id === patch.id);
      if (customIndex >= 0) {
        c.customAreas[customIndex] = { ...c.customAreas[customIndex], ...sanitized, verified: false };
        return { settings: next };
      }
      c.areaOverrides[patch.id] = { ...(c.areaOverrides[patch.id] ?? {}), ...sanitized };
      return { settings: next };
    }
    case "delete-area": {
      if (bundledAreaIds(route).has(patch.id)) {
        return { settings, issue: `delete-area: ${patch.id} is bundled — hide it instead` };
      }
      const kept = c.customAreas.filter((area) => area.id !== patch.id);
      if (kept.length === c.customAreas.length) {
        return { settings, issue: `delete-area: unknown area ${patch.id}` };
      }
      c.customAreas = kept;
      delete c.areaOverrides[patch.id];
      delete c.areaNotes[patch.id];
      delete c.customObjectives[patch.id];
      delete c.objectiveOrder[patch.id];
      delete next.progress.visited[patch.id];
      return { settings: next };
    }
    case "set-done": {
      // `sanitizeProgress` drops a `done` entry whose stamp will not parse, so
      // accepting one here would show a tick that vanishes on the next
      // normalize. An unparseable stamp falls back to "now" instead.
      const stamp = cleanText(patch.at, 40);
      const at = stamp && Number.isFinite(Date.parse(stamp)) ? stamp : new Date(now()).toISOString();
      if (patch.done) {
        next.progress.done[patch.id] = at;
        next.progress.undone = next.progress.undone.filter((id) => id !== patch.id);
      } else {
        delete next.progress.done[patch.id];
        pushUnique(next.progress.undone, patch.id);
      }
      return { settings: next };
    }
    case "reset": {
      if (patch.what === "progress" || patch.what === "all") {
        next.progress = { visited: {}, done: {}, undone: [] };
      }
      if (patch.what === "customisations" || patch.what === "all") {
        next.customisations = emptyCampaignCustomisations();
      }
      return { settings: next };
    }
    default: {
      const op = (patch as { op?: unknown }).op;
      return { settings, issue: `unknown op ${String(op)}` };
    }
  }
}

/**
 * Records a visit (first visit wins so the trail keeps its order) and
 * auto-completes every `reach` objective whose target is now visited.
 *
 * ONLY route areas are recorded. A hideout, a map or a league area passes the
 * plain id check, and recording those would churn the settings file on every
 * portal AND evict real act visits once the 500-entry cap is reached (§7.5
 * scopes progress to the route).
 */
export function recordVisit(
  settings: CampaignGuideSettings,
  areaId: string,
  at: string,
  route: CampaignRouteFile,
): { settings: CampaignGuideSettings; changed: boolean } {
  const merged = mergeCampaignRoute(route, settings);
  const parts = campaignIdParts(areaId);
  const stripped = parts?.stripped ?? areaId;
  const canonical = merged.aliasIndex[areaId] ?? merged.aliasIndex[stripped] ?? stripped;
  if (!AREA_ID.test(canonical)) return { settings, changed: false };
  // A route area is one the merged route knows (bundled or the user's own) or
  // one whose id reads as a campaign id (an act area the route lacks yet).
  // Everything else — hideouts, maps, league areas — is not progress.
  if (!merged.areaIndex[canonical] && !parts) return { settings, changed: false };
  const stamp = cleanText(at, 40) || new Date().toISOString();

  let changed = false;
  const next = cloneSettings(settings);
  const existing = next.progress.visited[canonical];
  if (!existing || Date.parse(stamp) < Date.parse(existing)) {
    next.progress.visited[canonical] = stamp;
    changed = true;
  }
  // Trim to the newest N so the settings document stays small.
  const entries = Object.entries(next.progress.visited);
  if (entries.length > CAMPAIGN_LIMITS.visited) {
    entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    next.progress.visited = Object.fromEntries(entries.slice(0, CAMPAIGN_LIMITS.visited));
    changed = true;
  }

  const isVisited = (id: string): boolean => {
    const target = merged.aliasIndex[id] ?? id;
    return Boolean(next.progress.visited[target] ?? next.progress.visited[id]);
  };
  for (const act of merged.acts) {
    for (const area of act.areas) {
      for (const objective of area.objectives) {
        if (objective.kind !== "reach" || !objective.targetAreaId) continue;
        if (next.progress.undone.includes(objective.id)) continue;
        if (next.progress.done[objective.id]) continue;
        if (!isVisited(objective.targetAreaId)) continue;
        next.progress.done[objective.id] = stamp;
        changed = true;
      }
    }
  }
  return changed ? { settings: next, changed: true } : { settings, changed: false };
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function objectiveFromMerged(objective: MergedObjective): CampaignObjective {
  const out: CampaignObjective = {
    id: objective.id,
    title: objective.title,
    kind: objective.kind,
    rewards: [...objective.rewards],
    verified: false,
  };
  if (objective.detail) out.detail = objective.detail;
  if (objective.targetAreaId) out.targetAreaId = objective.targetAreaId;
  if (objective.optional) out.optional = true;
  return out;
}

function areaFromMerged(area: MergedArea): CampaignArea {
  const out: CampaignArea = {
    id: area.id,
    name: area.name,
    part: area.part,
    act: area.act,
    level: area.level,
    exits: [...area.exits],
    objectives: area.objectives.map(objectiveFromMerged),
    verified: false,
  };
  if (area.aliases?.length) out.aliases = [...area.aliases];
  if (area.town) out.town = true;
  if (area.waypoint) out.waypoint = true;
  if (area.branch) out.branch = true;
  if (area.notes) out.notes = area.notes;
  if (area.wiki) out.wiki = area.wiki;
  return out;
}

/** Pretty `CampaignRouteFile` JSON of the merged route (corrections folded in). */
export function exportMergedRoute(merged: MergedRoute, base: CampaignRouteFile): string {
  const file: CampaignRouteFile = {
    schemaVersion: CAMPAIGN_ROUTE_SCHEMA_VERSION,
    source: base.source || "community",
    updatedAt: base.updatedAt,
    communityNote: merged.communityNote,
    acts: merged.acts.map((act) => {
      const out: CampaignAct = {
        part: act.part,
        act: act.act,
        name: act.name,
        areas: act.areas.map(areaFromMerged),
      };
      if (act.townId) out.townId = act.townId;
      return out;
    }),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Folds an imported route into customisations: a diff against the bundled
 * entries, never a replacement of the bundled file. An import never deletes
 * (bundled ids missing from it are left alone).
 */
export function importRouteAsCustomisations(
  imported: CampaignRouteFile,
  base: CampaignRouteFile,
  current: CampaignCustomisations,
  mode: "replace-customisations" | "merge",
): { customisations: CampaignCustomisations; issues: string[]; areas: number; objectives: number } {
  const issues: string[] = [];
  const start: CampaignCustomisations =
    mode === "merge"
      ? sanitizeCampaignCustomisations(JSON.parse(JSON.stringify(current)))
      : emptyCampaignCustomisations();
  const bundledAreas = new Map<string, CampaignArea>();
  for (const act of base.acts) for (const area of act.areas) bundledAreas.set(area.id, area);
  const baseActKeys = new Set(base.acts.map((act) => actKey(act.part, act.act)));

  let areaChanges = 0;
  let objectiveChanges = 0;
  const keep = <T>(existing: T | undefined, next: T): T => (mode === "merge" && existing !== undefined ? existing : next);

  for (const act of imported.acts) {
    for (const area of act.areas) {
      const bundled = bundledAreas.get(area.id);
      if (!bundled) {
        if (!start.customAreas.some((entry) => entry.id === area.id)) {
          start.customAreas.push({ ...area, verified: false, objectives: area.objectives.map((o) => ({ ...o, verified: false })) });
          areaChanges += 1;
          objectiveChanges += area.objectives.length;
          // Where it landed is not obvious in the UI, so say it.
          if (!baseActKeys.has(actKey(area.part, area.act))) {
            issues.push(
              `${area.id}: ${actLabel(area.part, area.act)} is not in the bundled route — it gets its own section`,
            );
          }
        } else if (mode === "merge") {
          issues.push(`${area.id}: already one of your areas — left as it is`);
        }
        continue;
      }
      const patch: CampaignCustomisations["areaOverrides"][string] = {};
      if (!sameValue(area.name, bundled.name)) patch.name = area.name;
      if (area.level !== bundled.level) patch.level = area.level;
      if (!sameValue(area.exits, bundled.exits)) patch.exits = [...area.exits];
      if (!sameValue(area.aliases ?? [], bundled.aliases ?? [])) patch.aliases = [...(area.aliases ?? [])];
      if (Boolean(area.town) !== Boolean(bundled.town)) patch.town = Boolean(area.town);
      if (Boolean(area.waypoint) !== Boolean(bundled.waypoint)) patch.waypoint = Boolean(area.waypoint);
      if (Boolean(area.branch) !== Boolean(bundled.branch)) patch.branch = Boolean(area.branch);
      if (!sameValue(area.notes ?? "", bundled.notes ?? "")) patch.notes = area.notes ?? "";
      if (!sameValue(area.wiki ?? "", bundled.wiki ?? "") && area.wiki) patch.wiki = area.wiki;
      if (Object.keys(patch).length) {
        start.areaOverrides[area.id] = keep(start.areaOverrides[area.id], patch);
        areaChanges += 1;
      }

      const bundledObjectives = new Map(bundled.objectives.map((objective) => [objective.id, objective]));
      for (const objective of area.objectives) {
        const original = bundledObjectives.get(objective.id);
        if (!original) {
          const list = start.customObjectives[area.id] ?? [];
          if (!list.some((entry) => entry.id === objective.id)) {
            list.push({ ...objective, verified: false });
            start.customObjectives[area.id] = list;
            objectiveChanges += 1;
          }
          continue;
        }
        const patchO: CampaignCustomisations["objectiveOverrides"][string] = {};
        if (objective.title !== original.title) patchO.title = objective.title;
        if (objective.kind !== original.kind) patchO.kind = objective.kind;
        if (!sameValue(objective.rewards, original.rewards)) patchO.rewards = [...objective.rewards];
        if (!sameValue(objective.detail ?? "", original.detail ?? "")) patchO.detail = objective.detail ?? "";
        if (!sameValue(objective.targetAreaId, original.targetAreaId) && objective.targetAreaId) {
          patchO.targetAreaId = objective.targetAreaId;
        }
        if (Boolean(objective.optional) !== Boolean(original.optional)) patchO.optional = Boolean(objective.optional);
        if (Object.keys(patchO).length) {
          start.objectiveOverrides[objective.id] = keep(start.objectiveOverrides[objective.id], patchO);
          objectiveChanges += 1;
        }
      }
    }
  }

  const customisations = sanitizeCampaignCustomisations(start);
  const dropped = start.customAreas.length - customisations.customAreas.length;
  if (dropped > 0) {
    issues.push(
      `${dropped} imported area(s) were dropped: invalid, or past the ${CAMPAIGN_LIMITS.areas}-area limit`,
    );
  }
  return { customisations, issues, areas: areaChanges, objectives: objectiveChanges };
}
