> **STILL NEEDS LIVE TESTING (2026-09-04).** Merged to main with these
> parts never exercised against the game:
> - the vendor step of the one-key bag flow (`vendorBagItems` → ZELINA for
>   sub-floor / dump-tier items) — run `shop-buckets.ts --live --step` with
>   a white item in the bag and approve the ctrl-click;
> - the jewel mod-family thresholds in `src/core/modKnowledge.ts` — watch
>   the "priced … (N notable mod(s))" lines on the next jewel bag and tune;
> - implied-user-delist ledger rows (written when re-listing an item the
>   ledger still holds) — confirm the next reprice pass shows no phantom
>   "sold" rows.
> Everything else in this document marked LIVE-VERIFIED has run against
> the game; see the dated STATUS blocks below.

# HANDOFF — Shop: manage public-tab sale listings, then auto-list appraised finds

**Mission** (user's words, 2026-09-01): add a way in the APPLICATION to
automatically manage items that are for sale in the shop, including managing
them in a PUBLIC stash tab. Set that up first; the next phase is identifying
good items in the bag and listing them, with a price lookup and a confidence
score per item. Make it better, more reliable, and more profitable wherever
possible.

## GROUND TRUTH (2026-09-02, user demonstration recorded via scripts/record-teach.ts)

**The shop is NOT a public premium stash tab.** In this build (0.10.0a) it is
the hideout NPC **Ange**'s MERCHANT panel. Session
`artifacts/teach/2026-09-02T04-46-03-882Z` (events.jsonl + frames) is the
reference; every number below is 3840x2160 screen px measured from it.

- **Opening it**: click Ange (world NPC, nameplate "Ange" — OCR it, the
  position depends on the camera) → dialog with rows "Currency Exchange",
  "Manage Shop", "Buy or Sell items", "Goodbye" (world-anchored, OCR the
  row) → **Manage Shop** opens the MERCHANT panel in the stash panel's
  place (title "MERCHANT" in the same title band the stash uses). The
  inventory opens on the right as usual (bag geometry unchanged).
- **Panel anatomy**: two sub-tabs under the title — **Shop** (428,217) and
  **Earnings (Remove-only)** (739,217). Below them a SINGLE numbered tab
  strip (tabs 1-12, green) at y≈288 with scroll arrows at (61,288) /
  (1221,288) and a list chevron at (1288,288) — i.e. exactly the sorter's
  FOLDER-row band and folder chevron (LIST_TOGGLE_FOLDER is (1287,278)).
  The right-side dropdown lists the 12 tabs at x≈1434, rows y≈284 + 47·n
  (TAB_LIST.rowX/region apply). Each tab is a **12x12 grid** spanning
  x 35..1308, y 317..1594 — the same bounds as a folder-tab 12x12 stash
  grid, so `__default_12x12`/folder bounds + lattice detection should
  read it unchanged. "Highlight Items" search box at the bottom (unused).
- **Listing an item** (demonstrated): left-click the item in the bag
  (picks it up) → left-click a merchant grid cell → the **SET ITEM PRICE**
  dialog opens by itself: title "SET ITEM PRICE" centred (1916,810), close
  X (2383,810), text "In order to list an item for sale, you must first
  select a buyout price.", item name in orange, then one row:
  **amount field** (1517,1300) · **currency dropdown** (1834,1300, opens
  on "Exalted Orb") · **LIST ITEM** button (2233,1300). Dropdown options
  at x≈1738, pitch 53px: Exalted Orb 1357, Greater Exalted 1411, Perfect
  Exalted 1465, **Divine Orb 1517**, Chaos 1571, Greater Chaos 1622,
  Perfect Chaos 1674, Alchemy 1728, Annulment 1780, Regal 1834, Greater
  Regal 1885, Perfect Regal 1937, Transmutation 1991 (scrolls further).
  The user picked Divine, typed 1, listed — the item then sits in the tab
  and Ange comments in chat. Offsets relative to the title centre are
  seeded in artifacts/tab-admin/shop-dialog.json (teach mode still
  overrides them).
- **SOLD ground truth exists**: sale proceeds land in the **Earnings
  (Remove-only)** sub-tab (one 12x12 grid headed "-1-"; clicking an item
  there moves it to the bag). Sold detection no longer needs the
  gone-from-tab heuristic as its only signal — an item leaving a shop tab
  while currency appears in Earnings is a verified sale.

Second, narrated recording (`artifacts/teach/2026-09-02T04-57-19-156Z`,
narration.jsonl via `record-teach.ts --narrate`) settled four more things:
- **REPRICE = right-click the listed item.** The same SET ITEM PRICE dialog
  opens, pre-filled with the current amount + currency; edit, LIST ITEM.
  The tooltip then reads the new price immediately.
- **Ctrl+C on a listed item carries NO price** — the copied text is the
  plain (advanced-mods) item text. The price ground truth is the HOVER
  TOOLTIP: an "Asking Price:" line followed by "Nx Divine Orb". The scan
  now hovers each listed item and OCRs that line (`readAskingPrice`,
  `parseAskingPrice`); the Note-line parser stays only as a fallback.
- **The dialog remembers the last currency** (it opened on Divine Orb
  after a divine listing) and **its height follows the item sprite** (the
  bow's price row sat ~200px lower than the gloves'). So: the currency on
  the row is READ every time (never assumed), and every control offset is
  anchored to the **LIST ITEM** line, not the title (title = dialog-open
  proof + close cross). shop-dialog.json is version 2 with row-anchored
  offsets from the recordings: amount (-716,0), currency selector
  (-399,0), LIST ITEM (0,0), options at dx -495 / dy 57 + 53·n (Exalted,
  Greater Exalted, Perfect Exalted, Divine, Chaos, …), close (+467,0)
  from the title.
- **Merchant tabs open the same STASH TAB SETTINGS dialog** on right-click
  (Name + Colour + tick) — `StashTabKit.readDialog` applies, and the user
  can name a merchant tab so `shopTab` label matching works as designed.
- A small **lock icon** appears on the listed item's cell (seen after the
  Ctrl+C); meaning not yet confirmed — likely "listed/locked".
- Still not demonstrated: DELIST gesture (ctrl-click/drag back to the
  bag?) and whether ctrl-click from the bag opens the dialog directly.

**Re-targeting the built code (the core is unaffected):** navigation =
Ange → Manage Shop → merchant tab (strip/list, folder-row geometry), not
the stash strip; `shopTab` config becomes the merchant tab number(s);
phase-2 "deposit" = pick-up-and-place per item followed by the dialog
(one item at a time, verified by the dialog appearing and the cell
filling); delist/reprice mechanics pending the answers above; the
Earnings sub-tab scan becomes the sold-detection primary. The stash-tab
priced/Remove-only protections still apply to the STASH; the merchant's
own "Earnings (Remove-only)" label must not trip the Remove-only refusal
(different panel).

## PRICE-BUCKET TABS (user decision, 2026-09-02): the tab name IS the price

The user renamed the merchant tabs into price buckets — **1Ex, 5Ex, 10Ex,
1D, 2D, 3D, 5D** (the remaining tabs keep their numbers) — and every item
in a bucket tab is listed at exactly that price. This replaces per-item
pricing as the listing model:

- `priceFromTabLabel("5D")` → 5 divine; `bucketTabs(labels)` orders the
  buckets by exalted value at the live rate; `bucketFor(estimateExalted)`
  snaps an estimate DOWN to the dearest bucket it clears (never up — a
  bucket above the estimate overprices). An estimate under the cheapest
  bucket (1 exalted) is not listed. Numeric tabs ("8", "9") are not buckets.
- Phase 2 becomes: appraise + comps → suggested value → bucket → select
  that tab → ctrl-click the item in (dialog pops) → the dialog's amount and
  currency are the BUCKET's → LIST ITEM → tooltip verify. No per-item price
  typing variance; a reprice is a move between buckets (delist + relist).
- `scripts/shop-list-bag.ts --tab=1Ex` derives the price from the label;
  `--reprice --tab=1Ex` brings everything already in the tab to the bucket
  price. Bucket labels OCR reliably (letters + digits) EXCEPT the selected
  tab, whose highlight defeats OCR — the flow then asks the user to click
  it (Numpad 8). Confusables seen live: "IOEx" for 10Ex. "1Ex" never
  OCRs, active or not — `--current` skips tab selection entirely when the
  user already has the tab on screen (the practical way to run a reprice).
- **Bucket flow scripts** (2026-09-02, after the user's tab renaming):
  `scripts/shop-buckets.ts` (npm `shop:buckets` / `shop:buckets:live`) =
  phase 2 on bucket tabs — reads the bucket labels off the merchant strip
  (or `--buckets=`), appraises the bag (price table first, trade2 comps for
  confident rares), snaps each estimate DOWN to its bucket, and lists
  bucket by bucket (`ShopKeeper.planBagBuckets` / `applyBagBuckets`, on top
  of `listBagItems`). `scripts/shop-list-bag.ts` (npm `shop:tab`) lists the
  whole bag into ONE tab at the tab's own price, or with `--reprice` brings
  everything already in that tab to it (`repriceTabItems`, right-click
  dialog, tooltip-verified). Live-verified 2026-09-02: listing from the bag
  (11 items) and repricing 18 divine → 1 exalted via right-click; the price
  dialog's currency selector, amount typing and LIST ITEM all land with the
  seeded row-anchored offsets. Tooltip verification tolerates "lxv"/missing
  "1x" (assumed 1, flagged) and reports the cooldown lock line.
  Reprice pass LIVE-VERIFIED 2026-09-03: `shop:tab -- --reprice --tab=1Ex
  --current --live --step` brought all 10 items in 1Ex to 1 exalted (6
  repriced, 4 already there, 0 failed); every verification read the
  currency with the amount assumed (the 1x glyph never OCRs — eyeball one
  tooltip after a run if in doubt).

- **trade2 rate limits (2026-09-03)**: repeated re-plans of one bag (11
  items × search+fetch) within minutes earn an escalating penalty window
  (429s persisted past a 60s backoff). Handling now: comps cached on disk
  for 10 min (`artifacts/tab-admin/comps-cache.json`) so re-runs are free;
  a 429 waits `Retry-After` inline only when ≤30s, otherwise the window is
  REMEMBERED on disk (`_rateLimitedUntil`) and every run inside it holds
  the bag with "rate limited until HH:MM" instead of touching the API
  (each hit inside the window extends it); a rate limit ends comps for
  the run with every remaining item held by name. Vendor rule: comps
  under the 1 ex floor or dump-tier → sold to ZELINA after listing
  (`vendorBagItems`, `--no-vendor` to keep). Comps AT the floor list at
  the floor (the undercut never goes under it).

- **One-key flow (2026-09-03)**: `Num4 = Shop` in the action daemon
  (`npm run actions:daemon`; the vendor stub gave up Num4 and is unbound by
  default — rebind in Tools → Hotkeys). It runs `shop-buckets --live`:
  poe2scout feed refresh for the configured league (auto = current softcore
  league; `--league=NAME` pins it, persisted in
  artifacts/tab-admin/price-feed.json), Ange → Manage Shop if needed, bag
  appraisal (feed prices for uniques/currency, trade2 comps for rares and
  magic items), bucket by bucket listing with tooltip verification. Bucket
  tabs come from shop.json `bucketTabs` ∪ the strip OCR ∪ `--buckets`. The
  Shop screen's bag button drives the same script (`shop-buckets-dry` /
  `shop-buckets` script kinds). No step gating on the hotkey path; every
  click still shows its bullseye and Numpad 0 stops.

- **Bucket listing LIVE-VERIFIED 2026-09-03**: `shop:buckets --live --step
  --buckets=1Ex,5Ex,10Ex,1D,2D,3D,5D` took 7 bag items → 6 listed in 1Ex
  (rares ≈3.5-4.8 ex, magic items ≈2.6-4.8 ex via derived base types —
  `magicBaseType`, trade2 400s on the full magic name), 1 held (0.95 ex <
  floor). A follow-up `shop:tab --reprice --tab=1Ex --current` pass read all
  16 items in 1Ex at 1 exalted and ADOPTED the ones the ledger had missed
  (the pass records at-price items with no record). Tooltip OCR lessons
  from this run: the hideout's "REFORGING BENCH" nameplate OCRs onto the
  value line ("EXALTED ORB . BENCH"), ORB reads as PRB/0RB, debris lands on
  either side of the currency ("Ixt AD EXALTED ORB", "EXALTED ORB 5Xz") —
  the parser now extracts the amount token anywhere, then recognises the
  currency by its known phrase (`CURRENCY_PHRASE`), and reads the tab
  strip at 2x ("IEx" = 1Ex). Known gaps: a duplicate item (two identical
  quarterstaves) is adopted once, and an item whose read fails twice is
  left unrecorded with a "fix by hand" line.

- **Guards added 2026-09-03 after a runaway scan** (a diagnostic scanned
  with the Merchant closed and "found" a full grid on the hideout floor):
  every scan/bag read now goes through `requirePanel("merchant"|"inventory")`
  (title-band OCR) and throws otherwise; `--current` refuses if the Merchant
  is not already open (the tab would be unknown); `SortHarness.checkpoint`
  re-focuses the game (throttled 2s) when it lost the foreground, so hovers
  and Ctrl+C never land in another window; the step gate re-focuses every
  3s while waiting. The host `ocr` op takes `scale` (2 = upscale before
  recognition, coordinates mapped back): the keeper re-reads the price line
  at 2x when the amount glyph is missing, and reads the merchant strip at 2x
  before the unmask hop. Tooltip amount parsing is order-independent
  ("EXALTED ORB 5Xz" is 5x exalted) and an unreadable amount with the right
  currency counts as "at the bucket price" (never a reprice loop).

- Live lessons from the first listing runs (2026-09-02): (1) the input
  host must pump the overlay's messages while waiting on stdin or Windows
  ghosts the full-screen overlay as a BLACK sheet after 5s (fixed with a
  thread-pool stdin read — `Console.In.ReadLineAsync` is synchronous in
  PowerShell 5.1); (2) a step-mode Numpad 8 lands in whatever text field
  has focus — the amount field kept focus after typing, so approvals typed
  "8" into it (three items listed at 18 divine, one at 188): amount + LIST
  ITEM are now ONE approved step, cleared and typed after the approval;
  (3) the host's waitkey ignores numpad presses unless the game is
  foreground — the step gate now re-focuses the game every 3s; (4) tooltip
  OCR variants: "18X - DIVINE ORB", "ASKING PRICE?"; a fresh listing's
  tooltip says "You assigned a price to this item recently" (cooldown text
  — check whether it blocks repricing); (5) runes ("Augment" class) do not
  open the price dialog on ctrl-click — the game refuses to list them.

## STATUS (2026-09-03 afternoon): FULL-BAG FLOW LIVE-VERIFIED WITH THE LOOKUP SCREEN + HEADER PACING

Plan steps 1–3 of the "price hundreds of items" plan are built and live:

- **Header-based pacing** (`src/core/tradePacing.ts`, `tests/trade-pacing.test.ts`):
  every trade2 response's `X-Rate-Limit-Ip` / `-State` teaches the real
  rules and our standing; a token-bucket pacer keeps one slot per window
  unused and persists its hit log to `artifacts/tab-admin/trade-pacing.json`
  so consecutive CLI runs share ONE budget. Real rules learned live:
  search 5/10s · 15/60s · 30/300s · 600/6h (penalties 60/300/1800/3600s);
  fetch 12/4s · 16/12s · 50/300s · 1000/6h. Server-counted hits we did not
  send are stamped just outside the next-shorter window (stamping them
  "now" jammed the 5-minute window for a minute — fixed same day).
  `feed.tradeBudget()` prints "trade2 budget: N lookup(s) available now".
- **Raw-listing cache by query** (`priceFeedService.ts`): the cache holds the
  fetched listings, not a summary, and the similarity pass runs against
  each item's own mods at read time — one base-type fetch prices every
  item of that base. TTL 6h for base-type searches, 1h for unique names.
- **Lookup screen** (`src/core/lookupScreen.ts`, `tests/lookup-screen.test.ts`):
  keep → held; dump → vendor; price-table hit → local; Normal → vendor
  unless ilvl ≥ 81 (craft stock → floor); unique missing from the table →
  lookup (cheap, by name); rare/magic with ≥1 notable mod (mod knowledge
  base tier 1–3) → lookup, ranked by valueScore × confidence; anything
  else → FLOOR listing (cheapest bucket) with no API call. Lookup
  candidates that cannot be priced (budget spent, rate limited, no
  comparable listings) stay in the bag as "pending pricing" — never
  floored, because a divine-tier rare listed at 1 ex cannot be undone.

Live run (unattended, 12:24–12:33): 17-item bag → screen "2 lookup · 15
floor" → 2 API lookups total (one from cache) → 16 listed into `1Ex`,
1 held (Maelström Visage: +skill-levels helmet whose base had no
comparable listings). 12 tooltips verified in-run; the 4 misses were OCR
parser gaps, all fixed the same afternoon and proven by a reprice pass
(29 verified at 1 ex, 1 miss that the last fix covers):

- "ASKING PRICÉ:" (diacritic) and "AsigNGPRlGE:" (garble) → the label is
  matched after diacritic folding, or by edit distance ≤ 3 on the letters.
- Label missing entirely but the cooldown lines present ("You assigned a
  price… cannot modify or remove") → the cooldown line is the anchor, and
  the 2x zoom crop reaches 320px down from it.
- "IO Ixt05 EXALTED ORB" → a digit-less token is never an amount ("IO"
  had folded to 10x and triggered a pointless reprice of a 1 ex item).
- "1x EXALTED ORB COMPARE" → shortcut hints are stripped from the value
  row, not used to drop it.
- Ledger: listing an item the ledger still holds as listed, with fewer
  copies in the tab than recorded, now writes an implied user delist first
  (the user moving items back to the bag had produced double "listed" rows).

Second full bag (14:23–14:33, 23 jewels + a helmet): screen "5 lookup ·
18 floor", 22 listed / 0 failed, Maelström Visage held. Two more fixes
came out of it, both live-proven on the same bag:
- **Valuable-base rule** (`VALUABLE_BASES` in lookupScreen.ts: Time-Lost,
  Timeless, Diamond): the base itself earns the lookup whatever the mods
  say — a magic Time-Lost Sapphire had screened "no notable mods → 1 ex"
  (the run was killed before it listed). Its comps then put the base floor
  at ≈1 ex in this league, so 1Ex was right by the data — but by evidence,
  not by default. The gear-oriented mod knowledge base has NO jewel
  families, so every other rare jewel floors; adding jewel families (or
  plan step 4's stat filters) is what would lift good jewels above 1 ex.
- **Merchant grid pinned to 12x12**: with 75+ occupied cells the lattice
  detector read the 1Ex tab as 24x24 (four times the sweep, halved cells).
  Merchant tabs are 12x12 by construction; every keeper scan now passes
  `shop: true` and gearSorter pins the grid for shop sources.

- **Jewel mod families** (`modKnowledge.ts`, `tests/jewel-families.test.ts`):
  families now carry an optional `classes` list; for `Item Class: Jewels`
  fourteen jewel-scale families (life %, ES %, skill/attack/cast speed,
  minion speed, crit chance/damage, penetration, leech, all-res, chaos
  res, rarity, generic "increased … Damage" with junk-band thresholds)
  are consulted BEFORE the gear families, and comps similarity judges
  both sides with the item's class. Gear scoring is unchanged (no class
  → generic families only). Thresholds are league-agnostic guesses —
  tune them from the live "priced … (N notable mod(s): …)" lines.

Still open:
- Vendor step (`vendorBagItems` → ZELINA) has still never run live: no
  test bag has held a dump-tier or sub-floor item. Use a white item.
- Plan steps 4–5 not built: stat-filtered comps for the lookup candidates
  (precision above the floor) and background cache warming from the daemon.
- Held lookup candidates with zero comparable listings (Maelström Visage)
  could fall back to the base floor with a flag; today they stay in the bag.
- Per-item verification rescans sweep the whole tab (75+ cells now); a run
  of 16 listings took 9 minutes. Rescanning only the changed region would
  cut most of that.

## STATUS (2026-09-03): ONE-KEY FLOW LIVE-VERIFIED END TO END (unattended)

`npx tsx scripts/shop-buckets.ts --live` (= Num4 in the daemon, = the
app's bag button) ran with no step gates: feed refresh (Runes of Aldur,
divine ≈ 427 ex) → bucket tabs read from the strip at 2x zoom → bag scan
+ Ctrl+C identification → comps for every item (10 comps each, 2s
spacing, cached 10 min on disk) → plan (all 11 items ≈1–4.75 ex → `1Ex`
via the snap-down rule) → Ange → Manage Shop → tab `1Ex` → ctrl-click +
price dialog per item → tooltip verification → ledger. Result: 9/9 listed
in that run (the other 2 had been listed by a detached step run, see
below), 0 failed, all 11 verified at 1 exalted by the reprice pass
(`shop:tab -- --reprice --tab=1Ex --current --live`: repriced 0, skipped
11, Loath Edge adopted into the ledger), bag scan empty afterwards.

Still UNEXERCISED live: the vendor step (`vendorBagItems` → ZELINA).
Nothing in the test bag priced under the 1 ex floor or dump tier, so the
plan had 0 to vendor. First live vendor needs a white/Normal item or a
sub-1-ex comps result in the bag — run `--live --step` for that one.

Ops lessons:
- Killing the launcher shell does NOT stop a run: the node/tsx tree and
  BOTH win-input-host PowerShell instances live on, detached, and keep
  acting on the game (the step run kept listing on the user's Numpad 8
  presses after its log said "[killed]"). Stop a run with
  `taskkill /PID <tsx node pid> /T /F` (PowerShell, not Git Bash — Git
  Bash rewrites `/PID` into a path), and never launch a second run until
  `Get-CimInstance Win32_Process` shows no `win-input-host` lines.
- The ledger only learns about a listing on the run's own verification
  path; anything listed by a run that died mid-way is picked up by the
  next reprice pass on that tab (adoption), so run one after any crash.
- Tooltip reads: "1x" is still mostly unreadable natively (assumed 1x +
  flag); 2x-zoom re-reads produce "Ixt", "lxps", "Ixt AD" — all fold to
  1x by the parser. `[cooldown]` on a reprice skip is informational.

## STATUS (2026-09-01 night): BUILT against the stash-tab model, ZERO LIVE RUNS — see GROUND TRUTH above for what changes

Everything below is implemented through both phases; tsc + eslint + full
vitest green (the only failures are the 13 pre-existing better-sqlite3
NODE_MODULE_VERSION ones). The offline CLI paths were smoke-run for real
(`--report`, `--from-scan` with a fixture); NOTHING has touched the game.

What exists:
- **Core (pure, 84 unit tests)**: `src/core/shopListings.ts` — Note-line
  parser (`~price`/`~b/o`, fractions, currency aliases; unrecognized notes
  = kind "other" = user-priced/read-only), shop.json schema + sanitizer,
  scan snapshots, the append-only ledger (parse/derive/reconcile with
  count-based duplicate handling); `src/core/shopPricing.ts` — percentile
  anchor + undercut + troll-floor guard, integer denomination (whole
  exalted below the divine rate, whole divines above — the dialog types
  this number and the Note re-read must equal it), the reprice ladder
  ("market moved" vs "we overpriced" — comps still supporting the price
  means HOLD; the floor delists), the double gate (appraisal confidence
  AND usable comps), EV×P(sale) ranking with sales-history feedback,
  eviction planning (stale app listings only, every eviction reported),
  per-class realized-sales stats.
- **Sorter seams** (`src/adapters/gearSorter.ts`): cleanTab's phase 1 is
  extracted into `indexTab` (identical code, both callers); public
  `scanTab` (read-only visit), `withdrawItemsSerial` (verified-serial, the
  guild pattern at personal pace), `depositBagCells` with `shiftOnly`
  (shift+ctrl so affinities can never divert a shop deposit),
  `identifyBagItems`, `bagCellsNow`, `copyAt`. A `shop` flag on SourceTab/
  gotoTab mirrors the drain flag: top-level personal-chest only, strict
  labelsEqualFolded match, NO guess fallbacks (bright-header/segment/
  similarity are off), Remove-only still refuses, cleanTab refuses shop
  sources outright.
- **ShopKeeper** (`src/adapters/shopKeeper.ts`): scan → reconcile (sold
  detection, `--record` gates ledger writes) → plan (comps-budgeted) →
  apply (price writes verified by Note re-read, delists = verified-serial
  withdraw + verified return deposit); phase 2 planBag/applyBag (deposit →
  rescan → match fingerprints → price → verify → ledger). The price dialog
  is TEACH-FIRST: anchors OCR'd from a pattern list (extend from the
  logged lines if PoE2's dialog words differ), control offsets taught via
  Numpad-9 clicks in --step mode, stored in
  artifacts/tab-admin/shop-dialog.json; untaught + non-step = refusal.
- **CLI** `scripts/shop.ts` (npm: shop / shop:record / shop:apply /
  shop:apply:step / shop:list / shop:report). Default is a full dry-run;
  comps ride PriceFeedService (same 2s-spaced trade2 queue, configDir =
  artifacts/tab-admin) with a per-run budget; prices/tiers come from the
  app's triage.json export.
- **App**: Shop screen (/shop) — run buttons (respecting the global
  Dry-run switch), step-mode checkbox for the teach run, listings +
  latest plan + realized-sales cards, config form with expert disclosure;
  IPC shop:overview / shop:save-config edit the SAME
  artifacts/tab-admin/shop.json the CLI reads; script kinds ride the
  existing stash-tabs runScript channel.

Decisions taken while building (flag if wrong):
- Ledger ownership: whoever priced last owns the listing ("by"). An app
  price write on a hand-listed unpriced item is a REPRICED event (never a
  second "listed" — no double-count) and takes ownership for the ladder.
- Listing amounts are integers in the chosen currency; anything under 1
  exalted refuses (not worth a slot — floor configurable).
- Phase-2 evictions are planned + reported but executed only via a
  phase-1 delist run, not inline with listing.
- Open-question defaults shipped in shop.json: return=Dump, 5% under the
  25th percentile, stale 3d (ladder -8%@3d, -12%@6d, floor 1ex →
  delist), cap 1 divine, sources=bag. shopTab is EMPTY — everything
  refuses until the user names it (open question 1).

Next session (waiting on the user's go + answers below): validation
workflow steps 2-4. Expect to adjust DIALOG_ANCHORS from the first real
dialog OCR (the failure log prints every line it saw), and verify the
Note line really appears in Ctrl+C copies from the public tab (the whole
design rides on it).

Read docs/HANDOFF-dump-sort.md (Rounds 1-5) and
docs/HANDOFF-sort-performance.md first — their invariants (Ctrl+C is the
only classifier, verified clicks, per-tab-kind grid geometry, one-toggle
dropdown discipline, the overlay debug loop) rule every screen interaction
here too.

## What "the shop" is in PoE2 terms

Player selling happens through a PREMIUM stash tab set to Public: items in
it appear on the trade site, priced either per-item (a `~price N currency`
note set through the item's right-click price dialog on that tab) or
tab-wide (the `~price ...` tab name / the tab settings dialog's price
controls). A listed item's Ctrl+C copy text carries its price as a
`Note: ~price ...` line — **that line is the listing's ground truth**, the
same way `Item Class:` is the sorter's. Moving an item out of the public tab
delists it; moving it in (plus a price) lists it.

## Phase 1 — manage what is already for sale (build this first)

1. **Designated shop tab, explicit and exact.** A config entry (app UI +
   `artifacts/tab-admin/shop.json`) names the ONE public tab the feature may
   touch, matched with `labelsEqualFolded` only. Every other priced/public
   tab keeps the full three-layer protection (enumeration, navigation,
   dialog). Mirror the drain-flag pattern: the CLI/app action is opt-in
   (`--shop` / a Shop screen button), and a garbled label match refuses.
   NOTE: the shop tab is TOP-LEVEL — use the top-level grid geometry
   (`__default_24x24_toplevel`, `STASH_AREA_TOP_LEVEL`); a premium non-quad
   tab is 12x12 (lattice detection already tells them apart).

2. **Listing scan = index sweep of the shop tab.** Reuse cleanTab's phase-1
   machinery (occupancy scan + Ctrl+C sweep, dim-cell rescue, phantom
   store). Each read parses: item identity (class + name + mods via the
   existing parser), and the `Note: ~price N currency` line → the live
   listing state. No pixels ever price anything.

3. **Listings ledger** (`artifacts/tab-admin/listings.jsonl`, append-only
   like finds.jsonl): one record per listing event — listed/repriced/
   delisted/SOLD — with item text hash, cell, price, timestamp, and a comps
   snapshot at decision time. Derived current-state view lives in the app.
   - **Sold detection**: an item in the ledger that is GONE from the scan
     and NOT in the bag/other known location = sold → record realized price
     and date. Realized sales are the most valuable data in this whole
     feature (see "make me more money" below).
   - Distinguish "sold" from "user removed it" only heuristically — report,
     never guess silently.

4. **Reprice / delist actions, verified.** Repricing uses the item's price
   dialog (right-click on the item in the public tab). That dialog is NEW
   driving: anchor every control to OCR'd labels inside the dialog (the
   StashTabKit settings-dialog pattern — nothing addressed by fixed screen
   coordinates), teach-mode gates on first use, and after every write the
   verification is a Ctrl+C re-read of the item: the Note line must equal
   the intended price, else retry once then report. Delist = verified
   withdraw (existing machinery) back to a configured return tab (default:
   Dump — junk semantics keep it there for re-triage).

5. **Shop screen in the app** (respect the minimal-config UI rule): one
   screen listing current listings with age, listed price, current comps
   estimate, and badges — STALE (age > threshold and comps moved), SOLD
   (recent), UNDERPRICED (comps ≥ X% above listing). Actions per row:
   reprice to suggestion, delist. Global: shop tab name, undercut %,
   staleness threshold, dry-run switch (the one global switch). Expert
   options behind a disclosure.

## Phase 2 — identify, appraise, and list new items

1. **Source**: the bag first (the user's words), then the triage Review tab
   (the sell-detour destination the triage layer already fills — the
   natural feeder). One flow: identify by Ctrl+C, appraise, pick listing
   candidates, deposit into the shop tab (verified, affinity hazard rules
   apply), set the price, verify by Note re-read, append to the ledger.

2. **Price lookup — reuse, do not rebuild**:
   - `src/core/priceFeed.ts` — poe2scout currencies/uniques (live-verified;
     respects the feed-row `feed:*` id rules).
   - `src/core/tradeComps.ts` — trade2 comps for rares: `buildCompsQuery`
     from the parsed item, `summarizeComps`/`listingSimilarity`/
     `listingPriceInExalted`. RESPECT trade2 rate limits (the existing
     live-verified fetch path has the pacing; batch lookups, cache per item
     hash, never poll in a loop).
   - `src/core/marketOpportunity.ts` — staleness plumbing.

3. **Confidence score — extend `appraisal.ts`, do not fork it.**
   `appraiseItem` already returns 0-100 value + 0-100 confidence +
   `confidenceBand`. Add a comps-based component: confidence rises with
   comps count and falls with price spread; a listing decision needs BOTH
   appraisal confidence ≥ threshold AND a usable comps summary. Everything
   below threshold routes to the Review tab for the user's eyes — never
   auto-list a guess.

4. **Pricing policy** (pure, unit-tested, in core):
   - Price at the Nth-lowest comparable minus the configured undercut,
     using a low PERCENTILE rather than the minimum (troll/anchor listings
     must not set the price).
   - Denominate sensibly by value band (exalted below a cutover, divine
     above), using the feed's live exchange rate.
   - **Reprice ladder**: stale listings step down on a schedule (e.g. -X%
     after D days, again after 2D) with a floor at the dump-tier boundary —
     below the floor, delist to Dump instead of racing to zero.

## Make it better / more reliable / more money (added by the implementer)

- **Learn from realized sales**: feed the ledger's SOLD records back into
  the value tiers/appraisal weights — classes and mod patterns that
  actually sell (and how fast, at what price vs estimate) should raise
  their tier scores; chronic no-sells should lower them. This compounds:
  the triage layer starts detouring the RIGHT items to sell. It is the
  single highest-leverage profit feature here.
- **Slot economics**: shop space is finite. Rank candidates by expected
  value × estimated sale probability (from sales history + comps depth);
  when the tab is full, the listing flow may evict the worst stale listing
  to make room for a better item — report every eviction.
- **Comps snapshot at listing time** (in the ledger) so repricing can tell
  "market moved" from "I overpriced" — different ladder responses.
- **Sanity rails**: never list an item whose estimate exceeds a configured
  cap without the user's per-item confirmation (a mispriced mirror-tier
  item is the expensive failure mode); never list items matching the keep
  tier; refuse to touch listings whose Note the flow did not write (the
  user's hand-priced items are read-only unless a per-item override is
  clicked in the app).
- **Out of scope, permanently**: auto-responding to trade whispers or
  automating the trade window itself. Listing management on the user's own
  stash is assistive; unattended trading is a different category — do not
  build it.

## Where things live / reuse map

- Sweep/identify/deposit/withdraw + geometry: src/adapters/gearSorter.ts
  (cleanTab phase 1, depositCells, top-level geometry), sortHarness gates.
- Dialog driving pattern + priced-tab guards: src/adapters/stashTabKit.ts
  (`readDialog` anchoring, `applyTabIdentity`'s refusals,
  `looksPricedTabLabel`, the existing `allowPricedTabs` opt-in shape).
- Appraisal/tiers/triage: src/core/appraisal.ts, valueTiers.ts,
  sortTriage.ts (Review-tab routing), bagTriage.ts.
- Prices: src/core/priceFeed.ts, priceTable.ts, tradeComps.ts,
  marketOpportunity.ts; app side src/main/priceFeedService.ts,
  itemIntelligenceService.ts (exports triage.json — shop.json should ride
  the same export path).
- Debug front door for any perception complaint:
  scripts/diag-overlay-items.ts.

## Validation workflow

1. tsc + eslint + vitest green (pure pricing policy, ledger transitions,
   Note-line parsing, confidence math all unit-tested).
2. Dry-run: full shop scan + planned actions printed, nothing clicked.
3. Live phase 1 on the designated tab with step mode for the FIRST price
   dialog (teach the anchors), then a normal live scan/reprice cycle.
4. Live phase 2 with one cheap item end-to-end (list → verify Note →
   confirm it appears on trade site → delist) before any batch.

## Open questions for the user (answer before live)

1. The shop tab's exact name (and confirm it is premium + public).
2. Where delisted/expired items should go (default: Dump).
3. Undercut appetite and staleness thresholds (defaults: 5% under the 25th
   percentile comp; stale after 3 days).
4. Cap above which listing requires manual confirmation (default: 1 divine).
5. Should phase 2 pull from the bag only, or bag + Review tab?
