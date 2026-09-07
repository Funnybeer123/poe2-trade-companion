# How to use PoE2 Trade Companion

Windows-first Electron app for Path of Exile 2 item intelligence. The default app includes parsing, stash queries, builds, and stash automation. Prices come from the poe2scout feed in your price table, on-demand trade2 listings, and a local appraisal heuristic — every number is an estimate, never a guaranteed sale (see [Market prices](#market-prices-live-feed--comps)). Emergency stop is **Ctrl+Shift+Esc**.

## Install and launch

Requirements: Windows 10/11, [Node.js 24+](https://nodejs.org/) (see `.nvmrc`; `npm test` runs vitest under Electron's bundled Node so `better-sqlite3` matches the app's ABI).

```powershell
git clone https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
npm install
npm run dev
```

`npm run dev` starts Vite and opens the Electron window titled **Item Intelligence · PoE2 Intelligence**.

If `better-sqlite3` fails after a Node or Electron version change, `npm install` (its `postinstall`) rebuilds it for Electron; the manual equivalent is `npm run rebuild:native:electron`. Only when a script must use sqlite under plain Node:

```powershell
npm run rebuild:native:host
```

Then restart `npm run dev`.

Optional public Windows package:

```powershell
npm run pack
```

`npm run pack` builds the same companion with transfers enabled.

## Copy an item from Path of Exile 2

1. Focus the game and hover the item.
2. Copy it with the usual PoE shortcut (`Ctrl+C`). The text must start with `Item Class:`.
3. In the companion, either:
   - press **Ctrl+D** (global hotkey while the Electron app is running), or
   - open **Items** and click **Read clipboard**, or
   - paste the text and click **Evaluate text** / **Ctrl+Enter**.

The bottom-left rail shows **Client detected** or **Client not detected**. Transfers only click when that window is Path of Exile.

## Status chips

| Chip | Meaning |
| --- | --- |
| **Automation on** | Transfers, sort, and scans can send input to Path of Exile. |
| **Preview · no input** | Browser-only Vite page, not the Electron app. Intelligence still works on pasted text. |
| **E-stop ready · Ctrl+Shift+Esc** | Generated input can be killed instantly. |
| **Emergency stop latched** | Generated input is frozen until you click **Re-arm input**. |

## Sort & triage (home screen)

The **Sort** screen is the app's home. It runs the gear sorter and holds the
value logic that pulls winners aside automatically.

1. Check the readiness list (desktop app, client detected, input armed).
2. Edit **Value tiers** — three rule buckets:
   - **Keep** — high value; during sorting these detour to the **Review** tab.
   - **Sell** — worth listing; goes to the Sell tab (or Review if unset).
   - **Dump** — vendor trash; goes to the **Dump** tab.
   Rules use scan-rule syntax (`"quoted terms"` AND, `|` OR,
   `"ANY_RESIST >= 2"`, `"TOTAL_ELE_RES >= 70"`). Anything that matches no
   bucket files normally by class. Unidentified or unreadable items are
   **never** dumped — they always route to Review or the normal flow.
3. Edit the **Price table** — the only price signal automation trusts. Live
   market data flows *into* it: **Refresh market prices** on the Prices tab
   adds read-only poe2scout rows next to your own (yours always win). A
   matching entry outranks tier rules: at or above the *keep* threshold the
   item detours to Review, at or above *sell* it goes to the Sell tab.
4. Click **Sort gear** to run (with the top-bar **Dry-run** switch on, the
   button becomes **Preview gear sort** and only overlays — no clicks).
   Value tiers and the price table live on the **Value tiers** and **Prices**
   tabs of the same page. During a run each withdrawn bag-load is read item by item
   (Ctrl+C per cell, clipboard restored afterwards) before deposit. Numpad:
   **8** good, **9** wrong (then show the correct spot), **5** pause,
   **0** stop.

Create **Review**, **Dump** (and optionally **Sell**) tabs inside the Gear
folder first — an unreachable routing tab just leaves those items in the
normal class flow. The CLI equivalent honours the same config
(`npx tsx scripts/sort-gear.ts`, disable with `--no-triage`).

**Vendoring policy:** the app can classify and quarantine trash, but it never
clicks a vendor's accept/confirm button. Empty the Dump tab at a vendor
yourself — that final click is always yours.

### Appraisal: value score and confidence

Every evaluated item now gets an **appraisal** with two separate numbers:

- **Value score (0-100)** — how good the item looks, from the strongest
  evidence available: a price-table hit (stack-aware for currency: 12
  Exalted Orbs = 12 × the unit price), an explicit tier rule, or weighted
  scoring of its mods against a built-in knowledge base (life, spirit,
  resistances, movement speed, +skill levels, crit, added damage, rarity,
  and more — each with T1/T2/T3 roll thresholds).
- **Confidence (0-100%)** — how trustworthy that evidence is, banded
  very-high / high / medium / low. A price-table name match is ~95%; an
  explicit rule ~72-85%; pure mod heuristics scale with how many top-tier
  rolls were found; unidentified items are always low.

The Items view shows both meters plus a per-mod breakdown (which mod family
matched, its tier, and the points it contributed), an estimated worth when
the price table knows the item, and a craft-base hint for sparse rares with
a strong roll.

**How it drives sorting:** an item with no explicit rule match but a high
score and enough confidence is *promoted* to keep/sell and detours to the
Review tab. The **Min. confidence to detour** setting on the Sort screen is
the gate — raise it toward 80-90 and only near-certain finds get pulled
aside; heuristics can never send anything to Dump. Explicit rules always
outrank the heuristic, so if a monster item lands at "sell", it is because
your sell rule matched it — tighten or remove the rule to let the appraisal
decide.

### Recent finds

Every detoured keep/sell is logged to `artifacts/tab-admin/finds.jsonl` with
its score, confidence, origin tab, and destination. The Sort screen's
**Recent finds** card lists the latest finds and totals their estimated
value — a running "what did the sorter earn me" ledger. A craft-tab detour
(below) logs with tier **craft** and the craft hint as its reason.

### Craft tab (craft-to-sell loop)

Set an optional **Craft tab** under Value tiers. A rare whose verdict is
unknown or sell, with at most four affixes and at least one strong roll
(the appraisal's craft hint), detours there instead of its class or Sell
tab — keep and dump verdicts are never overridden, and the confidence gate
still applies. The craft tab is never cleaned as a source. To work the tab:

```
npx tsx scripts/craft-gear.ts --from-tab=Craft              # dry-run: what would be withdrawn + each plan
POE2_CRAFT_LIVE=1 npx tsx scripts/craft-gear.ts --live --from-tab=Craft --then-list
```

`--from-tab` pulls the tab into the bag by the sorter's own verified-serial
withdraw before the crafting sweep; `--then-list` hands the bag to
`scripts/shop-buckets.ts` afterwards (dry-run unless the craft run is live),
but only once the crafting host has closed and no other input host is
running. Neither flag has had a live run yet.

## Wealth

The **Wealth** page is the stash net worth. Every sort run journals each
item it identified by Ctrl+C — tab, cell, fingerprint, and the appraisal's
estimate — to `artifacts/tab-admin/inventory.jsonl`. The page reduces that
ledger to current whereabouts (a tab's latest scan defines its contents; a
later sighting elsewhere means the item moved; currency stacks coexist per
tab) and prices it with the local price table, stack-aware, falling back to
the sorter's estimate. It shows the total in exalted and divine (at the
table's Divine Orb rate), a per-location table with last-scan age, the top
25 items, a sell list for a value band (1–5 ex by default, with **Copy
names**), and a search box. **Refresh** re-reads the file and mirrors the
observations into the Item log's catalog with their current location.
Items last seen in the bag show as *bag (in transit)* until their tabs are
scanned again. Estimates are never guaranteed sale prices.

## Item log

Workspace for parse, value, and keep a local catalog. The **Scan sessions**
tab (formerly the Scans page) lives here too.

1. Paste or read clipboard item text.
2. Review identity (class, rarity, base, iLvl, quality, corrupted, identified).
3. Read **Estimated value**: low / fair / high, suggested listing estimate, confidence, and comparable count.
4. Read **Recommendation**: keep / sell-style category, score, and reasons. Active build profiles can boost exact or near matches.
5. The item is stored in the left **Catalog**. Search by name, class, location, recommendation, or modifier text.
6. Click a catalog row to reopen it. Click **×** then **✓** to delete.

Treat every number as an estimate and confirm current listings in-game or on
official trade before you buy or sell. The **Estimated value** panel carries a
provider chip that says where the number came from, in the order the app
trusts them:

| Chip | Source |
| --- | --- |
| **price table** | An exact name/base entry in your price table (poe2scout feed row or your own). Stack-aware for currency: 12 Exalted Orbs = 12 × the unit price. Confidence high. |
| **trade listings** | Real trade2 listings for this item (cached comps): low = cheapest comparable, fair = median, high = dearest comparable, suggested listing from the shop pricing policy. Confidence follows the sample size (8+ high, 4+ medium, fewer low) and carries the troll-floor caution when the cheapest ask sits far under the median. |
| **appraisal** | No entry and no listings — the mod-tier heuristic's value score mapped onto the crafting value curve, with a deliberately wide 0.6×–1.6× band and at most medium confidence. |
| **no data** | Nothing could price it: zeros, confidence none. |

**Ctrl+D**, **Read clipboard**, and **Evaluate text** are deliberate price
checks: they value the item instantly from the table, any cached comps, and
the appraisal, then — if no comps are cached — fire one trade2 lookup in the
background and update the panel again when listings arrive (only while the
same item is still on screen). The passive clipboard watcher (which picks up
anything you copy in-game) and stash scans value items locally only and never
touch the network. The **demo prices** badge appears only in the browser-only
preview and test runs, where bundled fixture quotes stand in for market data.

When a value-tier verdict applies, the item header shows a **tier** chip (keep / sell / dump) with the reason.

## Search & rules — Query builder

Turns the current item into stash-search strings that PoE can accept. The
former **Finder** and **Rules** pages are now two tabs of one **Search**
page.

1. Evaluate an item on **Item log** first.
2. Open **Search**.
3. Choose identity fields (name, base, class) and which affixes to include.
4. For numeric affixes, switch **Match** to **Numeric range** and set min/max.
5. Optionally add custom lines (one alternative per line).
6. Set **Maximum stash query length** (stash search is short; default is conservative).
7. Click **Generate validated queries**.
8. Copy a query into the in-game stash search box.

**Combine selections** chooses the semantics: **OR** (default) packs
alternatives into one regex per query and splits over-length sets into
multiple labeled queries; **AND** emits one query of multiple quoted terms —
the in-game search requires every term — and reports a conflict instead of
splitting when the set exceeds the length limit. Nothing is silently
truncated. You can also save a generated expression into a rule set from this
page.

## Builds

Local gear-target profiles. This is not a full character planner and it does not scrape third-party build sites.

1. Click **+ Create profile**, name it, set league/tags if you want, then **Save profile**.
2. Or paste official trade2 search URLs / exported query JSON into **Trade targets** and import. Opaque search IDs are stored as provenance only; the app never fetches them.
3. Add **Gear targets** (slot + item class) and optional **stat rules** (`exists`, `eq`, `gte`, `lte`, `between`, `contains`).
4. Set exact-match and near-match desirability boosts.
5. Click **Make active**. Evaluated items then get a build-aware score bump when they fit.
6. Use **Target coverage** to see how much of the local catalog already fills those slots (exact / near / missing).

Source URLs are reference-only and are never requested.

## Search & rules — Rule studio

OR-of-AND matchers used by the query builder, QA scans, and the Sort screen's value tiers.

- Space-separated quoted terms are AND.
- `|` separates OR alternatives.
- Example: `"maximum life" "fire resistance"| "cold resistance"`.
- Use **+ AND** / **+ OR** helpers, then **Save**.
- Invalid regex or over-broad patterns fail validation and cannot be saved.
- Mark a set **Active** so scanners and Finder quick-save use it.
- **Import** accepts legacy scan-history or regex-history JSON.

## Item log — Scan sessions

Offline review of imported or QA-generated sessions (a tab of the **Item log** page).

- Import JSONL for review. That creates records only and sends no input.
- Open a session to inspect slot status (matched / missed / timeout) and any parsed item payload.
- **Stash scanner** is collapsed at the top of the detail pane. Pick a grid (normal stash 12×12, quad 24×24, inventory 12×5) and start. Turn on the top-bar **Dry-run** switch if you only want a journal. **Ctrl+Shift+Esc** latches the kill switch.

## Market prices (live feed & comps)

The price table stays the only signal automation trusts — live data flows
*into* it, tagged with its source, and your manual rows are never overwritten.

- **Sort → Prices → Refresh market prices** pulls the current league's
  currency, stackable, and unique prices from poe2scout (one or two requests,
  never more often than every five minutes; uniques under 2 ex are skipped).
  Feed rows show read-only under "Market prices from the feed"; a manual row
  for the same item always wins. Crafting orb costs (chaos, annulment,
  divine…) update automatically through the table.
- **Item log → Market comps** searches the official trade site for listings
  like the evaluated item, converts asks to exalted, keeps only listings
  sharing its notable mod families, and shows the lowest/median comparable
  ask. One search + one fetch per lookup, serialized and paced from the
  server's own rate-limit headers (the pacing log is shared with the CLI
  flows); raw listings are cached on disk — six hours for base-type
  searches, one hour for unique-name searches — and re-scored for each item,
  so one fetch prices every item of that base. A 429 is remembered and the
  penalty window reported instead of retried. Works without login; a
  `POESESSID` in Settings is optional and only ever sent to pathofexile.com.
- **Tools → Settings → Market data**: the **league** picker lists poe2scout's
  current leagues. `auto` follows the current softcore league but is refused
  when poe2scout lists more than one current league — pick one explicitly so
  prices never come from the wrong economy. Also: optional daily auto-refresh
  while the app runs, optional session cookie. Nothing touches the network
  until you refresh, run a deliberate price check, fetch comps, or enable
  auto-refresh.

## Tools & QA

Open **Tools & QA** in the left rail.

### Deal analysis (on the Item log page)

Public, no input. Evaluate an item on **Item log**, then expand **Deal
analysis** under the item detail and enter the seller asking price and optional
fee/slippage. You get estimated margin, return, confidence, and stale-data
warnings. It never whispers, buys, or lists.

### Deals watchlist

**Tools & QA → Deals** re-runs saved trade2 searches on a timer and flags
listings priced well under the going rate. It is decision support only: an
alert shows the ask, the reference price, the discount and the seller, and
**Copy whisper** puts the seller's own "@Name Hi, I would like to buy your …"
message on your clipboard. The app never sends the whisper, buys, or lists.

- **Add a watch** with one of three presets: **Unique by name** (name + base
  type), **Base type** (base or item class, optional minimum item level, rare
  and magic listings only), or **Stat-filtered rare** (a base plus up to three
  mod families at a minimum roll, resolved to trade2 stat ids from the same
  catalogue the comps use). Each watch has its own threshold (alert at or
  under this share of the reference, default 60 %), minimum sample (priced
  listings the search must return before an alert is trusted, default 4) and
  interval (default 10 minutes). **Watch this item** on the Item log page
  builds the watch from the evaluated item — a unique by name, a rare from its
  top notable mods — and opens the Deals tool.
- **Reference price**: for a unique the poe2scout feed row for that name and
  base when the price table has one; otherwise the median of the priced
  sample. The sample is the cheapest listings the search found, so alerts are
  asks that sit well under even that floor band — read the listing before you
  whisper (bait, bad rolls and corruption all look like deals).
- **Budget**: one search plus one fetch per scan, paced from the server's own
  rate-limit headers and shared with price checks and the shop flow. At most
  one scan every 30 seconds, only while at least three lookups are spare (so a
  bag listing run always has headroom), never more than 20 scans an hour, and
  nothing at all inside a trade2 penalty window. The budget line shows what is
  spare and when the next scan is due; **Scan now** runs one watch immediately
  (ignoring its interval, never the penalty window or hourly cap).
- **Alerts** appear newest first with a discount badge; an alert for a listing
  is raised once and only again if its ask drops further. **Dismiss** hides
  it. With **Desktop notification** on, each new alert also raises a Windows
  notification ("Deal: Temporalis 120 exalted (−45%)").
- Watches, the master switch and dismissals live in
  `artifacts\tab-admin\watchlist.json`; the alert history is the append-only
  `artifacts\tab-admin\deal-alerts.jsonl`.

### Market trends

**Tools & QA → Market** turns poe2scout's daily price history into three
answers. **Refresh** pulls seven days of daily prices per currency category
for the pricing league (about a dozen paced requests; the result is cached
for twelve hours in `artifacts	ab-admin\price-trends.json`, and the tool
refuses while the league is ambiguous, like everything else that prices).

- **Rising / Falling · 3 d** — the biggest three-day movers with their
  one-, three-, and seven-day change, seven-day volume, and a volatility
  hint, so a spike on thin volume reads differently from a broad move.
- **Stack advice** — for every currency the price table knows: **hold**
  when the price is rising, **sell** when it is falling, otherwise neutral,
  with the numbers that decided it. It is advice about timing, not a
  guarantee; the exchange and trade site set the price you actually get.
- **What to farm** — price × seven-day volume, scaled to the leader: what
  is both valuable and liquid right now. A price-table row for the item
  wins over the feed price when you have one.

The same trend appears as a **Trend 3 d** column on the feed rows of
**Sort → Prices**, read from the cache only (that column never fetches).

### Loot filter

Builds a Path of Exile 2 item filter from the price table, so refresh market
prices first. The preview rebuilds as you type:

- **Chase / Valuable / Pickup** thresholds in exalted (defaults 50 / 5 / 1)
  decide how loudly a base is shown: font size, border, alert sound, beam,
  and minimap icon per tier.
- **Uniques are rated per base type** — a filter cannot see a unique's name,
  so each base glows at the most valuable unique that drops on it ("Silk Robe"
  lights up because Temporalis might). Every other unique stays visible
  unless you untick **Always show every unique**.
- **Currency and stackables** match by exact name at their per-unit value.
  Time-Lost, Timeless, and Diamond jewel bases are always shown at the
  valuable tier whatever their mods.
- The only **Hide** rule targets Normal gear below an item level (default 65;
  0 = never), optionally Magic gear too. Currency, waystones, gems, jewels,
  tablets, and anything the table does not mention are never hidden — the
  file ends with a default Show.
- The summary counts highlighted bases per tier and the table rows a filter
  cannot express (rarity-only floors, named rares).

**Copy** puts the text on the clipboard; **Save…** opens a file dialog that
defaults to `Documents\My Games\Path of Exile 2\` with a `.filter` name. The
app never writes game files without that pick. Select the file in-game under
Options → Game → Item Filter (or reload with `/itemfilter`).

### Settings

- Automation defaults shared by every transfer, sort, and scan: process
  allowlist and actions-per-minute rates (stored locally). The **Dry-run**
  switch itself lives in the top bar and applies everywhere at once.
- Market data: league picker, daily auto-refresh, optional `POESESSID` (see
  [Market prices](#market-prices-live-feed--comps)).
- Runtime: mode, e-stop, detected PoE windows.
- Reminder: **Ctrl+D** price-check, **Ctrl+Shift+Esc** e-stop, **Ctrl+Alt+V** voice transfer.

### Calibration, Transfers, Sort stash, Diagnostics

Calibrate the stash, bag, and search box before live transfers. Sorting the
open tab and fixture replay (Diagnostics) stay in this Tools section.

## Move bag items into stash

1. Calibrate once under **Tools & QA → Calibration**: bag grid, stash grid, and stash search box.
2. In Path of Exile, open stash and inventory yourself. The app does not click the hideout chest.
3. Open **Tools & QA → Transfers**.
4. Click **Empty** for bag → stash. **Fill** is stash → bag.
5. Leave the top-bar **Dry-run** switch off for live clicks. Turn it on if you only want a plan. After a dry-run, the overlay outlines each complete item; click an item (Shift-click to add more) and mark **Right** or **Wrong** to label occupancy.

Voice fill uses **Ctrl+Alt+V** by default. **Ctrl+Shift+Esc** stops all generated input.

## Numpad hotkey game actions (dev/CLI)

A standalone daemon (`npm run actions:daemon`) listens for numpad presses while
Path of Exile 2 is the foreground window and runs one game action at a time:

| Key | Action |
| --- | --- |
| Num1 | **Stash** — verify stash + inventory are open (reopens the stash via its world nameplate if needed), then deposit the bag |
| Num2 | **Sort** — run the class-routed stash sorter |
| Num3 | **Fill** — stash → bag |
| Num4 | **Shop** — price every bag item for the current league (price-table feed + trade2 comps through the lookup screen, which only spends lookups on items with notable mods or unpriced uniques), then list each in its price-bucket merchant tab (1Ex, 5Ex, 10Ex, 1D …) via Ange's Manage Shop. Num0 stops. Rehearse with `npm run shop` (dry-run); `npm run shop:apply` is the live flow, see `docs/HANDOFF-shop-listings.md` |
| — | **Vendor** — quick-sell the bag to ZELINA (opening her window is wired; the sell click is not yet, see `docs/HANDOFF-hotkey-actions.md`). Unbound by default; bind it under **Tools → Hotkeys** |
| Num6 | **Identify (map)** — with a Scroll of Wisdom stack parked in the very top-left bag cell, identify all unidentified gear in the bag, evaluate each against your value-tier regex rules, and drop the not-good ones on the ground |
| Num7 | **Vendor cycle (map)** — /hideout, sell every identified junk item to ZELINA (same verdicts as Num6's drops; currency/maps/unidentified never offered), then re-enter the same map through its portal. Test first with `npm run vendor:cycle` (dry-run) |

Num5/0/8/9 never launch actions — they stay the in-run control keys
(pause / stop / step verdicts) of every spawned flow.

The key map is editable in the app under **Tools → Hotkeys** (saved to
`artifacts/hotkey-bindings.json`; a running daemon picks changes up on the
next keypress — no restart). The panel also shows the reserved control
keys and the daemon's last activity. Note the actions themselves run in
the standalone daemon, not inside the app — the app supplies the rules
(value tiers, price table, calibration) the scripts consume.

Hideout-only by construction: Stash and Vendor both require OCR-locating a
world nameplate first and refuse if it isn't found. Identify is the opposite —
it refuses while the stash panel is open (a stash means hideout/town, where
ground drops are refused) and verifies the scroll by Ctrl+C before any click.
Test it first with `npm run map:triage` (dry-run: sweeps the bag and prints
the plan without clicking); `npm run map:triage:run` is the live flow Num6
triggers. Items that match keep/sell rules, clear a price threshold, or get
heuristically promoted stay in the bag; explicit dump matches and rule-less
unknowns drop (pass `--keep-unknown` to drop only explicit dump matches).
The default FAST mode reads one point per item (perception segmentation +
batched copies), identifies everything in one shift-held click chain,
drops in burst clicks, and finishes by compacting the remaining items to
the left side of the bag (the scroll stays pinned at the top-left) — about
30 seconds for a full bag. It evaluates all identified gear in the bag.
`--no-compact` skips the compaction; `--careful` selects the original
slower per-cell flow, which only drops what it just identified (there,
`--include-identified` widens it after a capped or aborted run).
Every identify and drop is verified by re-copying the cell and journaled to
`artifacts/map-triage/journal.jsonl`. Every action is logged to
`artifacts/action-daemon.log`. Stop the daemon with **Ctrl+C**.

### Auto-flask (life & mana)

The daemon also runs an **auto-flask guard**: it watches the life and mana
globes and presses the flask key the moment the fluid drops below a trigger
point you set by clicking — measured reaction is roughly 30–60 ms (one
screen readback per tick, ~33 Hz, plus a 25 ms key press).

1. Stand somewhere safe with full life and mana (town / hideout).
2. In the app open **Tools → Hotkeys → Auto-flask** and press **Calibrate by
   clicking** for *life*: the game comes to the front with a banner; click the
   life globe at the exact height where the flask should fire. Repeat for
   *mana*. (CLI alternative: `npm run flask:calibrate`.)
3. Check the keys (defaults **1** life, **2** mana — any digit or letter),
   the cooldowns (minimum gap between presses while the globe stays low;
   3 s / 4 s by default), tick **Enable auto-flask**, and **Save**.
4. Optional: **Test now** samples both globes and shows filled / low for
   each. `npm run flask:status` prints the same from the CLI.

The guard is live whenever `npm run actions:daemon` runs (or standalone:
`npm run flask:guard`; `npm run flask:guard:dry` logs WOULD-fire events
without pressing anything). **Numpad −** pauses / resumes it in game.
Config lives in `artifacts/flask-guard.json`; saves apply within a second.

How it decides: the averaged colour at the trigger point is compared with
what your calibration click measured. Fluid is saturated and bright at any
hue (red life, teal energy shield over life, blue mana); empty glass is dark
and grey. So "filled" = chroma and brightness above a fraction of the
calibrated colour (expert ratios in the panel). It never presses before the
HUD has been seen filled once, only while Path of Exile 2 is the foreground
window, and after ~12 s without any filled read (death screen, passive tree,
loading) it slows to one press per 10 s. Known limits: a full energy shield
covering a low life globe reads as "filled" (set the life trigger higher on
ES builds), and a low globe while the chat box is open would type the key
into chat.

## Where data lives

Local-first, in two places. Per-user data under `%APPDATA%\poe2-trade-companion\`:

| File | Contents |
| --- | --- |
| `item-intelligence.sqlite` | Catalog, builds, rules, scan sessions, value tiers, price table |
| `price-feed.secret.json` | The optional `POESESSID`, alone — never under the repo folder |
| `scan-sessions.jsonl` | Scanner journal |
| `assistive-artifacts/` | QA traces and capture artifacts |

Shared with the CLI flows under the repo's `artifacts\tab-admin\` (gitignored;
keep it out of cloud sync if you can):

| File | Contents |
| --- | --- |
| `price-feed.json` | Market data settings (league, auto-refresh) |
| `feed-snapshot.json` | The newest poe2scout snapshot any process fetched |
| `comps-cache.json` | Raw trade2 listings per query (6h / 1h) and any remembered rate-limit window |
| `trade-pacing.json` | trade2 rate-limit pacing log shared by the app and the CLI flows |
| `trade-stats.json`, `mod-tiers.json` | trade2 stat catalogue and the mod tiers learned from listings |
| `price-trends.json` | Market trends cache (12h) |
| `triage.json` | The app's value tiers + price table mirrored for the scripts |
| `inventory.jsonl` | The sorter's inventory ledger (Wealth) |
| `listings.jsonl`, `earnings-snapshot.json`, `shop.json` | Shop ledger, Earnings baseline, shop settings |
| `watchlist.json`, `deal-alerts.jsonl` | Deals watchlist and its append-only alert history |
| `fixtures/benchmarks/occupancy-labels.jsonl` | Dry-run overlay Right/Wrong occupancy labels (repo) |

No account telemetry is sent by default. Do not commit this folder, cookies, or session files.

## What this build will not do

- Bulk-scan the trade API or scrape build sites: trade2 lookups are
  on-demand, one search + one fetch per item, paced from the server's
  rate-limit headers, and cached; poe2scout is read at most every five minutes.
- Treat any estimate — feed row, comps band, or appraisal — as a guaranteed
  sale price.
- Write a loot filter or any other game file without your explicit file pick.
- Send input from a browser preview.
- Click windows that are not on the Path of Exile process allowlist.

## If something looks wrong

| Symptom | What to try |
| --- | --- |
| Window never opens | Confirm `npm run dev` printed `Local: http://localhost:5173/` and no port conflict. |
| Native module / sqlite error | `npm run rebuild:native:host`, then restart. Electron and host Node use different ABIs. |
| Item will not parse | Clipboard must include `Item Class:`. Re-copy from the game tooltip. |
| Finder is empty | Evaluate or select a catalog item first. |
| Prices look wrong or stale | Check the provider chip: **appraisal** / **no data** mean no feed row or listings matched — refresh market prices (Sort → Prices) or fetch **Market comps**; **demo prices** means the browser preview. Confirm on official trade. |
| Comps say rate limited | trade2 put us in a penalty window; the message shows when it lifts. Cached comps keep working meanwhile. |
| Transfer buttons disabled | Calibrate stash + bag + search, unlock the e-stop, and keep Path of Exile in the allowlist. |
| Input will not stop | **Ctrl+Shift+Esc**, then confirm the chip says **Emergency stop latched**. |

## Related docs

- `README.md` — project overview
- `docs/GGG_COMPLIANCE.md` — public vs QA boundary
- `docs/QA_AUTOMATION_BOUNDARY.md` — interlocks
- `docs/PRODUCT_SPEC.md` — acceptance criteria
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — parser/source reuse
