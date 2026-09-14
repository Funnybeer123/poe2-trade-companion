# Dump valuation and stash setup

Open **Sort → Dump values**. The saved league for this setup is **Forbidden Rites** (normal trade). Pricing always uses an explicit league; it never guesses the current league.

## Your tab names

Keep `Dump` as a top-level quad tab. Keep the folder named `G`. Inside `G`, use the names from your screenshots:

| Tab | Items |
| --- | --- |
| `1h Mace` | One-handed maces |
| `2h Mace` | Two-handed maces |
| `QuarterStaff` | Quarterstaves |
| `Spears` | Spears |
| `Shields` | Shields and bucklers |
| `Wands` | Wands |
| `Jewels` | Jewels |
| `Amulets` | Amulets and talismans |
| `Rings` | Rings |
| `Helmets` | Helmets |
| `OffHands` | Quivers and foci |
| `Body Armour` | Body armours |
| `Gloves` | Gloves |
| `Bow/Crossbow` | Bows and crossbows |
| `Belts` | Belts and charms |
| `Boots` | Boots |
| `Sceptres` | Sceptres |
| `Staves` | Staves |

The valuation flow is configured for these existing names. No separate sale or crafting tabs are needed. Both valuable items and crafting candidates go to their matching class tab, with their selection reason retained in the report. `A` and `Extra` are not destinations for this flow. Classes without a configured destination stay in `Dump` for review. If you want to route axes, swords, claws, daggers, or flails too, map the **Weapons** field to a tab you create for them.

The older **Gear sort** workflow has its own historical `Gear` folder and routing rules. Use **Dump values → Sort valuable items** for this league-aware selection and your `G` folder.


## Capture, assess, optionally price, then sort

1. Select the exact league and capture source: **Dump / stash**, **Inventory**, or **Both**. Keep the personal stash open. **Scan dump values** copies the complete selected grids before assessing them locally. A nonempty inventory is supported; capture neither transfers items nor requests market data.
2. Read **All scanned items**. The complete ledger retains exact advanced text, physical coordinates, quantity, parsed properties, affix evidence, outcome, uncertainty and destination. Identical items remain separate physical rows. Incomplete coverage is explicit; **Resume incomplete capture** retries incomplete sources using their original settings and keeps completed sources.
3. Use the search, outcome, class, source, T1/T2, resistance, crafting-room and uncertainty filters. **Keep + craft shortlist** hides review and low-priority rows without deleting them. Expand an item for component scores, copied rolls, affix room and linked build sources. Keep/Review feedback overrides are local and reversible.
4. Edit per-league weights or outcome thresholds and save, or choose **Reassess saved batch offline**. Both recompute from copied text, preserve assessment history and send zero game input or market requests. Select/import a new knowledge snapshot to change the research profile.
5. Optionally check specific rows and choose **Resume saved pricing**. With no selection it creates a priority queue of at most the configured budget, initially **10 distinct searches**. It does not append every other unpriced item afterward. Search, listing-fetch, metadata and economy counters remain separate. Budget, cancellation, and Retry-After pause this queue independently of assessment. Increase the budget to continue a longer explicitly selected queue. Change the checked selection to start a different queue; completed queues do not automatically refresh expired quotes.
6. Inspect **Movement preview**, then choose **Sort valuable items** with Dry-run off. Sorting uses the saved assessment, revalidates exact current text and original position, and verifies source, inventory and destination receipts. It makes no market requests. Inventory-source candidates are deposited directly first; stash withdrawals require an empty inventory. Retained inventory items can therefore prevent the stash portion from proceeding until handled. Changed positions or ambiguous copies require recapture, not relocation by fingerprint.

Keep the game foreground during capture/sorting. **Ctrl+Shift+Esc** and Numpad **0** stop generated input. Hide chat or other overlays covering grids. Navigation retains the verified 3840×2160 physical client calibration at screen origin and OCR agreement checks for exact folder/tab names. Inventory capture requires the calibrated bag grid and reports excluded/unread cells. A different viewport is refused before input.

Previously moved or failed transfer receipts survive rescoring, pricing and sorting resumes. They are not automatically retried. Inspect an uncertain transfer in-game and create a fresh capture before attempting it again. Historical coordinates never prove current location. No vendoring, destruction, listing, trade completion or actual crafting is part of this feature.

## Outcomes and evidence

- **Keep/useful now:** coherent, sufficiently strong local modifiers, or a recognized build-enabling unique. Finished items do not need crafting room. This is a heuristic selection, not a price.
- **Craft candidate:** a researched base opportunity or useful retained combination with a supported improvement route. Magic, ordinary rare equipment and ordinary jewels have different capacities. Complete advanced affix groups determine room; hybrid lines count as one group. Restrictions can block crafting while preserving existing usefulness.
- **Review/unknown:** missing tiers/groups, unrecognized modifiers or special classes, conflicting copied ranges, incomplete coverage and research gaps remain visible. An unavailable/empty market search is not a zero-value observation.
- **Low-priority:** requires positive evidence of known weak or irrelevant rolls and no recognized base/special opportunity. Items remain in the complete ledger and source.
- **Price-confirmed route:** separately requires a fresh, same-league and same-patch quote with adequate comparable sellers/confidence and conservative lower estimate **strictly above max(1, configured threshold) chaos**. Exactly 1 chaos cannot qualify. Historical quotes without a patch key are not new transfer authority. Expired evidence is not refreshed during sorting; price those items explicitly first.

Default local thresholds are Keep 70, Craft 55 and Low-priority at most 25. These are adjustable point thresholds; **T1/T2 refers to copied or verified affix tiers**, never a score band. The older minimum crafting-score field remains in saved profiles for compatibility with legacy reports; batch selection uses **Local outcome thresholds**. The model separates modifier quality, combination/build fit, general usefulness, crafting potential and coverage confidence. Price and price confidence are separate.

Read [the dated research and coverage limits](FORBIDDEN_RITES_KNOWLEDGE.md). Current automatic tier inference covers flat life by class only. Ordinary jewels use within-tier roll position, not equipment-sized thresholds. Many effects remain unsupported; Review is expected. Heuristics do not estimate crafting costs, success chances or profit.

## Saved data and CLI

Development files live under `artifacts/tab-admin/`; the installed app uses `%APPDATA%/poe2-trade-companion/artifacts/tab-admin`. The packaged worker runs without Node/npm or a source checkout. Authentication stays in existing app configuration and is never copied into reports.

| File/directory | Purpose |
| --- | --- |
| `stash-valuation.json` | Current explicit settings |
| `stash-valuation-profiles.json` | Profiles keyed by exact league |
| `stash-valuation-report.json` | Working report, checkpointed during each action |
| `batch-history/<sha256>.json` | Immutable prior and new report versions, including original raw rows and receipts |
| `knowledge/<id>.json` | Validated immutable research imports |

The working report stores capture identity, completion, source/league/patch, complete parsed rows, model/profile/snapshot and assessment history, plus an independent pricing queue. Archived versions preserve earlier quote/transfer states. Keep original named scans as permanent inputs; use a different `--report-file` for experiments. Local inventory data and history are ignored by Git.

```powershell
# Live capture then offline assessment; no pricing or transfers
npm run value:dump -- --source=both

# Entirely offline, preserving this original file
npx tsx scripts/value-dump.ts --from-scan=artifacts/tab-admin/stash-valuation-report.json --report-file=artifacts/tab-admin/reassessed.json

# Optional bounded pricing from a saved assessment; --pending-only is an alias
npx tsx scripts/value-dump.ts --from-scan=artifacts/tab-admin/reassessed.json --price --budget=10 --report-file=artifacts/tab-admin/priced.json

# Resume an incomplete live capture, preserving completed sources
npx tsx scripts/value-dump.ts --from-scan=artifacts/tab-admin/stash-valuation-report.json --resume-capture

# User-triggered verified transfers from the saved preview, no pricing
npm run value:dump:sort -- --from-scan=artifacts/tab-admin/stash-valuation-report.json

# Independent offline knowledge refresh; then select its ID in the app
npx tsx scripts/value-dump.ts --import-knowledge=path/to/new-snapshot.json
```

Saved commands use the input report's profile. UI profile edits trigger reassessment; the CLI can explicitly select another league for offline analysis only. Other model IDs are rejected until implemented. A new knowledge ID must pass data-only validation, with HTTPS citations and bounded fields; existing IDs cannot be redefined. The complete selected snapshot is embedded in assessment reports for reproducibility.

Bare/empty arguments, malformed reports, mismatched live-action leagues and incompatible combined actions are rejected before any game input. `--move`, `--price` and `--resume-capture` require `--from-scan`. The old `--craft-only` spelling remains a zero-market compatibility flag; ordinary capture/assessment are already offline. Do not use legacy commands that expect scan-and-price or scan-and-move in a single action.

Optional pricing retains existing server pacing and Retry-After. It uses at most one search and one bounded listing fetch per uncached attempt, deduplicating exact raw item/state signatures within a league/patch. Materially different rolls never inherit a neighboring item's quote. Existing comparable matching checks base, rarity, state, modifiers, sellers, timestamps, expiry and current conversion evidence. A pre-request budget reservation survives abrupt termination; if no response is received, it is conservatively counted against the budget. Empty/no-comparable results are completed queue entries; unavailable results pause for explicit resume. Market ranges are asking-price estimates, not guaranteed proceeds.

See [the offline delivery report](BATCH_TRIAGE_VALIDATION.md) for the saved 276-item assessment and verification evidence.
