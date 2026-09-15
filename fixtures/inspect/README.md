# Inspect fixtures

Hand-authored item texts for the `inspect` package's offline tests. None of
these came from a live game session — they are written to the shapes the
parser already handles (`fixtures/items/rich-affixes.txt` is the one
observed advanced-description sample in the repo).

| File | What it exercises | Status |
|---|---|---|
| `advanced-rare-ring.txt` | Advanced description: annotation lines, `value(min-max)` ranges, prefix/suffix/tier/name, a crafted suffix | **UNVERIFIED for PoE2** — the `value(min-max)` form is how PoE1 printed advanced descriptions; replace with a live paste when one is captured |
| `plain-rare-ring.txt` | The same ring copied plainly: no sides, no ranges, tiers must come from the learned ladder | Shapes match observed PoE2 copies |
| `weapon-bow-elemental.txt` | Weapon DPS: physical + two elemental pairs attributed from `Adds # to #` lines, quality 12 % → the Q20 estimate | Property block shapes observed |
| `armour-quality-12.txt` | Defences at quality 12 % and a block chance | Observed |
| `waystone-t15-deadly.txt` | Map warnings: one deadly, one dangerous, two cautions, one info, one unrated line, plus the reward lines | Waystone modifier wording **UNVERIFIED** — it is the same source as `src/data/inspect/dangerousMapMods.ts` |
| `waystone-t3-clean.txt` | A waystone with no modifiers at all (overall `none`) | Observed |
| `tablet-precursor.txt` | Tablet kind detection and its "maps in range" wording | **UNVERIFIED** |
| `mirrored-rare.txt` | `Mirrored` as a bare status line (the parser reads it as a modifier; Inspect must not) | Observed |
| `unidentified-rare.txt` | Unidentified: no modifier rows, open affixes unknown | Observed |
| `learned-tiers-sample.json` | A small `LearnedTiers` store (maximum Life and Fire Resistance, with levels) so the tier ladder, roll percentage and "max tier at this item level" have real data | Shape matches `artifacts/tab-admin/mod-tiers.json` |

`fixtures/trade/stats-subset.json` is reused as the stat catalogue, so the
life and resistance lines resolve to the same ids the learned store uses.
