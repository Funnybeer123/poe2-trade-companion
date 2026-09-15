# Handoff prompt: build-aware default item valuation

Copy the prompt below into the next coding task.

---

You are working in the Windows-first Path of Exile 2 companion repository:

**C:\Users\evanb\OneDrive\Documents\Cursor Repos\poe2-trade-companion**

## Outcome

Research the current leading PoE2 builds, then implement tested default item desirability and pricing behavior so the user does not need to configure every useful base or modifier manually. Deliver working defaults and clear explanations in the existing app, not only a research document or a large collection of manually maintained regex rules.

Proceed with research, implementation, and offline tests without repeatedly asking about routine reversible choices. Do not start background automation or send game input in this task. Complete offline and shadow validation first; any later live test requires the user to be present and to request it.

Read AGENTS.md and the relevant architecture, product, and QA boundary documents. Verify the actual working directory, current branch, remotes, and git status before editing; this handoff is intended for the user's master branch. Do not assume a differently located mirror or main branch is the same checkout. Preserve existing work. The live inventory runner must remain concise, use correct item footprints, avoid redundant movement, and retain its existing stop, pause, focus, clipboard-verification, and recovery safeguards.

## Research the current game, not remembered metas

1. Verify the current league, patch, and relevant balance changes by browsing primary sources. Start with official GGG announcements and patch notes. The last locally pinned league was **Forbidden Rites**; verify it rather than assuming it is still current.
2. Define what “top builds” means with observable evidence: current ladder representation, recent creator-authored guides, demonstrated endgame performance, and other first-party build evidence. Record the date, patch, league, source URL, and strength or limitations of each claim. Popularity, guide availability, and actual performance are different signals.
3. Cover a broad set of relevant archetypes: weapon attack builds, spellcasters, minions, damage-over-time/ailments, defensive configurations, budget progression, and established endgame variants where the current game supports them. Include multiple weapon types and damage/defense approaches. Do not infer the entire market from one creator, one expensive showcase, or one leaderboard.
4. Produce a dated, reviewable source registry and a coverage matrix. Explain selection bias, missing archetypes, stale sources, and uncertain conclusions. Use primary technical/API documentation when implementing provider behavior. Do not invent unavailable APIs or scrape sites contrary to their access restrictions.

## Turn build evidence into contextual defaults

Derive useful **base + modifier combinations**, not independent “T1 means valuable” bonuses. Each implemented demand pattern needs a supported use case, matching constraints, meaningful thresholds, and a reason the UI can explain.

Evaluate relevant interactions, for example:

- Weapons: effective physical/elemental/total DPS from displayed damage and attack rate; attack speed, critical stats, added damage, skill scaling, weapon restrictions, and the actual build's damage conversion or scaling. Avoid double-counting local modifiers already reflected in displayed properties.
- Armor: relevant defense bases and combinations, life/energy shield, resistances, movement speed, attributes/requirements, and build-specific defensive needs.
- Jewelry and jewels: complementary modifiers, relevant damage types, resource or cooldown constraints, skill-specific interactions, and roll strength in context. A useful combination can matter more than rarity or the count of mods.
- Crafting bases: item level and available affix tiers, base properties, useful existing affixes, open affix capacity, corruption or other restrictions, and the plausible cost and benefit of further crafting. Do not label every partly filled rare a valuable crafting base.

Use the existing parsers, advanced-copy annotations, modifier knowledge, build profiles, and gear-target matcher where they are sound. Identify and test unsupported or incorrectly parsed stats instead of hiding them behind optimistic scores. Store curated default knowledge in a small versioned, inspectable form with provenance and expiry/review information.

**Build demand is not a market price.** Popularity does not establish scarcity, liquidity, a sale price, or even positive resale value. Keep desirability, crafting potential, listing evidence, and reported sales separate. The generic **any-unique = 1 exalted** table entry is a placeholder, not a verified market valuation. Never convert a feature score directly into an apparently observed price or present evidence strength as a calibrated sale probability.

## Make useful decisions with fewer manual corrections

Implement distinguishable outcomes: **keep**, **sell/list candidate**, **review**, and **discard eligible**. Crafting potential can be a clear reason for keeping or reviewing. Reuse existing routing categories carefully and make all displayed recommendations agree with the actual triage decision.

Avoid both failure modes: automatically discarding an unfamiliar item, and keeping/reviewing every unfamiliar item forever. Curated build patterns should resolve common cases locally. Measure the remaining review burden, explain why each uncertain case needs attention, and prioritize review by useful information rather than blindly requesting a price for every item.

Discard eligibility needs conservative, auditable evidence: correctly identified item and footprint, covered item class and context, no protected/user override, no applicable valuable combination or crafting case, and adequate current evidence for a low-value conclusion. Missing data, a low generic score, a failed request, or “not popular in the sampled builds” is not sufficient. Separate a proposed discard recommendation from executing a drop. Validate proposed decisions in shadow mode before any later user-authorized live operation.

Document and test override precedence and conflict handling. Preserve safety protections, explicit user keep/base rules, and applicable saved corrections; do not silently overwrite them with new meta defaults. Keep personal build targets distinct from general trade demand. Preserve existing intentional user rules while making conflicts visible and predictable.

### Corrections that must survive

- **Normal Heavy Belt and Normal Utility Belt** are user-requested crafting bases to retain, including the observed level-50 requirement example.
- **Chilling Sapphire of Chanting**, item level 79, 15% increased Cold Damage and 11% faster Curse Activation, has an **exact-item user estimate of around 1 divine** in Forbidden Rites. The source screenshot had very low reliability. This is not a confirmed sale and must not become a universal Sapphire price or a “T1 jewel = 1 divine” rule.
- **Ghoul Thirst / Gemini Bow** was retained because its value was unknown. The user has not labeled it trash or confirmed it valuable. Do not manufacture either label for training or evaluation.
- Preserve the current default that unknown valuations are retained while improved decision coverage is validated. Any change to automatic discard behavior must be supported by the evidence and shadow results above.

## Local learning and restrained market access

Integrate the new defaults with existing price training, rather than building a competing feedback store. Preserve exact versus similar scope, league isolation, timestamps, estimate/listing/sale provenance, conflict and stale handling, removals, and deduplication. Default knowledge must not masquerade as a user correction or confirmed trade observation.

All market access must use the existing **main-process PriceFeedService singleton and shared TradePacer**. Reuse caches and original timestamps, respect league pinning, budgets, persisted penalties, Retry-After/backoff, and existing request limits. Do not create another pricing service per item or process, scrape prices in parallel, retry through a lockout, or batch-check the user's entire bag.

Prefer local knowledge and valid cached evidence. Keep live lookups sparse, deliberate, and justified by uncertainty that would change a decision. Training CRUD and local preview must remain offline. The bag runner must not start making network calls; its review hook writes local records only. Surface unavailable or stale evidence honestly and preserve user control over the existing explicit market-check action.

## Existing implementation to inspect

- Core appraisal and decisions: src/core/appraisal.ts, modKnowledge.ts, valueTiers.ts, desirability.ts, localValuation.ts.
- Personal build matching: src/core/buildProfiles.ts and gearTargetMatcher.ts.
- Training: src/core/priceTraining.ts, src/adapters/priceTrainingStore.ts, src/shared/priceTraining.ts.
- Shared loading and main valuation: src/adapters/triageLoader.ts, src/main/itemIntelligenceService.ts, src/main/index.ts.
- Market/cache/pacing: src/main/priceFeedService.ts, src/core/tradeComps.ts, tradePacing.ts, and the existing Evaluate service.
- UI: src/renderer/features/priceTraining/PriceTrainingTool.vue, src/main/features/priceTraining/index.ts, src/renderer/components/ItemDetail.vue, and src/renderer/features/evaluate/.
- Inventory execution: scripts/map-triage.ts, src/core/mapTriage.ts, mapTriageRun.ts, mapTriageExecution.ts, src/core/itemSizeStore.ts, itemSizeCatalog.ts, and the guarded host adapters.
- Useful preserved fixture: fixtures/items/chilling-sapphire-training.txt. Extend representative offline fixtures and existing appraisal, training, build-matching, recommendation, and map-triage tests.

Local artifacts are normally ignored and **are not part of the code push**. Do not force-add them, delete them, or assume they exist in a fresh clone. On the original machine, artifacts/tab-admin/ contains the live rules, price training/review history, and shared caches; artifacts/map-triage/ contains the clipboard snapshots, action journal, benchmarks, size backup, and live-price-training-2026-09-15.md. Preserve those local records and the checked-in fixtures. Promote only deliberately curated, privacy-reviewed test fixtures into version control.

## Baseline and validation

Latest completed baseline: **2,942 tests across 239 files passed**, plus ESLint, TypeScript checks, and production build.

The verified live run **2026-09-15T01:14:47.591Z** took **21.567 seconds**, identified **8 items**, dropped **0**, and moved **0**. Before/after snapshots retained all **36 items / 56 occupied cells**. Scroll counts changed **27→19** and **40→40**. Six unknown items were retained and added to the local review queue. This tested identification and retention; it did **not** test drop or movement transactions, current price accuracy, or faster-than-human performance. The corrected Sapphire and belts were absent. Preserve the measured **Soaring Spear 1×4**, protected **Vault Key 1×1/non-gear**, and scroll-stack geometry behavior.

Build a dated, independently labeled evaluation set covering valuable combinations, genuinely low-value items, crafting bases, unusual classes, conflicting/stale evidence, and the existing user corrections. Distinguish observed prices from estimates. Split holdouts by item/base/modifier pattern as appropriate so near-duplicate examples do not inflate results. Do not tune on the final holdout or count repeated observations as independent samples.

Add sanitized regression fixtures for both the Ghoul Thirst bow and the Sapphire, preserving copied combat stats and the actual provenance available. Their existing labels are respectively **unknown/retained** and **user estimate/exact**, not confirmed market values. Add clearly marked synthetic variants to test effective combat stats, build fit, modifier interactions, and negative cases. Do not pretend a synthetic discard label is observed market evidence or assign an invented price to make a test pass.

Report before/after:

- Archetype and item-class coverage, including unsupported combinations.
- Correct keep/sell/review/discard decisions, **false-discard count and rate**, and uncertainty in the sample.
- Review-queue burden and the fraction of items resolved locally, rather than merely announcing more keep rules.
- Price error or band coverage only where defensible price labels exist; report listing evidence separately from actual sales.
- Cache reuse, live lookup count/budget behavior, and decision latency.

Run relevant unit, integration, component, and replay/shadow checks, then the required project checks under Electron's Node as documented in AGENTS.md. Add regressions for the preserved corrections, override precedence, unsupported stats, currency/league handling, cache failures, and no-HTTP local paths. Verify the actual UI explanations and ordinary Evaluate/Item-log output agree with the runner's decision.

## Deliver

1. Implemented, tested defaults with dated sources, explicit coverage, and understandable per-item reasons.
2. A concise research/coverage report, evaluation dataset methodology, holdout results, review-burden change, and limitations.
3. Updated UI explanations showing which build/use case and evidence drove a result, while distinguishing approximate demand from observed prices.
4. A reviewable code change and validation summary. Identify any remaining manual inputs that are truly necessary; do not leave normal operation dependent on hand-configuring every item.

Do the research and implementation in this task. Do not stop after proposing a plan or writing another handoff.
