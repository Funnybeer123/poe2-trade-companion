# Value crafting

The crafting process turns bag items into more sellable items by applying
currency orbs only when the math says the step is profitable — and it only
acts unattended when its **confidence score** clears a gate.

Knowledge version: `CRAFT_KNOWLEDGE_VERSION` in
[`src/core/crafting.ts`](../src/core/crafting.ts) (bump it when re-research
changes the encoded rules).

## The process

For every item, one step at a time, then re-read and re-decide:

```
read item (Ctrl+C) → parse → appraise (0-100 value score)
  → planCraft(): pick ONE next action + EV + confidence
    → confidence ≥ gate AND additive AND +EV AND within budget?
        yes → apply orb, re-read, loop
        no  → print the recommendation and move on
```

Actions the planner can choose:

| Action        | When                                                        | Automated? |
| ------------- | ----------------------------------------------------------- | ---------- |
| `identify`    | item is unidentified                                        | no — identify first |
| `transmute`   | white base, archetype demand, ilvl ≥ 65                     | yes |
| `augment`     | magic with one affix                                        | yes |
| `regal`       | magic with 2 affixes, ≥ 1 on-archetype                      | yes |
| `exalt`       | rare with open affixes, coherent mods, +EV                  | yes |
| `chaos-swap`  | full rare, ≥ 3 strong mods, 1-2 duds                        | **never** — printed only |
| `annul`/`divine` | expensive fixes on near-finished items                   | **never** — printed only |
| `sell`        | score ≥ sell bar, or budget exhausted                       | n/a (stop) |
| `hold`/`skip` | not craft stock / needs a human                             | n/a (stop) |

Only **additive** orbs are ever automated: they can add cost, but they cannot
delete a mod. Removal (chaos, annulment), value rerolls (divine), and
corruption (vaal) are exactly the orbs the research warns can ruin an item,
so they're always a printed recommendation for a human.

## The confidence score (0-100)

Every plan carries an explained score; each adjustment appears in the plan's
reasons. Components:

- **Parse quality** — unparseable/unidentified text can't be crafted on.
- **Knowledge coverage** — does an archetype profile exist for the item
  class, and how many of its mods match the mod knowledge base
  (`src/core/modKnowledge.ts`)?
- **Action determinism** — additive ladder steps (+12..14) vs slams (+8) vs
  removal orbs (−10, and blacklisted from automation anyway).
- **EV margin** — how far above water the step's expected value is.
- **Item level** — ilvl ≥ 79 reaches top tiers (+5); low ilvl gear is
  skipped outright.

Bands mirror the appraisal engine: ≥ 85 very-high, ≥ 65 high, ≥ 40 medium.
The default auto gate is **70**; steps below it are printed, never applied.

## The economics encoded (patch 0.5 era, researched 2026-08-30)

- Magic = 1 prefix + 1 suffix; rare = 3 + 3. Exalted slams add one random
  affix; chaos removes one random and adds one random (PoE2 behaviour).
- Orb costs in exalted: **exalt = 1 (the base unit)**; everything else
  drifts hard through a league — on 2026-08-30 ("Runes of Aldur") the live
  numbers were chaos ≈ 36, annulment ≈ 153, divine ≈ 405, fracturing ≈ 3000,
  regal ≈ 0.26, transmute ≈ 0.17. Guide-derived defaults were 10x off, which
  is why the price feed (Sort → Prices → Refresh market prices) writes real
  poe2scout prices into the price table, and the table always overrides the
  baked-in defaults by orb name.
- Value is mod **coherence**: 3+ potent affixes serving one build archetype.
  The archetype profiles in `crafting.ts` encode which mod families sell per
  slot (life/res on armour, movement speed on boots, +skills/spirit on
  amulets and caster weapons, phys/attack-speed/crit on attack weapons…).
- Sale-value curve is convex (each coherent mod multiplies price):
  score 55 ≈ 1 ex, 70 ≈ 3 ex, 85 ≈ 7 ex, 100 ≈ 15 ex.
- Stop rules from the research: **sell at good enough** (chasing perfection
  costs more than the price difference), hard per-item budget (default 8 ex),
  and never target one specific finished item (expected cost runs 2-5× just
  buying it).
- No public mod-pool odds exist for PoE2, so per-slot slam success odds
  (`pGoodSlam`, 0.26-0.32) are conservative editable estimates — one reason
  the confidence score exists.
- Meta calibration (0.5 "Runes of Aldur" tier lists, 2026-08-30): Lightning
  Arrow Deadeye is the most-played build — bows/quivers now value
  **additional arrows** (a digitless chase mod), onslaught-on-kill, and flat
  elemental damage on gloves/rings; Foci and Quivers got their own archetype
  profiles; Energy Shield weight dropped (64 separate ES nerfs in 0.5 pushed
  ES stacking out of the meta); movement-speed boots, spirit amulets, and
  +skill items remain premium. `tests/meta-gear.test.ts` runs the whole
  pipeline through best-in-slot-style gear for the top builds to pin this.

Sources: [Maxroll crafting overview](https://maxroll.gg/poe2/resources/path-of-exile-2-crafting-overview),
[timesaver profit crafting guide](https://timesaver.gg/blog/poe2-profit-crafting-guide),
[PoE2 crafting codex](https://domistae.github.io/poe2-leveling/poe2_crafting_codex.html),
[Switchblade currency guide](https://www.switchbladegaming.com/path-of-exile-2/currency-guide/),
[MMOJUGG item tiers](https://www.mmojugg.com/news/understanding-item-tiers-in-poe2.html).

## Running it

```
npm run craft:gear             # dry-run against the live bag (default)
npm run craft:plan             # plan the one item on the clipboard, no game needed
npx tsx scripts/craft-gear.ts --from-file=items.txt
npm run craft:gear:live        # LIVE — applies orbs (see safety below)
```

In the app: **Sort → Run → Value crafting** — the button honours the global
Dry-run switch ("Preview crafting" vs "Craft gear").

Useful flags: `--budget=N` (ex per item), `--min-confidence=N`,
`--max-steps=N` (session cap), `--json`.

Requirements for the live bag modes: calibrated bag grid, stash+inventory
open, craft candidates AND the orbs together in the bag (orb stacks are
found by reading them, no extra calibration).

## Safety

- **Dry-run is the default.** Live needs `--live` *and* `POE2_CRAFT_LIVE=1`
  (the app's Craft gear button sets both deliberately).
- Live refuses to start while **any other input host is running** — it will
  never fight the sorting automation (or the app / action daemon) for the
  mouse.
- Numpad 5 pauses, numpad 0 stops, Ctrl+Shift+Esc latches everything.
- Every step (dry or live) lands in
  `artifacts/crafting/craft-journal.jsonl` with the confidence and score
  before/after.
- **Live crafting is untested** as of 2026-08-30 — the sorting automation
  was occupying the game. Test order when free: `craft:gear` (dry) →
  `craft:gear:live` with `--max-steps=1` and one cheap item → normal runs.
