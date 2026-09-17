import type { ItemMod } from './types.js';

/** High tier alone is insufficient for utility affixes and weak hybrid values. */
export function isCoreRingRoll(mod: ItemMod): boolean {
  if (/^\d+% increased Mana Regeneration Rate$/i.test(mod.text)) return (mod.value ?? 0) >= 40;
  return [
    /^\+\d+ to maximum (?:Life|Mana|Energy Shield)$/i,
    /^\d+% increased maximum (?:Life|Mana|Energy Shield)$/i,
    /^\d+% increased Rarity of Items found$/i,
    /^\d+% increased (?:Cast|Attack) Speed$/i,
    /^\+\d+% to (?:(?:Fire|Cold|Lightning|Chaos)(?: and (?:Fire|Cold|Lightning|Chaos))?|all Elemental) Resistances?$/i,
    /^\+\d+ to (?:Strength|Dexterity|Intelligence|all Attributes)$/i,
    /^Adds \d+ to \d+ (?:Physical|Fire|Cold|Lightning|Chaos) damage to Attacks$/i,
    /^\d+% increased (?:Physical|Fire|Cold|Lightning|Chaos|Elemental|Spell) Damage(?: with Attacks)?$/i,
    /^\d+% increased Critical (?:Hit Chance|Damage Bonus)$/i,
  ].some(pattern => pattern.test(mod.text));
}

/** Local screening policy, not a market-price model. Only explicit, observed T3/T4
 * rolls can contribute here; T1/T2 already qualify independently. */
export function ringSynergies(mods: readonly ItemMod[]): string[] {
  const candidates = mods.filter(m => m.observedTier && m.observedTier <= 4 && m.affixGroup !== undefined);
  const find = (pattern: RegExp, minimum = 0) => candidates.filter(m => pattern.test(m.text) && (m.value ?? 0) >= minimum);
  const life = find(/^\+\d+ to maximum Life$/i, 60);
  const lifeRegen = find(/^\d+(?:\.\d+)? Life Regeneration per second$/i, 8);
  const mana = find(/^\+\d+ to maximum Mana$/i, 100);
  const cast = find(/^\d+% increased Cast Speed$/i, 15);
  const regen = find(/^\d+% increased Mana Regeneration Rate$/i, 40);
  const intelligence = find(/^\+\d+ to Intelligence$/i, 25);
  const resist = find(/^\+\d+% to (?:Fire|Cold|Lightning|Chaos) Resistance$/i, 25);
  const distinct = (parts: ItemMod[][]) => {
    const choose = (index: number, chosen: ItemMod[]): boolean => index === parts.length
      ? chosen.filter(m => m.observedTier! <= 3).length >= 2
      : parts[index]!.some(mod => !chosen.some(m => m.affixGroup === mod.affixGroup) && choose(index + 1, [...chosen, mod]));
    return choose(0, []);
  };
  const results: string[] = [];
  if (distinct([mana, cast, [...regen, ...intelligence, ...life, ...resist]]))
    results.push('Caster synergy: substantial mana + cast speed + sustain, intelligence or defence across three affixes.');
  if (distinct([mana, regen, intelligence]))
    results.push('Mana synergy: substantial mana + mana regeneration + intelligence across three affixes.');
  if (distinct([life, lifeRegen, resist]))
    results.push('Life sustain synergy: life + meaningful regeneration + resistance across three affixes.');
  for (const a of resist) for (const b of resist) {
    if (a.text.match(/to (\w+) Resistance/i)?.[1] === b.text.match(/to (\w+) Resistance/i)?.[1]) continue;
    if (distinct([life, [a], [b]])) { results.push('Defensive synergy: life + two different substantial resistance affixes.'); break; }
  }
  const damage = find(/^Adds \d+ to \d+ (?:Physical|Fire|Cold|Lightning) damage to Attacks$/i);
  const attackSpeed = find(/^\d+% increased Attack Speed$/i);
  const elemental = find(/^\d+% increased Elemental Damage with Attacks$/i);
  const accuracy = find(/^\+\d+ to Accuracy Rating$/i, 150);
  const leech = find(/^Leech \d+(?:\.\d+)?% of Physical Attack Damage as (?:Life|Mana)$/i, 5);
  if (distinct([damage, attackSpeed, [...accuracy, ...life, ...resist]]) ||
      distinct([damage.filter(m => /Physical/i.test(m.text)), attackSpeed, leech]) ||
      distinct([damage.filter(m => !/Physical/i.test(m.text)), elemental, [...attackSpeed, ...accuracy, ...life, ...resist]]))
    results.push('Attack synergy: attack damage + compatible scaling + accuracy or defence across three affixes.');
  return [...new Set(results)];
}
