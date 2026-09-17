# Ring quality policy research

Researched 2026-09-17. Scope: ordinary gambled magic/rare rings. These are local
selection rules, not current prices or a promise of a profitable craft.

## Evidence and implications

- GGG's [0.2.1 announcement](https://www.pathofexile.com/forum/view-thread/3783548/filter-account-type/staff)
  describes reversing advanced modifier tier display to PoE1 ordering. Use the
  actual advanced-copy tier instead of an approximate cross-item stat score.
  Older guides discussing reversed tiers are stale for this client.
- GGG's [0.3.0 patch notes](https://www.pathofexile.com/forum/view-thread/3826682/filter-account-type/staff)
  document Archmage scaling with maximum mana. This supports treating mana,
  caster throughput and mana sustain as compatible; the exact keep thresholds
  below are our screening policy, not GGG recommendations or market research.
- The user's Glyph Loop and the saved live item texts are direct evidence for
  current affix tiers and prefix/suffix grouping. Glyph Loop has T1 explicit
  rarity, T3 cast speed, T4 mana and T6 cold resistance. Its 13% implicit plus
  17% explicit rarity totals 30%. Two prefixes and two suffixes leave one of each
  under ordinary rare-ring limits. Keep it as a crafting candidate; neither its
  open slots nor its T1 roll establishes a sale price.

## Lower-tier synergy rules

Require three distinct explicit affixes, each T4 or better, at least two T3 or
better. Implicits and hybrid lines cannot manufacture additional affixes.

- Caster: at least 100 mana + at least 15% cast speed + meaningful mana regen,
  intelligence, life or resistance.
- Mana: at least 100 mana + at least 40% mana regeneration + at least 25 intelligence.
- Defence: at least 60 life + two different resistance affixes of at least 25% each.
- Attack: flat damage to attacks + attack speed (or matching elemental attack
  scaling for elemental damage) + accuracy, life or resistance. Cast speed and
  minion bonuses do not count as attack synergy.

These initial patterns intentionally do not pretend to cover every niche build.
Missing or ambiguous tier/group evidence remains review-only. Unique or
restricted special items are protected for separate assessment. Ordinary rings
with complete observed low tiers no longer require a generic regex family match
before they can be rejected. Generic appraisal scores, base implicits and broad
keep/price rules no longer override this gambling-specific policy.

## Regression evidence

Glyph Loop, the missed T2-rarity Emerald Ring of Raiding, misleading generic
score thresholds, malformed annotations, hybrid groups, weak combinations,
duplicate resistances and mismatched attack/caster subjects have dedicated tests.
The last live 42-ring batch is replayed offline from its original copied text;
no further gold is spent and no previously retained rings are sold by replay.

## Useful T1/T2 core rolls

Brood Circle correction: a rare with three or more affixes cannot qualify from
one isolated premium roll. It needs a second useful core affix at observed T1–T3
in a separate affix group, or an established substantial synergy. Magic items
and rare bases with at most two affixes can still qualify as sparse crafting
bases. A free suffix alone does not rescue a rare clogged with bad prefixes.
Brood Circle's T1 mana plus T8 evasion, T7 life, mana on kill and weak hybrid
regeneration is therefore vendored. Glyph Loop remains a crafting candidate.

The user selected useful core rolls only; utility rolls require synergy.
Core families: life, mana, energy shield, attributes, resistances, item rarity,
cast/attack speed, relevant player damage/critical modifiers and meaningful
mana regeneration (at least 40%). Match full player-stat lines to avoid accepting
minion/totem effects as player stats. Standalone light radius, flat life regen,
leech and accuracy fail. Low mana-regen/light-radius hybrids fail even at T1.
Life regen can contribute to life + regen + resistance; physical leech can
contribute to physical attack damage + attack speed + leech.

Final offline replay of the original 42 rings: **29 vendor, 12 craft, 1 keep**,
versus the old 9 vendor / 33 retained. This also corrects the old false-negative
Emerald Ring of Raiding (14% rarity, actual T2). The replay changes no live items.
