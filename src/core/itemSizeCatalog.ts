export interface ItemClassSizeDefault {
  itemClass: string;
  w: number;
  h: number;
}

export const CLASS_SIZE_DEFAULTS: readonly ItemClassSizeDefault[] = [
  { itemClass: "Currency", w: 1, h: 1 },
  { itemClass: "Stackable Currency", w: 1, h: 1 },
  { itemClass: "Omen", w: 1, h: 1 },
  { itemClass: "Trial Coins", w: 1, h: 1 },
  { itemClass: "Inscribed Ultimatum", w: 1, h: 1 },
  { itemClass: "Waystones", w: 1, h: 1 },
  { itemClass: "Tablet", w: 1, h: 1 },
  { itemClass: "Tablets", w: 1, h: 1 },
  { itemClass: "Wombgifts", w: 1, h: 1 },
  { itemClass: "Runes", w: 1, h: 1 },
  { itemClass: "Soul Cores", w: 1, h: 1 },
  { itemClass: "Augment", w: 1, h: 1 },
  { itemClass: "Pinnacle Keys", w: 1, h: 1 },
  { itemClass: "Map Fragments", w: 1, h: 1 },
  { itemClass: "Jewels", w: 1, h: 1 },
  { itemClass: "Gems", w: 1, h: 1 },
  { itemClass: "Skill Gems", w: 1, h: 1 },
  { itemClass: "Support Gems", w: 1, h: 1 },
  { itemClass: "Uncut Skill Gems", w: 1, h: 1 },
  { itemClass: "Uncut Support Gems", w: 1, h: 1 },
  { itemClass: "Uncut Spirit Gems", w: 1, h: 1 },
  { itemClass: "Charms", w: 1, h: 1 },
  { itemClass: "Relics", w: 1, h: 1 },
  { itemClass: "Rings", w: 1, h: 1 },
  { itemClass: "Amulets", w: 1, h: 1 },
  { itemClass: "Flasks", w: 1, h: 2 },
  { itemClass: "Life Flasks", w: 1, h: 2 },
  { itemClass: "Mana Flasks", w: 1, h: 2 },
  { itemClass: "Hybrid Flasks", w: 1, h: 2 },
  { itemClass: "Utility Flasks", w: 1, h: 2 },
  { itemClass: "Belts", w: 2, h: 1 },
  { itemClass: "Helmets", w: 2, h: 2 },
  { itemClass: "Gloves", w: 2, h: 2 },
  { itemClass: "Boots", w: 2, h: 2 },
  { itemClass: "Foci", w: 2, h: 2 },
  { itemClass: "Bucklers", w: 2, h: 2 },
  { itemClass: "Talismans", w: 2, h: 2 },
  { itemClass: "Body Armours", w: 2, h: 3 },
  { itemClass: "Shields", w: 2, h: 3 },
  { itemClass: "Quivers", w: 2, h: 3 },
  { itemClass: "Sceptres", w: 2, h: 3 },
  { itemClass: "Claws", w: 2, h: 3 },
  { itemClass: "Flails", w: 2, h: 3 },
  { itemClass: "One Hand Maces", w: 2, h: 3 },
  { itemClass: "One Handed Maces", w: 2, h: 3 },
  { itemClass: "One Hand Axes", w: 2, h: 3 },
  { itemClass: "One Handed Axes", w: 2, h: 3 },
  { itemClass: "One Hand Swords", w: 2, h: 3 },
  { itemClass: "One Handed Swords", w: 2, h: 3 },
  { itemClass: "Wands", w: 1, h: 3 },
  { itemClass: "Daggers", w: 1, h: 3 },
  { itemClass: "Staves", w: 2, h: 4 },
  { itemClass: "Quarterstaves", w: 2, h: 4 },
  { itemClass: "Two Hand Maces", w: 2, h: 4 },
  { itemClass: "Two Handed Maces", w: 2, h: 4 },
  { itemClass: "Two Hand Axes", w: 2, h: 4 },
  { itemClass: "Two Handed Axes", w: 2, h: 4 },
  { itemClass: "Two Hand Swords", w: 2, h: 4 },
  { itemClass: "Two Handed Swords", w: 2, h: 4 },
  { itemClass: "Bows", w: 2, h: 4 },
  { itemClass: "Crossbows", w: 2, h: 4 },
  { itemClass: "Spears", w: 1, h: 4 },
];

/** Base exceptions require independently confirmed physical cells. The live
 * 2026-09-14 capture confirmed Vaal Tower Shield across a complete 2x4 rectangle.
 * Other shield bases retain their existing class default. */
export function knownPhysicalItemSize(itemClass: string | undefined, baseType?: string): { w: number; h: number } | undefined {
  const key = sizeKey(itemClass ?? "");
  if (key === "shields" && sizeKey(baseType ?? "") === "vaal tower shield") return { w: 2, h: 4 };
  const size = CLASS_SIZE_DEFAULTS.find(entry => sizeKey(entry.itemClass) === key);
  return size ? { w: size.w, h: size.h } : undefined;
}

export function sizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
