# Build-aware item decisions

Research date **2026-09-14**. League **Forbidden Rites** (0.5.5 event league,
started 2026-09-04), patch **0.5.5b** (2026-09-10). Knowledge table version
`2026-09-14`, review by **2026-10-12**. Nothing here was verified against a
live game run or a completed sale; every threshold is marked as such.

The decision layer turns curated build demand into four distinguishable
outcomes for an identified item — **keep**, **list**, **review**,
**discard-eligible** — with the evidence behind each one and an auditable
discard check. It sits on top of the existing appraisal (mod families, price
table, saved price examples, value-tier rules) and never converts demand into
a price.

Code: `src/core/buildDemand.ts` (matcher), `src/core/itemDecision.ts`
(decision + `evaluateItemDecision`), `src/data/demand/buildDemand.ts` (the
knowledge table), `scripts/demand-shadow.ts` (offline replay). Tests:
`tests/build-demand.test.ts`, `tests/item-decision.test.ts`,
`tests/demand-eval-set.test.ts` with `fixtures/demand/eval-set.json`.

---

## 1. League and patch (primary sources)

| Fact | Source (retrieved 2026-09-14) |
|---|---|
| Forbidden Rites is the 0.5.5 event league, started 2026-09-04 1 PM PDT | GGG FAQ, forum thread 4000430 (2026-08-30) |
| Runes of Aldur (0.5.0, 2026-05-29) keeps running in parallel with its own economy; both end at 1.0 on 2026-12-11 | same FAQ; 1.0 announcement thread 3999366 (2026-08-25) |
| Current patch 0.5.5b (2026-09-10): bug fixes; 0.5.5 (2026-09-02) has **no** skill/passive/ascendancy balance section | patch-notes forum 2212, threads 4004106 and 4000864 |
| The trade API lists six PoE2 leagues; two softcore economies are live | `/api/trade2/data/leagues` |
| poe2scout flags both leagues `IsCurrent`; Divine ≈ 447 ex (Forbidden Rites) vs ≈ 573 ex (Runes of Aldur) | `api.poe2scout.com/poe2/Leagues` |

Consequences: the pinned league (`artifacts/tab-admin/price-feed.json`:
Forbidden Rites) is valid; "auto" must stay refused; the 0.5.x meta carried
straight into the event league. 0.5.0 (2026-05-22) nerfed energy-shield
recharge, not capacity, capped leech and raised base armour/evasion by a third.

## 2. Source registry (demand)

| id | Kind | Date | Strength | What it supports / limits |
|---|---|---|---|---|
| poe.ninja Forbidden Rites builds (`/poe2/builds/forbiddenrites`) | ladder | 2026-09-14 (no printed timestamp; league day 10) | strong | 112,971 characters: skill and ascendancy shares, weapon configurations, per-slot rare adoption. Top-of-ladder selection bias; utility gems inflate "main skill" counts; the builds API is closed to third parties, so it was read in a browser as a visitor and nothing was pulled programmatically. Prices nothing. |
| Maxroll build-guide index + 18 individual guides | guide | 2026-09-01 … 2026-09-13 | strong / medium | Per-slot mod priorities, budget → endgame splits, all labelled 0.5.5. Small creator pool; wording is the guide's. Each guide URL is in the knowledge table with its author and date. |
| Maxroll league-starter tier list (Crouching_Tuna) | guide | 2026-09-11 | medium | S–D tiers for 46 builds, no rationale, league-starter framing. |
| Mobalytics builds (featured cards) | guide | 2026-09-11 … 2026-09-14 | medium | Titles/dates only; its tier list is undated 0.5.0 text (not used for ordering); "Top Characters" is 38 creators. |
| PoE Vault Spark/Comet Stormweaver (Byankuu) | guide | 2026-09-10 | medium | Literal rolled values. |
| PoE Vault Impending Doom Gemling (Crix) | guide | 2026-09-07 | weak | High budget; skill absent from ladder filters. |
| GGG 0.5.0 / 0.5.5 patch notes, Forbidden Rites FAQ, trade leagues endpoint | first-party | 2026-05-22 … 2026-09-14 | strong | League/patch facts and balance context; no play statistics exist for 0.5.x. |
| rank1gear ExileCon race 2 write-up | community | 2026-08-17 | weak | Campaign SSF race result (Twister won; grenades 4 of 6). |
| LFCarry guide roundup | community | 2026-09-04 | weak | Quotes the 2026-08-12 Runes of Aldur snapshot as the pre-event baseline. |

Excluded as stale or unreadable: poe2.dev (snapshot 2025-02-27), the Maxroll
Boneshatter Smith of Kitava guide (0.3, 2025-12-12), the Mobalytics tier list
text (0.5.0 launch), reddit (blocked to the search tool), poe2wiki (anti-bot
wall, not bypassed), u4gm (403), the Exilecon ladder page (JS shell).

## 3. What "top builds" meant

Skill share on the Forbidden Rites ladder (count ÷ 112,971) was the primary
signal, cross-checked against creator guides dated inside the league. Class
share is misleading (Gemling Legionnaire is 38% of the ladder and 60–99% of
several skills), so build rows are keyed by skill and weapon. Popularity,
guide availability and demonstrated performance were kept apart: a build with
a Maxroll S tier but 0.3% of the ladder (Lightning Arrow) is recorded with
that share, not promoted.

Top of the ladder: Oil Grenade 15.6% / Flameblast 13.4% (ignite Gemling,
staff + crossbow), Twister 14.2% (spear), Entangle 9.4% (Oracle staff), Spark
7.7%, Ice Shot 7.4% (bow), Comet 6.8%, Grim Pillars 6.7%, Arc 6.6%, Explosive
Grenade 5.8%, Ice Nova 4.5%, Contagion 4.2%, Despair 4%, Gas Grenade 4%,
Martial Artist skills 2.4% / 2.2% / 1.2%, Shield Wall 1.3%. Rare items per
slot: rings 95%, jewels 95%, boots 89%, amulets 85%, gloves 82%, helmets 81%,
belts 63%, body armours 62%; weapons: rare sceptre 26%, staff 21%, crossbow
18%, wand 15%, spear 11%, bow 8%, quarterstaff 7%. **Chaos Inoculation is on
18% of characters**: energy shield is back at endgame, so the 2026-08-30
"ES left the meta" reading was wrong for this league and the mod-family
weight was raised again (life still outranks it).

## 4. Coverage matrix

| Archetype | Evidence | Builds in the table | Classes with patterns | Missing / uncertain |
|---|---|---|---|---|
| Bow attack | strong | Ice Shot Deadeye, Lightning Arrow (0.3%), Poisonburst | Bows, Quivers | rare quivers are 3% of the slot; DPS bars unverified |
| Crossbow attack | strong | Flameblast/Oil Grenade Gemling, Grenade Mercenaries, bolt skills | Crossbows | grenade-vs-Flameblast split not separable on the ladder |
| Quarterstaff / talisman | strong | Martial Artist melee | Quarterstaves, Talismans | Invoker nearly extinct (0.1%) |
| Spear | strong | Twister, Lightning Spear / Glacial Lance, Bleed Rake | Spears | rare spears compete with Skysliver / The Ordained |
| Maces + shield | moderate | Warrior maces | One/Two Hand Maces, Shields | no current endgame two-hand mace guide |
| Sword / axe / dagger / claw / flail | **none** | — | — | no guide, no ladder configuration; not in the covered-class list → review |
| Casters (wand/focus/staff/sceptre) | strong | Spark/Comet CoC, Arc, Entangle, Grim Pillars, Ice Nova, chaos DoT | Wands, Staves, Sceptres, Foci | no DPS bar (spell weapons) |
| Minions / spirit | strong | Minion armies, Grim Pillars | Sceptres, Shields, Foci, Helmets, Amulets, Belts | sceptre share includes off-hand spirit users |
| Ignite / chaos DoT | strong / moderate | Flameblast Gemling, chaos DoT | Gloves, Staves, Crossbows, Wands | bleed/poison are C/D tier, <1% |
| Attribute stacking | moderate | Lightning Arrow (HoWA), Supporting Fire | Rings | unique-dependent |
| Life + armour | moderate | Warriors, ignite Gemling | Body, Helmets, Shields | minority at the top of the ladder |
| Evasion + life hybrid | strong | bows, spears, crossbows, Martial Artist | Body, Boots, Gloves | deflection rolls not quoted by guides |
| Energy shield / CI | strong | casters, minions, Martial Artist | Body, Helmets, Gloves, Boots, Amulets, Jewels | printed-ES bars (600 body / 300 helmet) are estimates except the helmet figure quoted by the Arc guide |
| Budget vs endgame | strong | all | — | guide budgets are anecdotal |
| Charms, flasks, relics, other classes | — | — | — | not covered → always review, never discarded |

## 5. The knowledge table

- 20 build rows, 31 sources (13 general + 18 per-guide URLs), 49 patterns,
  45 recognised low-value/situational/local/implicit lines, 7 weapon DPS bars.
- Patterns combine **base + modifiers**: a family at a minimum tier, a count
  of families, a literal line, printed DPS against the class bar, printed
  defence, item level. Requirements are ANDed; alternatives are separate
  patterns. Strength `chase` → keep, `strong`/`useful` → list.
- Every pattern is `verified: false` (never checked against listings); every
  source has its page date and retrieval date; `reviewBy` (2026-10-12) stops
  discard proposals and lowers demand confidence when passed.
- Weapons are judged by the **printed** DPS (local modifiers are already in
  it); the parser now folds PoE2's per-element lines (`Cold Damage: 55-102
  (cold)`) into the total, which the old code missed (bows/crossbows/spears
  read 40–60% low). The Gemini Bow implicit "+50% Surpassing chance to fire an
  additional Arrow" no longer reads as fifty arrows (it inflated one live bow
  to 98/100).
- Mod families added for lines the guides ask for (all thresholds are
  **curated estimates** until the learned-tier store covers the stat):
  `ele-attack-pct` (T1 ≥ 87 from the game's own tier label), `crit-chance-flat`
  (T1 ≥ 4), `crit-damage-flat` (35/25/15), `life-leech` (9/7/5), `mana-leech`,
  `minion-damage`, `minion-life`, `extra-damage` (15/10/6), `ignite-magnitude`
  (30/20/12), `ailment-magnitude` (25/18/10), `ailment-faster` (15/10/6),
  `mana-on-kill` (40/28/15, T2 from the fixture's printed range), `mana-pct`,
  `spirit-pct`, `spell-crit`, `skill-duration`, `es-recharge-start`,
  `es-recharge-rate`, `cooldown-recovery`, `mana-cost-efficiency`,
  `armour-elemental`, `global-phys-pct`, and jewel forms `jewel-evasion`,
  `jewel-mana-on-kill`, `jewel-skill-duration`, `jewel-ailment-magnitude`,
  `jewel-aoe`, `jewel-es-recharge-start`, `jewel-quiver-bonus`. Wording was
  taken from the cached trade2 stat catalogue, and `fixtures/trade/
  stats-subset.json` carries their real stat ids.
- Weapon DPS bars (usable / strong total DPS): bows 150/260, crossbows
  170/300, quarterstaves 200/350, spears 160/280, one-hand maces 140/240,
  two-hand maces 220/380, talismans 200/400 — estimates; the only quoted
  guide number is "490+ elemental DPS" for an endgame Oil Barrage talisman.

## 6. Decisions, precedence and overrides

Precedence (tested): safety gates → saved price examples → your keep/sell/dump
rules → a real price-table price (exact name or base) → build demand →
appraisal promotion → craft case → discard audit → review.

- Rarity- or class-wide price-table rows are **floors**: they no longer set an
  estimated value, they are consulted after your rules, and the decision shows
  them as placeholders. With the starter configuration a unique is kept by the
  "Any unique" rule and sent to a market lookup instead of being auto-listed at
  1 ex.
- Your rules always win. Conflicts are shown, not resolved silently: a dump
  rule over a craft-grade base or a demand match, a sell rule over a chase
  match. Preserved corrections: Normal Heavy/Utility Belts (keep rule), the
  Sapphire lesson (1 divine, user estimate, exact; a keep only while the lesson
  is current, review without it, never a jewel-wide price), the Ghoul Thirst
  bow (retained; now *list* by demand, never discarded, no manufactured label).
- Personal build profiles still raise an item to keep, labelled "Your build:
  …" so they never read as general demand.
- Craft case: a positive planner step worth ≥ 0.3 ex at ≥ 60% confidence with
  an on-archetype line, or a white base at item level ≥ 81 on a covered class.
  A one-affix magic ring is not "augment stock".
- Discard audit (all must pass): identified · covered class · normal/magic/rare
  · no protection · no price floor · every affix line understood · no
  situational line · no demand match · no tier-1 affix · ≤ 1 tier-2 affix · no
  craft case · not a valuable base · weapon DPS below the usable bar ·
  knowledge within its review window. "Not in the sampled builds", a low
  generic score, a failed request or missing data never pass it.
- **Proposal, not action.** The runner keeps every unknown-tier item by
  default; `--drop-unknown` now drops only audited discard-eligible items and
  review items stay. Nothing was dropped in this work.
- Review priority: P1 near-miss chase/strong pattern, unpriced unique,
  valuable base, stale/conflicting lesson, unjudged line on a high-level item;
  P2 uncovered class, unjudged line, unreadable weapon DPS; P3 build-specific
  line with no sampled demand, other low-information cases. The queue reason
  carries the tag and the Price training page sorts by it.

## 7. Evaluation set and results

`fixtures/demand/eval-set.json` (version 2026-09-14): 32 entries, 13 in the
holdout split (grouped by base/modifier pattern: the six retained live items,
the chase bow, the meta boots, the double jewel, the junk magic gloves, the
weak bow, the uncovered charm, the lone-life body). Labels come from the user's
corrections, the starter rules, or are synthetic and say so; the six live
items are **unlabelled** (retained by policy) and only assert retention.
No entry carries an invented price.

| Metric | Before (rules + appraisal) | After (decision layer) |
|---|---|---|
| Outcomes | keep 9 · list 3 · review 17 · discard 3 | keep 9 · list 6 · review 8 · discard-eligible 9 |
| False discards (labelled entries) | 0 | **0** |
| Discard proposals on unlabelled live items | — | 2 (Amethyst Ring of the Ice, Maelström Wound jewel) |
| Review queue | 17 | 7 |
| Resolved locally | 15 / 32 | 25 / 32 |
| Items with lines the knowledge cannot judge | — | 4 |

Every labelled expectation passes, on both splits; the suite asserts zero
false discards, a non-growing queue and ≥ 50% local resolution. Price error
is not reported: the set has no defensible price labels (the Sapphire is a
user estimate, listing evidence stays separate in the training store).

## 8. Shadow replay (offline)

`npx tsx scripts/demand-shadow.ts` replays every saved bag snapshot
(`artifacts/map-triage/bag-read-*.json`, ten from 2026-09-14/15) plus the
checked-in fixtures through the live evaluator (`loadTriageExport`, the same
rules, table, lesson file and pinned league the runner uses). Run of
2026-09-15T03:28Z, 30 distinct identified items:

- outcomes keep 7 · list 10 · review 6 · discard-eligible 7; **retained by the
  default policy 30/30**; discard proposals 7 (a 63-DPS bow, four one-line
  magic jewels/belt, the Amethyst ring, the Maelström jewel, a two-mod ilvl-67
  amulet);
- review queue 13 → 6, resolved locally 24/30; 8 items had a line the
  knowledge base cannot judge (listed in the report as knowledge gaps);
- decision latency mean 1.6 ms, max 10 ms per item; **live lookups 0, network
  requests 0** (the decision layer makes none; training CRUD and preview stay
  offline; the explicit market check is untouched).

The report is written to `artifacts/demand/shadow-<time>.md` (local, not
committed). The user's presence is required before any live run; none was
made.

## 9. UI and runner

- Item log → the "Decision" block: outcome, headline, general demand with the
  builds and dated source links, near-miss pattern, craft step, the discard
  audit check by check, the policy line and the knowledge version/review date.
  The recommendation category follows the decision (`review` is a category
  now), so the panel, the tier line and the runner agree.
- Map runner: each decision line carries `decision: …` and a summary count of
  outcomes; the review queue gets `[P1]`–`[P3]` reasons.
- Evaluate uses the same `evaluateTier`, so its saved-price handling and the
  estimate band see the same verdict.

## 10. Limitations and what remains manual

- No live run, no listing check, no sale: every pattern, DPS bar and new
  threshold is an estimate with a review date. The next step is the user's
  explicit market checks on a few chase/strong matches to verify patterns
  (set `verified: true` per pattern as evidence arrives).
- Ladder selection bias (top characters), no poe.ninja timestamp, creator
  concentration at Maxroll, no first-party play statistics.
- Sword/axe/dagger/claw/flail, charms, flasks and relics have no coverage and
  always route to review.
- The knowledge table is code, not user-editable; refreshing it is a
  deliberate edit with a new version and review date. User rules, the price
  table and price lessons remain the manual inputs, and none of them needs
  per-item configuration for the outcomes above.
