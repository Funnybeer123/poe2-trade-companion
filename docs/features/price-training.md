# Price training

Price corrections are reusable local examples. The first version learns by
retrieving comparable examples; it does not fit a market-wide prediction model.
This makes every estimate traceable to the items and prices you supplied.

## Everyday loop

1. Open **Tools → Price training**, select a queued item, or use **Teach this
   price** in Item log to carry over its copied text.
2. Enter the item's league and price. Label the evidence **Your estimate**,
   **Observed asking price**, or **Reported completed sale**. A listing is not
   a sale. The defaults are estimate evidence and exact-item matching.
3. Save and inspect **What it has learned**. Later, edit the same example with
   the sale outcome or a better observation. Set the observation date when
   recording older evidence. Removing an example deactivates it without
   erasing the history.

Use scarce market checks on items with no matching example, outdated examples,
or conflicting prices. A representative item can teach a narrowly defined group
when you explicitly choose **Similar items**. Entering known prices, reviewing
the queue, previewing matches, and editing lessons need no network.

## What matches

Exact matches use item features, not the randomly generated rare name. Advanced
copies normalize `15(5-15)%` to the rolled value `15%`; printed modifier tiers
are metadata, not proof of market value. Magic jewel names resolve their actual
Ruby, Emerald, or Sapphire base.

Similarity requires the same class, base, rarity, full modifier patterns,
corruption/mirror/sanctification/split flags, quality and sockets. Every roll
must be within 15% and item level within five. Only examples saved with the
similar scope can generalize. An item with a different second modifier does
not inherit the example's price. Unknown magic bases retain conservative
identities instead of guessing their type.

Leagues are isolated. Current exact evidence takes priority over similar
examples. Each feature fingerprint contributes once, even after repeated
corrections. The estimate is the lower median of distinct examples. The shown
range is the minimum and maximum recorded amounts, not a statistical confidence
interval. Evidence strength is a heuristic score, not a probability of selling.
An individual user estimate starts at 40/100. Recorded sales receive greater
weight. Examples expire after 30 days; mixed currencies or prices over 3× apart
produce a review state rather than an invented conversion or reliable quote.

## Bag appraisal

Unknown-value identified gear stays by default. The map runner saves its copy
to the review queue; teaching does not require another game scan. Positive
matching lessons protect an item from disposal, including matches whose evidence
is stale or conflicting. Such matches have no current numeric quote until
reviewed. The explicit `--drop-unknown` option now drops only items whose
discard audit passed (see [Build-aware decisions](build-demand.md)); review
items stay, and `--keep-unknown` wins if both flags are supplied. Normal Heavy
Belts and Utility Belts keep their crafting-base protection.

Since 2026-09-14 the queue receives only items whose decision is *review*;
keep, list and audited discard proposals are resolved locally. Each queued
reason starts with a priority tag (`[P1]` a near-miss chase item, an unpriced
unique, stale or conflicting evidence; `[P2]` an uncovered class or a line the
knowledge base cannot judge; `[P3]` low information) and the page lists the
queue in that order. On the 32-item evaluation set the queue fell from 17 to 7
entries with zero false discards; on the ten saved bag snapshots (30 distinct
identified items) from 13 to 6.

App and CLI use `artifacts/tab-admin/price-training.jsonl`. The append-only
history stores lessons, corrections, deactivations and review sightings. A
malformed history is reported and prevents trained appraisal from silently
falling back to disposal. The active library is capped at 1,000 lessons and
the review queue at 500 items; older history is preserved. Queue entries with
no pinned league are marked Unassigned and require an actual league before save.

Pin the league under **Tools → Settings → Market data** so CLI appraisal and
the app use the same league. Copy the JSONL file to back it up; it contains item
text, user notes and source links, so keep it out of source control.

## Sparse market checks

**Check market** uses the existing PriceFeedService and shared TradePacer.
Cached raw listings are re-scored locally for each item; the page shows their
fetch time, expiry, listing count and asking-price range separately from lessons.
Current cache durations are six hours for base searches and one hour for
unique-name or stat-filtered searches.

On a miss, a training check makes one search and at most one fetch, limited to
ten listings. It uses an already cached stat catalogue; it never downloads
metadata just to open the training screen. There is no query widening, automatic
retry, or deferred check after a cooldown. Empty results are cached too. The
existing shared budget and server-provided penalties apply; returned rate-limit
headers and Retry-After remain authoritative because GGG's limits can change.
See the [official API rate-limit documentation](https://www.pathofexile.com/developer/docs#rate-limiting).

**Use asking price** fills the form as listing evidence. Saving remains an
explicit step. If a broad base search is the only available sample, inspect its
comparability before teaching; a cheap base listing need not value your modifiers.

## Initial correction

The user's Chilling Sapphire of Chanting (item level 79, 15% increased Cold
Damage, 11% faster Curse Activation) was supplied with a reported price around
one Divine. Its supplied overlay screenshot showed Forbidden Rites and Very Low
reliability. It was recorded locally as **1 divine, estimate, exact**, not as a
verified listing or completed sale. This does not assign one Divine to all jewels.
The previously missing local market configuration was pinned to Forbidden Rites
from that screenshot, so the saved example applies immediately to bag appraisal.

Saved examples also supply the item price-check display in their original
currency. A matching lesson prevents the ordinary item-copy flow from
automatically fetching another set of listings; use the training page's
explicit market check when fresh evidence would help.

## Validation

Pure tests cover feature matching, evidence age, league boundaries and conflicts.
Store tests cover persistence, append-only corrections, deduplication and damaged
history. Appraisal/runner tests cover protected examples and unknown retention.
Mock market tests cover request budgets, cache reuse across restarts, concurrent
requests, canonical Sapphire queries, and 429 handling without retries.
Component and IPC tests verify that ordinary teaching operations remain offline.
No live game test or real trade-price verification was performed for this change.

Final verification on September 14, 2026 (local time):

- `npm run test:all -- --maxWorkers=2`: 2,937 tests in 239 files passed.
  Limiting workers avoids the existing MarketView cold-import timeout seen
  under unrestricted parallel load; no test timeout was relaxed.
- `npm run lint`, `npm run typecheck`, `npm run build`: passed.
- `node scripts/price-training-smoke.mjs`: built Electron UI, real IPC and
  persistence passed with zero HTTP attempts and no game input. It verifies
  exact teaching, normal evaluation, the saved-price Evaluate panel, edit,
  removal after reload, and the item-log handoff. Its temporary app instance
  isolates configuration and blocks outbound requests and native child input.
- Final smoke report and screenshots:
  `artifacts/price-training/smoke-2026-09-15T00-23-24-729Z/`.
