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

## Scan and sort

1. Keep your personal stash open in the game. Choose **Scan dump values**. It navigates to `Dump`, copies item text throughout the grid, and requests current league comparisons. This uses game input for navigation and copying, but transfers nothing.
2. Read **All scanned items**. Every copied item has its original text, source cell, gear score, craft score, market result, reasons, and planned destination. Failed reads and unavailable prices are explicit. A failed price request never becomes a zero-value item.
3. Empty the inventory. Choose **Sort valuable items** with the app's Dry-run switch off. It performs a new scan and valuation, then verifies each selected item's source identity, inventory receipt, and destination receipt. Incomplete source coverage blocks transfers. A failed receipt stops the run.
4. **Ctrl+Shift+Esc** is the emergency stop; Numpad **0** also stops the scanner. Keep the game foreground while it works.

Hide or collapse chat when messages overlap the inventory or stash grid. Overlay text can appear as an occupied cell and cause an unread-item stop; clear the overlay before retrying.

Live navigation currently uses the verified 3840×2160 physical client calibration at screen origin. A different viewport is refused before input. Folder and tab labels are resolved through OCR; short folder names such as `G` use contrast preprocessing with repeated agreement checks.

Market prices can be throttled or unavailable. The report retains the item copies so prices and scores can be improved without losing the inventory evidence. A scan with unpriced items is not a complete valuation even if every grid cell was read.

Choose **Resume saved pricing** to retry only unavailable results, including requests interrupted by rate limits. It uses the saved report's original league, thresholds, item identities, and positions; unsaved settings in the form do not change that capture. It sends no game input and performs no transfers. Existing moved/failed outcomes and their receipt notes remain recorded.

Resume retains priced, no-comparables, and unsupported results with their original timestamps. Expired prices remain historical evidence and cannot authorize a fresh sale plan; resuming does not refresh those earlier results. A new provider restriction checkpoints the affected item and pauses the remaining work. The button becomes available again after the job stops, and a saved future retry deadline is respected before any request.

## What qualifies

- **Market value:** the conservative lower estimate must be **strictly greater than 1 chaos**, from at least three comparable sellers, with at least 65% confidence and a fresh timestamp. A price of exactly 1 chaos does not qualify. The threshold and confidence are editable.
- **Crafting candidate:** a default score of at least **70/100**, with multiple strong modifier families suited to the item class and room for improvement. Complete advanced annotations determine prefix/suffix counts; supported hybrid modifiers count as one affix. Without complete annotations, a conservative line-count check is used. Copied accessory tiers can inform crafting strength and are shown separately from the heuristic gear bands. Corrupted, mirrored, unidentified, and unsupported crafting items are excluded. Jewel modifiers use jewel-scale scoring; full four-line rare jewels are not treated as open crafting bases.
- **Review:** unavailable, stale, mismatched-league, low-confidence, unsupported, unreadable, or unmapped items stay in `Dump`. Nothing is vendored or listed by this feature.

Crafting scores are editable heuristics, not crafting profit or verified affix-tier probabilities. Copied modifier lines do not prove exact prefix/suffix counts because hybrid affixes can span lines. Check the item's actual affix groups and current crafting costs before crafting.

## Market evidence and improvement

The lookup uses the real Path of Exile trade service and its current stat catalog, then checks returned listings locally for matching base, rarity, state, modifier text and comparable numeric rolls. It rejects duplicate sellers and unsuitable comparables. Currency conversion uses only fresh, same-league exchange data; no starter price table or hardcoded chaos/divine rate authorizes a transfer.

Each quote records its provider, league, timestamp, expiry, sample counts, confidence, low/fair/high asking-price range, and search link. Quotes expire after at most 15 minutes; conversion data can shorten that lifetime. The sorter refreshes expired sale evidence before withdrawal. These are estimates of listed asking prices, not guaranteed sale proceeds. Sparse searches, unusual modifiers, special variants, inaccessible listings, and changing markets can leave items unpriced. The report states those limitations instead of substituting a generic base price.

Advanced copied item text is supported: `14(5-15)%` contributes the actual roll of `14%`, while the original text and range remain saved. Named prefix and suffix annotations identify magic-item bases for searches. Unknown explicit modifiers exclude automatic crafting selection, and minion and player modifiers must fit a compatible crafting use.

Edit **Improve scoring for this league** to tune modifier-family weights. Profiles retain separate weights and thresholds per exact league. Item text and the scoring-model version are retained with every report so a later model can re-evaluate the same items.

## Local files and CLI

- `artifacts/tab-admin/stash-valuation.json`: current settings.
- `artifacts/tab-admin/stash-valuation-profiles.json`: settings per league.
- `artifacts/tab-admin/stash-valuation-report.json`: latest report, checkpointed during work.
- `npm run value:dump`: scan and value without transfers.
- `npm run value:dump:sort`: scan, value, and move eligible items.
- `npx tsx scripts/value-dump.ts --craft-only --move`: fresh scan and verified transfers for strong crafting candidates while market pricing is pending. This sends no market requests and cannot approve an item by price.
- `--report-file=PATH`: save a separate report, useful for keeping an offline price pass separate from a live crafting pass.
- `npx tsx scripts/value-dump.ts --from-scan=artifacts/tab-admin/stash-valuation-report.json`: reprice and rescore copied items without game input. This cannot move items or establish their current physical location.

The desktop passes its existing market configuration directory to the scanner. Authentication data remains in the existing app configuration and is not copied into item reports.

Add `--pending-only` to the `--from-scan=FILE` command to retry only unavailable rows and advance unfinished pricing without re-querying earlier expired prices. All earlier quote evidence and recorded transfer outcomes are retained.

Saved-report commands require a complete report containing its original settings and league. Bare/empty `--from-scan`, malformed reports, a conflicting `--league`, and combinations with `--move` are rejected before input starts. A pricing pass can overwrite the same saved report safely: it checkpoints the complete capture before the first request.

The installed Windows app bundles its scanner and stores these files under `%APPDATA%/poe2-trade-companion/artifacts/tab-admin`; it can launch from any folder without Node.js, npm, or the source repository. Development commands use the repository's `artifacts/tab-admin` directory. The installed app reuses calibration from its `perception-templates` directory.

Trade pacing follows the server's advertised windows, retains capacity headroom, and shares reservations with the app's other market requests. A large dump can take a long time to price. Server-directed waits are saved with the affected item and remain cancellable; repeated throttling stops the run with its item copies intact.

GGG's [current developer reference](https://www.pathofexile.com/developer/docs/reference) lists account/public stash APIs as PoE1-only. The PoE2 inventory scan therefore uses visible client state and copied item text. Trade-site endpoints are implementation interfaces, not a promise of a documented public stash API.
