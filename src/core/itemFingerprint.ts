import type { NormalizedItem } from "./types.js";

export function fingerprintItem(item: Omit<NormalizedItem, "fingerprint">): string {
  const payload = JSON.stringify({
    itemClass: item.itemClass,
    rarity: item.rarity,
    name: item.name,
    baseType: item.baseType,
    itemLevel: item.itemLevel ?? null,
    mods: item.mods.map((m) => m.text),
  });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(2).slice(0, 16);
}
