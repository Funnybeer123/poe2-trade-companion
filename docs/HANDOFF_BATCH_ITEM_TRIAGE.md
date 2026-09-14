Rework and implement the existing PoE2 stash valuation process so it captures an entire stash tab or inventory first, then identifies useful items locally from that saved batch. Routine scanning and scoring must not make a live trade lookup for every item. Deliver working code, a tested desktop workflow, and an assessment of the existing saved batch—not just a design proposal.

Work in `C:/Users/evanb/OneDrive/Documents/Codex/poe2-trade-companion`. This is the actual source repository; the similarly named folder under `Documents/ChatGPT` is not the implementation checkout. Read `AGENTS.md` and relevant project documentation. Baseline commit: `43256ab` (`feat: value dump items by league and verify OCR stash transfers`). Inspect current changes before editing and preserve other work.

The selected league is **Forbidden Rites, normal trade**, not Hardcore. Verify its patch and league metadata during research; do not silently switch leagues. Build the knowledge and scoring profiles so other explicitly selected leagues can be supported separately.

1. Preserve and extend the existing work.

   Start with `docs/DUMP_VALUATION.md`, `scripts/value-dump.ts`, `src/core/dumpValuationRun.ts`, `src/core/savedStashPricing.ts`, `src/core/stashValuation.ts`, `src/core/stashMarket.ts`, `src/core/parseItem.ts`, the existing crafting/modifier knowledge, `src/main/stashValuationService.ts`, and `StashValuationPanel.vue`. Reuse the OCR scanner, advanced item parser, local storage, market pacing, and verified transfer machinery.

   The previous run captured 276 items with zero unread cells. Loath Beads and Dusk Medallion were verified moved to `G → Amulets`; their existing craft scores were 85/100, not verified market values. Pricing produced 12 quoted items, 69 no-comparables results, 6 unsupported results, and 189 unavailable results after repeated throttling. Historical quotes are expired. These are baseline observations, not expected outputs for the improved model.

   Preserve the local report and raw captures under `artifacts/tab-admin/`, especially `stash-valuation-report.json` and `dump-scan-2026-09-14.json`. The installed app uses `%APPDATA%/poe2-trade-companion/artifacts/tab-admin`. Inspect which report is current. Never overwrite original captures, lose transfer receipts, or mistake historical coordinates for current item locations. Keep personal inventory data and credentials out of commits.

2. Separate capture, assessment, optional pricing, and movement.

   Add a clear source choice for Dump/stash, inventory, or both. Capture every physical item before assessing the batch. Scanning a nonempty inventory must work; capture itself must neither empty the bag nor transfer anything. Use OCR to locate stash/folder labels and verified grid geometry to locate items. Preserve ambiguity stops, complete coverage checks, and exact copied item text.

   Save raw advanced text, physical item identity, source/container and coordinates, quantity, base, rarity, item level, quality, properties, sockets, implicits, explicit modifiers, affix groups/tiers/ranges when available, and modification restrictions. Missing information must remain unknown. Identical copies are distinct physical items. Checkpoint progress and report unread cells explicitly.

   Make capture, local batch assessment, optional market checking, and verified sorting independently resumable. A complete local assessment must work offline. Reassess the same capture using an explicitly selected new model/profile without repeating game input or pricing calls. Preserve the original capture and previous assessments; record which capture, league, patch, model, and knowledge snapshot each result used.

3. Research current league demand and turn it into usable data.

   Research the selected league's current patch, popular and successful builds, and their actual equipment needs. Use official patch information, available ladder/build data, current build-author guides or exports, and reputable league market data. Record URLs, publication/access dates, league/patch, sample coverage, and limitations. Do not invent a definitive ranking from a few guides or confuse leveling recommendations with endgame demand.

   Produce a cited research artifact AND a versioned, machine-readable league knowledge snapshot. Extract build/archetype requirements by item slot: useful bases and implicits, important modifier combinations, defensive needs, skill-level bonuses, damage/speed/critical modifiers where relevant, attributes, jewels, and special build-enabling effects. Distinguish player, minion, attack, and spell requirements. Explain sampling bias and unsupported areas.

   Refresh this knowledge on demand or by an explicit cache policy, independently of item scanning. Popularity is evidence of possible demand, not a chaos valuation. Retain a general-purpose item-quality assessment so broadly useful or niche items are not rejected solely because a build is absent from the sampled meta.

4. Identify useful rolls and combinations accurately.

   Verify the current game's affix-tier numbering and class/base-specific tier ranges. Prefer reliable advanced annotations; otherwise infer only from verified modifier data and retain confidence/ambiguity. Distinguish actual T1/T2 affix evidence from the existing heuristic score bands. Do not use one generic numeric threshold across all item classes or equate a high roll within a weak tier with a top-tier affix.

   Recognize relevant T1 or T2 rolls, multiple useful T2 rolls, and coherent combinations. The current `hasStrongCraftPair` requires a T1 roll: replace that restriction with researched, testable rules so multiple useful T2 modifiers can qualify without a T1. A single irrelevant T1 modifier must not automatically make an item good.

   Evaluate fire/cold/lightning resistance coverage, triple elemental resistance, chaos resistance, useful mixed resistance combinations, roll strength, and total effective resistance. Combine these with life/energy shield, attributes, movement speed, or other slot/build requirements. Do not blindly add chaos resistance and elemental resistance as equivalent value, or count all-elemental resistance and hybrid lines as multiple affix slots.

   Use class-specific assessment: relevant damage and speed together on weapons, useful defence/movement combinations on armour, appropriate accessory modifiers, and coherent jewel modifiers. Do not accumulate unrelated player/minion or attack/spell bonuses into an artificial high score. Finished good items can qualify even without crafting room.

5. Preserve credible crafting opportunities and avoid false negatives.

   Assess base desirability, item level and unlocked modifiers, useful retained affixes, confirmed free prefixes/suffixes, competing affix slots, restrictions, and plausible improvement paths. Count affix groups rather than tooltip lines; hybrid modifiers can occupy one group. Model limits per item class and rarity, including jewels and magic-to-rare opportunities. Do not assume all items have ordinary rare equipment limits.

   Allow valuable normal/magic crafting bases and useful starting items to qualify without already having two strong affixes. Explain what makes the base promising and what improvements are possible. If a path requires removing an affix or depends on unverified mechanics, label its risk and uncertainty. Do not claim crafting profit, success probabilities, or exact costs without supporting current data.

   Corruption or other modification restrictions can block a crafting route without making an already useful item worthless. Assess uniques, build-enabling effects, valuable implicits, and special item classes separately; their value cannot be rejected using ordinary rare-affix tiers alone.

   Use explicit outcomes such as Keep/useful now, Craft candidate, Review/unknown, and Low-priority. Filter low-priority items out of the shortlist while retaining them in the complete ledger. A low-priority decision needs positive evidence of weak, irrelevant modifiers and no recognized base/build/special-item opportunity. Unknown modifiers, unread text, incomplete tier coverage, and research gaps must go to Review instead of becoming zeroes. No automatic vendoring, destruction, or actual crafting in this change.

6. Use selective market checks only where they help.

   Local scan and assessment must make zero trade searches. Offer a separate optional action to price selected candidates or a budgeted shortlist. Start with an editable default budget of 10 distinct trade searches per batch, with bounded listing fetches and clear request counters. Prioritize promising items, uncertain expensive items, and decisions near the sale threshold. Do not automatically enqueue every unpriced item afterward.

   Reuse current league-wide data where appropriate and deduplicate genuinely equivalent query signatures, but check each item's rolls/state against returned comparables. Never assign a group's price to materially different items. Preserve league/patch keys, timestamps, expiry, seller/sample counts, confidence, and provenance. An unavailable or empty search is not a zero-value result.

   Retain existing rate-limit pacing and Retry-After behavior. Reaching the budget, cancellation, or throttling must checkpoint and pause the pricing queue without blocking the local assessment. Resume the remaining selected queue without rescanning or repeatedly refreshing its first few items.

   Keep the existing strictly-greater-than-1-chaos rule for the price-confirmed route, with fresh, adequate comparable evidence. Useful-item and crafting decisions may operate from the local model but must be clearly labeled as heuristic selection, never as proof that the item sells above 1 chaos.

7. Make the result understandable and actionable in the app.

   Display the complete batch immediately after capture. Add searchable/sortable filters for outcome, item class, source, recognized T1/T2 rolls, resistance combinations, crafting room, and uncertainty. Show separate modifier-quality, combination/build-fit, general usefulness, crafting-potential, and assessment-confidence components. Show price and price confidence separately when available; do not turn a score into currency.

   Each item's explanation should identify the useful rolls, matched build/archetype and research sources, confirmed or uncertain crafting room, reasons for filtering or keeping it, and proposed destination. Provide editable per-league weights/rules and a local keep/review feedback override. Recompute results from saved data when settings change; do not require a new scan or lookup. Keep unknown coverage visible so confidence is not confused with a low score.

   Preserve the existing names: top-level `Dump`; destination folder `G`; child tabs `1h Mace`, `QuarterStaff`, `Spears`, `Shields`, `Wands`, `Jewels`, `Amulets`, `Rings`, `Helmets`, `OffHands`, `Body Armour`, `Gloves`, `Bow/Crossbow`, `Belts`, `Boots`, `2h Mace`, `Sceptres`, and `Staves`. Preserve the `Body Armor` → `Body Armour` mapping. Leave `A` and `Extra` untouched. Unmapped items stay in their source for review.

   Generate a movement preview from the assessment. Preserve the user-triggered sort action and existing emergency stop, target allowlisting, exact OCR navigation, and source/inventory/destination receipts. Revalidate current identity/location before moving; do not reprice the entire batch or assume saved coordinates are current. Handle an inventory-source batch explicitly instead of applying an empty-bag precondition to its capture. Existing moved/failed receipts must survive rescoring and resume. This handoff does not require new live game input merely to prove the new assessor works; start from the saved batch and replay fixtures.

8. Verify and deliver the implementation.

   Add meaningful tests for: capture and offline reassessment making zero market calls; nonempty inventory capture; relevant T1/T2 and multiple-T2 combinations; weak triple-resistance versus strong useful combinations; chaos resistance; irrelevant T1 rolls; hybrid affix grouping; class-specific crafting limits; magic/normal bases; full-affix good items; restricted crafting items; valuable uniques; unknown/incomplete items staying in Review; incompatible build modifiers; duplicate physical items; changed positions; and preservation of transfer receipts.

   Verify that a saved batch of hundreds of items produces a complete local ledger without network access; the default optional pricing action never exceeds 10 searches and does not enqueue the whole batch; budget/throttle/cancel resumes preserve every row; changing a model/profile triggers local rescoring; and malformed offline input cannot fall through into game input. Keep the two previously moved amulets as transfer-history regression cases without hardcoding their desired new scores.

   Run required lint, typecheck, unit/integration/replay checks, and focused packaged desktop smoke tests with isolated data. Reassess the existing 276-item snapshot locally and report the new shortlist, review queue, filtered count, unresolved knowledge gaps, and actual number of market requests. Never change results just to make the shortlist larger or smaller.

   Deliver the working feature, cited league research and knowledge snapshot, updated setup/use documentation, a before/after batch report, test results, and a concise conventional commit. Clearly distinguish what was implemented and verified offline from any live scan, market request, or physical transfer actually performed.
