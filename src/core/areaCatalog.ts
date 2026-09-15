/**
 * Area id → display info for the ids Path of Exile 2 writes in its
 * "Generating level N area" lines.
 *
 * The table covers every id observed in a real 398 MB Client.txt (acts 1–4
 * `G<act>_*`, the second campaign half `P<act>_*`, legacy Cruel `C_G*`,
 * towns, hideouts, maps, league mechanics). Campaign display names are the
 * in-game names where known; ids whose name we could not confirm keep a
 * humanized name and `unverified: true` so a UI can show them honestly.
 * `level` is the typical monster level seen in the log (an experience
 * helper compares it with the character level).
 *
 * Anything not in the table is humanized: "MapSunTemple" → "Sun Temple"
 * (category "map"), "HideoutCanal" → "Canal Hideout", and so on.
 */
import type { AreaCategory, AreaInfo } from "./clientLog.js";

export type KnownArea = Omit<AreaInfo, "id">;

function campaign(act: number, name: string, level: number, extra: Partial<KnownArea> = {}): KnownArea {
  return { name, category: "campaign", act, part: 1, level, ...extra };
}

function town(act: number, name: string, level: number, extra: Partial<KnownArea> = {}): KnownArea {
  return { name, category: "town", act, part: 1, level, ...extra };
}

const ACT1: Record<string, KnownArea> = {
  G1_1: campaign(1, "The Riverbank", 1),
  G1_2: campaign(1, "Clearfell", 2),
  G1_3: campaign(1, "Mud Burrow", 3),
  G1_4: campaign(1, "The Grelwood", 4),
  G1_5: campaign(1, "The Red Vale", 5),
  G1_6: campaign(1, "The Grim Tangle", 6),
  G1_7: campaign(1, "Cemetery of the Eternals", 7),
  G1_8: campaign(1, "Mausoleum of the Praetor", 9),
  G1_9: campaign(1, "Tomb of the Consort", 9),
  G1_11: campaign(1, "Hunting Grounds", 10),
  G1_12: campaign(1, "Freythorn", 11),
  G1_13_1: campaign(1, "Ogham Farmlands", 12),
  G1_13_2: campaign(1, "Ogham Village", 13),
  G1_14: campaign(1, "The Manor Ramparts", 14),
  G1_15: campaign(1, "Ogham Manor", 15),
  G1_town: town(1, "Clearfell Encampment", 15),
};

const ACT2: Record<string, KnownArea> = {
  G2_1: campaign(2, "Vastiri Outskirts", 16),
  G2_10_1: campaign(2, "Mawdun Quarry", 17),
  G2_10_2: campaign(2, "Mawdun Mine", 18),
  G2_2: campaign(2, "Traitor's Passage", 19),
  G2_3: campaign(2, "The Halani Gates", 20),
  G2_3a: campaign(2, "The Halani Gates (crossing)", 20, { unverified: true }),
  G2_4_1: campaign(2, "Keth", 21),
  G2_4_2: campaign(2, "The Lost City", 22),
  G2_4_3: campaign(2, "Buried Shrines", 23),
  G2_5_1: campaign(2, "Mastodon Badlands", 26),
  G2_5_2: campaign(2, "The Bone Pits", 27),
  G2_6: campaign(2, "Valley of the Titans", 26),
  G2_7: campaign(2, "The Titan Grotto", 27),
  G2_8: campaign(2, "Deshar", 28),
  G2_9_1: campaign(2, "Path of Mourning", 29),
  G2_9_2: campaign(2, "The Spires of Deshar", 30),
  G2_12: campaign(2, "The Dreadnought", 31),
  G2_12_1: campaign(2, "The Dreadnought", 31),
  G2_12_2: campaign(2, "Dreadnought Vanguard", 32),
  G2_13: campaign(2, "Trial of the Sekhemas", 22),
  G2_town: town(2, "The Ardura Caravan", 32),
};

const ACT3: Record<string, KnownArea> = {
  G3_1: campaign(3, "Sandswept Marsh", 33),
  G3_3: campaign(3, "Jungle Ruins", 34),
  G3_2_1: campaign(3, "Infested Barrens", 35),
  G3_4: campaign(3, "The Venom Crypts", 35),
  G3_5: campaign(3, "The Azak Bog", 36),
  G3_7: campaign(3, "Chimeral Wetlands", 36),
  G3_6_1: campaign(3, "Jiquani's Machinarium", 37),
  G3_6_2: campaign(3, "Jiquani's Sanctum", 38),
  G3_10_Airlock: campaign(3, "The Temple of Chaos", 38),
  G3_10: campaign(3, "Trial of Chaos", 38),
  G3_2_2: campaign(3, "The Matlan Waterways", 39),
  G3_8: campaign(3, "The Drowned City", 40),
  G3_9: campaign(3, "Molten Vault", 41, { unverified: true }),
  G3_11: campaign(3, "Apex of Filth", 41, { unverified: true }),
  G3_12: campaign(3, "Utzaal", 42),
  G3_14: campaign(3, "Aggorat", 43),
  G3_16: campaign(3, "The Black Chambers", 44),
  G3_17: campaign(3, "Act 3 area 17", 45, { unverified: true }),
  G3_town: town(3, "Ziggurat Encampment", 44),
};

const ACT4: Record<string, KnownArea> = {
  G4_1_1: campaign(4, "Act 4 area 1-1", 46, { unverified: true }),
  G4_1_2: campaign(4, "Act 4 area 1-2", 47, { unverified: true }),
  G4_2_1: campaign(4, "Act 4 area 2-1", 46, { unverified: true }),
  G4_2_2: campaign(4, "Act 4 area 2-2", 47, { unverified: true }),
  G4_3_1: campaign(4, "Act 4 area 3-1", 50, { unverified: true }),
  G4_3_2: campaign(4, "Act 4 area 3-2", 51, { unverified: true }),
  G4_4_1: campaign(4, "Act 4 area 4-1", 51, { unverified: true }),
  G4_4_2: campaign(4, "Act 4 area 4-2", 49, { unverified: true }),
  G4_4_3: campaign(4, "Act 4 area 4-3", 51, { unverified: true }),
  G4_5_1: campaign(4, "Act 4 area 5-1", 51, { unverified: true }),
  G4_5_2: campaign(4, "Act 4 area 5-2", 52, { unverified: true }),
  G4_7: campaign(4, "Act 4 area 7", 46, { unverified: true }),
  G4_8a: campaign(4, "Act 4 area 8a", 52, { unverified: true }),
  G4_8b: campaign(4, "Act 4 area 8b", 52, { unverified: true }),
  G4_10: campaign(4, "Act 4 area 10", 52, { unverified: true }),
  G4_11_1a: campaign(4, "Act 4 area 11-1a", 53, { unverified: true }),
  G4_11_1b: campaign(4, "Act 4 area 11-1b", 53, { unverified: true }),
  G4_11_2: campaign(4, "Act 4 area 11-2", 53, { unverified: true }),
  G4_13: campaign(4, "Act 4 area 13", 53, { unverified: true }),
  G4_town: town(4, "Ngakanu", 53, { unverified: true }),
};

/** The second campaign half (`P<act>_*`, levels 54–64; towns at 64). */
function part2(act: number, n: string, level: number): KnownArea {
  return { name: `Part 2 act ${act} area ${n}`, category: "campaign", act, part: 2, level, unverified: true };
}

const PART2: Record<string, KnownArea> = {
  P1_1: part2(1, "1", 54),
  P1_2: part2(1, "2", 61),
  P1_3: part2(1, "3", 55),
  P1_4: part2(1, "4", 55),
  P1_5: part2(1, "5", 56),
  P1_6: part2(1, "6", 64),
  P1_Town: { name: "Part 2 act 1 town", category: "town", act: 1, part: 2, level: 64, unverified: true },
  P2_1: part2(2, "1", 61),
  P2_2: part2(2, "2", 59),
  P2_3: part2(2, "3", 62),
  P2_5: part2(2, "5", 60),
  P2_6: part2(2, "6", 63),
  P2_7: part2(2, "7", 63),
  P2_Town: { name: "Part 2 act 2 town", category: "town", act: 2, part: 2, level: 64, unverified: true },
  P3_1: part2(3, "1", 61),
  P3_2: part2(3, "2", 58),
  P3_3: part2(3, "3", 59),
  P3_4: part2(3, "4", 55),
  P3_5: part2(3, "5", 60),
  P3_6: part2(3, "6", 56),
  P3_7: part2(3, "7", 63),
  P3_Town: { name: "Part 2 act 3 town", category: "town", act: 3, part: 2, level: 64, unverified: true },
};

/**
 * Legacy Cruel (`C_G<act>_*`): the older second difficulty, still present in
 * old log entries. Same areas as acts 1–3 at levels 45–64.
 */
const CRUEL_LEVELS: Record<string, number> = {
  C_G1_1: 45, C_G1_2: 45, C_G1_3: 46, C_G1_4: 46, C_G1_5: 47, C_G1_6: 47, C_G1_7: 47, C_G1_8: 48,
  C_G1_9: 48, C_G1_11: 49, C_G1_12: 49, C_G1_13_1: 49, C_G1_13_2: 50, C_G1_14: 50, C_G1_15: 51,
  C_G1_town: 51,
  C_G2_1: 51, C_G2_10_1: 51, C_G2_10_2: 52, C_G2_2: 52, C_G2_3: 53, C_G2_3a: 53, C_G2_4_1: 54,
  C_G2_4_2: 55, C_G2_4_3: 55, C_G2_5_1: 53, C_G2_5_2: 54, C_G2_6: 55, C_G2_7: 56, C_G2_8: 56,
  C_G2_9_1: 56, C_G2_9_2_: 57, C_G2_12_1: 57, C_G2_12_2: 57, C_G2_town: 57,
  C_G3_1: 58, C_G3_3: 58, C_G3_2_1: 59, C_G3_4: 59, C_G3_5: 59, C_G3_6_1: 60, C_G3_6_2: 60,
  C_G3_7: 60, C_G3_10_Airlock: 60, C_G3_2_2: 61, C_G3_8: 61, C_G3_11: 61, C_G3_12: 62, C_G3_14: 62,
  C_G3_16_: 63, C_G3_17: 64, C_G3_town: 64,
};

function cruelTable(): Record<string, KnownArea> {
  const base: Record<string, KnownArea> = { ...ACT1, ...ACT2, ...ACT3 };
  const out: Record<string, KnownArea> = {};
  for (const [id, level] of Object.entries(CRUEL_LEVELS)) {
    const normalId = id.slice(2).replace(/_$/, "");
    const source = base[normalId];
    out[id] = source
      ? { ...source, name: `${source.name} (Cruel)`, level, part: 2, isCruel: true }
      : {
          name: `Cruel act ${normalId.charAt(1)} area ${normalId.slice(3)}`,
          category: "campaign",
          act: Number(normalId.charAt(1)),
          part: 2,
          level,
          isCruel: true,
          unverified: true,
        };
  }
  return out;
}

const LEAGUE: Record<string, KnownArea> = {
  G_Endgame_Town: { name: "The Ziggurat Refuge", category: "endgame-town", level: 65 },
  BreachDomain_01: { name: "Twisted Domain", category: "league" },
  Abyss_Intro: { name: "Abyss (introduction)", category: "league" },
  Abyss_Hub: { name: "Abyss hub", category: "league" },
  Abyss_Depths1: { name: "Abyssal Depths 1", category: "league" },
  Abyss_Depths2: { name: "Abyssal Depths 2", category: "league" },
  Abyss_Depths3: { name: "Abyssal Depths 3", category: "league" },
  Abyss_Boss1: { name: "Abyss boss 1", category: "league" },
  Abyss_Boss2: { name: "Abyss boss 2", category: "league" },
  Abyss_Pinnacle: { name: "Abyss pinnacle", category: "league" },
  ChayulaLeague: { name: "Chayula league area", category: "league" },
  ChayulaLeague_Tower: { name: "Chayula tower", category: "league" },
  ChayulaLeague_TowerBoss: { name: "Chayula tower boss", category: "league" },
  Delirium_Act1Town: { name: "Delirium: Clearfell Encampment", category: "league" },
  Delirium_Act1Town_Quest: { name: "Delirium: Clearfell Encampment (quest)", category: "league" },
  Delirium_HungerBoss: { name: "Delirium: Hunger boss", category: "league" },
  ExpeditionLeagueBoss: { name: "Expedition league boss", category: "league" },
  ExpeditionLogBook_Atoll: { name: "Logbook: Atoll", category: "league" },
  ExpeditionLogBook_Basin: { name: "Logbook: Basin", category: "league" },
  ExpeditionLogBook_Reef: { name: "Logbook: Reef", category: "league" },
  ExpeditionLogBook_Tropical: { name: "Logbook: Tropical", category: "league" },
  ExpeditionLogBook_Tundra: { name: "Logbook: Tundra", category: "league" },
  ExpeditionLogBook_Wastes: { name: "Logbook: Wastes", category: "league" },
  ExpeditionSubArea_Kalguur_Act1: { name: "Expedition: Kalguur camp (act 1)", category: "league" },
  ExpeditionSubArea_MedvedBoss: { name: "Expedition: Medved", category: "league" },
  ExpeditionSubArea_OlrothBoss: { name: "Expedition: Olroth", category: "league" },
  ExpeditionSubArea_UhtredBoss: { name: "Expedition: Uhtred", category: "league" },
  ExpeditionSubArea_VoranaBoss: { name: "Expedition: Vorana", category: "league" },
  IncursionHub: { name: "Incursion hub", category: "league" },
  IncursionHubEndgame: { name: "Incursion hub (endgame)", category: "league" },
  IncursionTemple: { name: "Temple of Atzoatl", category: "league" },
  IncursionTemplePresent: { name: "Temple of Atzoatl (present)", category: "league" },
  RitualLeagueBoss: { name: "Ritual league boss", category: "league" },
};

export const KNOWN_AREAS: Record<string, KnownArea> = {
  ...ACT1,
  ...ACT2,
  ...ACT3,
  ...ACT4,
  ...PART2,
  ...cruelTable(),
  ...LEAGUE,
};

const CAMPAIGN_ID = /^(?:C_)?G(\d+)_|^P(\d+)_/;

/** `G<act>_*`, `P<part>_*`, `C_G*` — towns included. */
export function isCampaignArea(id: string): boolean {
  return CAMPAIGN_ID.test(id);
}

const SMALL_WORDS = new Set(["of", "the", "and", "in", "at"]);

/** "BeaconOfSalvation" → "Beacon of Salvation"; "Merchant03_Raft" → "Merchant 03 Raft". */
export function humanizeAreaToken(token: string): string {
  const words = token
    .replace(/_+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => (index > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word))
    .join(" ");
}

/**
 * "HideoutCanal" → "Canal Hideout"; "MapHideoutShoreline_Claimable" →
 * "Shoreline Hideout (claimable)". The `MapHideout*` ids are the claimable
 * hideouts the game generates as map-like areas (observed
 * "MapHideoutShoreline_Claimable" at level 46) — they are hideouts, not maps.
 */
function humanizeHideout(id: string): string {
  const rest = id.replace(/^Map/, "").replace(/^Hideout_?/, "");
  const claimable = /_Claimable$/i.exec(rest);
  const base = claimable ? rest.slice(0, claimable.index) : rest;
  return `${humanizeAreaToken(base)} Hideout${claimable ? " (claimable)" : ""}`;
}

function humanizeMap(id: string): string {
  let rest = id.replace(/^Map_?/, "");
  const uber = /^UberBoss_(.+)$/.exec(rest);
  if (uber) return `Uber Boss: ${humanizeAreaToken(uber[1])}`;
  const noBoss = /^(.*?)_NoBoss$/i.exec(rest);
  if (noBoss) return `${humanizeAreaToken(noBoss[1])} (no boss)`;
  const unique = /^Unique(.+)$/.exec(rest);
  if (unique) return `Unique: ${humanizeAreaToken(unique[1])}`;
  return humanizeAreaToken(rest);
}

function humanizeCampaign(id: string): { name: string; act: number; part: 1 | 2; isCruel: boolean } {
  const cruel = id.startsWith("C_");
  const match = /^(?:C_)?([GP])(\d+)_(.*)$/.exec(id);
  const act = match ? Number(match[2]) : 0;
  const rest = match ? match[3] : id;
  const kind = match?.[1] === "P" ? "Part 2 act" : cruel ? "Cruel act" : "Act";
  const isTown = /^town$/i.test(rest.replace(/_$/, ""));
  const name = isTown
    ? `${kind} ${act} town`
    : `${kind} ${act} area ${rest.replace(/_$/, "").replace(/_/g, "-")}`;
  return { name, act, part: match?.[1] === "P" || cruel ? 2 : 1, isCruel: cruel };
}

function categoryFor(id: string): AreaCategory {
  if (id === "G_Endgame_Town") return "endgame-town";
  if (/^Hideout/.test(id)) return "hideout";
  if (isCampaignArea(id)) return /_town$/i.test(id) ? "town" : "campaign";
  // Claimable hideouts are written as `MapHideout*`; they are hideouts, not
  // maps, so this must stay ahead of the `/^Map/` rule.
  if (/^MapHideout/.test(id)) return "hideout";
  if (/^Map/.test(id)) return "map";
  if (/^Sanctum_/.test(id)) return "sanctum";
  if (/^(Abyss|Breach|Delirium|Expedition|Chayula|Ritual|Incursion)/.test(id)) return "league";
  return "other";
}

/** Known table entry, else a humanized guess (never throws, never returns an empty name). */
export function areaInfo(areaId: string): AreaInfo {
  const known = KNOWN_AREAS[areaId];
  if (known) return { id: areaId, ...known };
  const category = categoryFor(areaId);
  switch (category) {
    case "hideout":
      return { id: areaId, name: humanizeHideout(areaId), category };
    case "map":
      return { id: areaId, name: humanizeMap(areaId), category };
    case "sanctum": {
      const match = /^Sanctum_(\d+)_(.+)$/.exec(areaId);
      const name = match
        ? `Trial of the Sekhemas floor ${match[1]}: ${humanizeAreaToken(match[2])}`
        : humanizeAreaToken(areaId);
      return { id: areaId, name, category };
    }
    case "campaign":
    case "town": {
      const guess = humanizeCampaign(areaId);
      return {
        id: areaId,
        name: guess.name,
        category,
        act: guess.act,
        part: guess.part,
        ...(guess.isCruel ? { isCruel: true } : {}),
        unverified: true,
      };
    }
    default:
      return { id: areaId, name: humanizeAreaToken(areaId) || areaId, category };
  }
}
