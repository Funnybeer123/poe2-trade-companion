# Forbidden Rites item knowledge — 2026-09-14

Snapshot: `forbidden-rites-0.5.5b-2026-09-14.1`, in [the machine-readable JSON](../src/core/knowledge/forbidden-rites.json). Model: `batch-triage-v1`. All links below were accessed on 2026-09-14. Dates in JSON are the displayed publication/update dates; the Djinn date is its latest visible changelog entry. Forum display timezones vary.

## League and evidence coverage

The selected economy is **Forbidden Rites, normal trade**. GGG's [0.5.5 announcement](https://www.pathofexile.com/forum/view-thread/4000864), published September 3, introduces the September 4 fresh economy and separately identifies Hardcore. [0.5.5b](https://www.pathofexile.com/forum/view-thread/4004106), displayed September 11, is the latest numbered patch listed in the [official patch forum](https://www.pathofexile.com/forum/view-forum/2212) during this review. Its changes concern encounters, drops, quests and fixes; it does not announce another affix-tier reversal. This establishes a research version, not a read of the user's running game binary.

This is a purposive sample of **four author guides, three requirement profiles, zero sampled ladder characters and zero market listings**. The [Forbidden Rites build page](https://poe.ninja/poe2/builds/forbidden-rites) and [economy page](https://poe.ninja/poe2/economy/forbidden-rites/overview) could not be retrieved. The official league API also failed retrieval. No population percentages, success rankings, current unique prices or sale probabilities are claimed. Guide-directory favorites are not character counts. Other leagues require explicit selection and their own research snapshot; this sample is not silently applied to Hardcore.

## Equipment requirements extracted from authors

| Author/source and update | Scope and useful combinations | Implementation and limits |
| --- | --- | --- |
| [animeprincess: Gemling Spark](https://mobalytics.gg/poe-2/profile/animeprincess/builds/adonia-s-gemling-spark), September 11 | Endgame ES caster. Rings combine cast speed, mana and defensive needs; Unset Ring can supply a skill slot. Amulet skill levels, mana and ES matter. Boots need ES/resistances, with specialist duration requirements depending on variant. Adonia's Ego is a defining unique; Maligaro's Virtuosity and Mageblood appear in the equipment discussion, the latter as a luxury. | Caster slot families, cited unique-name recognition, an Unset Ring base opportunity and an Absent Amulet review flag. Neither a unique's name nor an author recommendation establishes price or correct variant. Unsupported duration, efficiency and unusual effects remain Review. |
| [Woolie: Run n Gun Witchhunter](https://mobalytics.gg/poe-2/builds/woolie-run-n-gun-witch-hunter), September 2 | Crossbow physical/lightning damage with attack speed; flat damage on rings/gloves; life/resistances elsewhere; relevant skill levels on weapon/amulet. The page includes progression and endgame variants. | Attack requirements remain separate from spell/minion damage. The visible equipment prose includes progression advice, so this is evidence of plausible use, not proof of current endgame demand for every listed modifier. |
| [minion2win: Sand & Fire Djinn Varashta](https://mobalytics.gg/poe-2/builds/minion2win-varashta-campaign-build-guide), changelog through September 12 | Campaign through min-max discussion; minion skill levels and supporting equipment. The page's older level-99 Hardcore/private-league example is not normal-trade ladder evidence. | Minion requirements are kept separate from player damage. This source is labeled mixed progression throughout the snapshot and UI. |
| [animeprincess: Lich minion starter](https://mobalytics.gg/poe-2/builds/lich-minions-animeprincess), May 27 | Older 0.5 starter, currently displayed in the 0.5.5 guide collection. Corroborates minion levels on helmet/sceptre/amulet, spirit, minion damage/speed, and player ES/life/resistances. All-skill focus levels can support minions. | Corroboration for shared minion equipment requirements only. It is not evidence that this older starter is a dominant September endgame build. |

Attribute requirements depend on the complete character. The general assessor recognizes attributes but cannot prove a particular character needs a specific amount. Jewel damage, speed and defence are matched to compatible subjects. Base implicits can add genuine utility; unknown implicits, rune effects, abyss modifiers, unusual jewels and unsampled uniques remain visible rather than being discarded. The snapshot does not cover every build-enabling effect.

The [Unset Ring base data](https://poe2db.tw/us/Unset_Ring) verifies its additional skill-slot implicit. The [Absent Amulet base data](https://poe2db.tw/us/Absent_Amulet) instead shows reduced prefix/suffix capacity. Although the Spark author uses that base, the assessor deliberately leaves it in Review with no crafting route until its rarity-specific capacity mechanics are verified. A recognized base name never overrides a known capacity exception.

## Affix evidence and crafting limits

GGG explicitly announced inversion of displayed modifier tiers in [the 0.2.1 preview](https://www.pathofexile.com/forum/view-thread/3783548), May 21, 2025: the current convention is **T1 best, then T2**. Old reverse-numbered PoE2 tables cannot be used interchangeably. The parser retains copied tier annotations and ranges; a score of 85 is never relabeled T1.

[PoE2DB's extracted Life tables](https://poe2db.tw/us/Life) provide the following top flat-life tiers. This is a secondary presentation of game data, with no publication date or guaranteed historical patch pin. Complete copied annotations take priority; disagreements with verified class ranges become uncertainty.

| Class | T1 life / minimum item level | T2 life / minimum item level |
| --- | --- | --- |
| Rings | 100–119 / 54 | 85–99 / 46 |
| Amulets, gloves, boots | 120–149 / 60 | 100–119 / 54 |
| Helmets, belts | 150–174 / 65 | 120–149 / 60 |
| Shields | 175–189 / 70 | 150–174 / 65 |
| Body armours | 200–214 / 80 | 190–199 / 75 |

The JSON contains the lower tiers too. Inference is restricted to unmodified flat life with a supported class and known item level. Other families need copied advanced tier evidence. [PoE2DB's jewel tables](https://poe2db.tw/us/Jewels) demonstrate that ordinary jewel modifiers often have a single tier with meaningful within-tier variation: T1 alone cannot make a jewel strong. The model also considers its copied roll position and compatible combinations. It does not infer unsupported jewel rolls from equipment thresholds.

The existing ordinary equipment model uses three prefixes/three suffixes at rare rarity, one/one at magic rarity, and two/two for ordinary Ruby/Emerald/Sapphire rare jewels. [PaintMaster's crafting guide](https://mobalytics.gg/poe-2/profile/paintmaster/guides/recoup-chronomancer-gear-crafting-guide), updated June 27, corroborates ordinary jewel limits and discusses exceptional extra-affix mechanics. Those exceptions are outside this model: unfamiliar capacity-changing modifiers stay Review. Complete advanced groups, rather than line count, must support free-slot claims. Special jewels have no assumed capacity. Normal/magic base opportunities need an explicitly recognized base and minimum item level. The initial accessory levels are verified **life unlocks only**, not proof of all desired affix unlocks. Transmutation, regal promotion or adding an affix describes a possible route; no outcome, cost, profit or removal strategy is promised. Modification restrictions conservatively block modeled routes without erasing existing usefulness.

## How the data affects decisions

The implementation's point weights and thresholds are engineering heuristics, not values reported by those sources. Relevant T1/T2 groups contribute to a compatible attack, spell or minion use. Hybrid lines count once for affix quality. Weapons require damage with speed (or supported minion/spirit synergy); armour/accessories require coherent defence, resistance or movement combinations. Fire/cold/lightning totals and coverage are shown separately from chaos. Weak triple resistance is not automatically strong. Finished items can qualify without free affixes.

Unknown modifiers, missing groups/tiers, inconsistent ranges and unsupported classes select Review. Low-priority requires positive evidence of known weak or irrelevant rolls with no recognized base/special opportunity. Recognized build uniques have a separate Keep path with variant/price uncertainty disclosed. These rules preserve a general quality assessment beyond the sampled guides.

Refresh is **manual import**, separate from capture and pricing. Validate sources and update the JSON under a new immutable ID, import it in the app, select that ID and reassess. Reports store the complete snapshot and profile with assessment history. Unsupported model IDs fail; model changes require a code version. There is no silent web refresh during scanning.
