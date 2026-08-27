import { createHash } from "node:crypto";
import type { NormalizedItem } from "./types.js";

type FingerprintInput = Omit<NormalizedItem, "fingerprint">;

function sortedModifiers(modifiers: FingerprintInput["modifiers"]): FingerprintInput["modifiers"] {
  return [...modifiers].sort((a, b) => {
    const text = a.text.localeCompare(b.text);
    if (text !== 0) {
      return text;
    }
    return (a.value ?? 0) - (b.value ?? 0);
  });
}

function sortedPseudos(pseudos: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(pseudos).sort((a, b) => a.localeCompare(b))) {
    out[key] = pseudos[key] ?? 0;
  }
  return out;
}

export function canonicalizeItem(item: FingerprintInput): string {
  return JSON.stringify({
    class: item.class ?? "",
    rarity: item.rarity ?? "",
    name: item.name ?? "",
    base: item.base ?? "",
    itemLevel: item.itemLevel ?? null,
    quality: item.quality ?? null,
    sockets: item.sockets ?? "",
    modifiers: sortedModifiers(item.modifiers),
    pseudos: sortedPseudos(item.pseudos),
    corrupted: item.corrupted === true,
    unidentified: item.unidentified === true,
  });
}

export function fingerprintItem(item: FingerprintInput): string {
  return createHash("sha256").update(canonicalizeItem(item), "utf8").digest("hex");
}

export function withFingerprint(item: FingerprintInput): NormalizedItem {
  return { ...item, fingerprint: fingerprintItem(item) };
}
