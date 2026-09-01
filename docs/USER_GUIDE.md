# How to use PoE2 Trade Companion

Windows-first Electron app for Path of Exile 2 item intelligence. The default app includes parsing, stash queries, builds, and stash automation. Prices shown today come from bundled fixture quotes, not live listings. Emergency stop is **Ctrl+Shift+Esc**.

## Install and launch

Requirements: Windows 10/11, [Node.js 20+](https://nodejs.org/) (see `.nvmrc`).

```powershell
git clone https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
npm install
npm run dev
```

`npm run dev` starts Vite and opens the Electron window titled **Item Intelligence · PoE2 Intelligence**.

If `better-sqlite3` fails after a Node or Electron version change:

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
3. Edit the **Price table** — the only price signal automation trusts (live
   market data is disabled). A matching entry outranks tier rules: at or above
   the *keep* threshold the item detours to Review, at or above *sell* it goes
   to the Sell tab.
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
value — a running "what did the sorter earn me" ledger.

## Item log

Workspace for parse, value, and keep a local catalog. The **Scan sessions**
tab (formerly the Scans page) lives here too.

1. Paste or read clipboard item text.
2. Review identity (class, rarity, base, iLvl, quality, corrupted, identified).
3. Read **Estimated value**: low / fair / high, suggested listing estimate, confidence, and comparable count.
4. Read **Recommendation**: keep / sell-style category, score, and reasons. Active build profiles can boost exact or near matches.
5. The item is stored in the left **Catalog**. Search by name, class, location, recommendation, or modifier text.
6. Click a catalog row to reopen it. Click **×** then **✓** to delete.

Treat every number as an estimate. The bundled market provider is deterministic demo/test data — valuations now carry an explicit **demo prices** badge. Confirm current listings in-game or on official trade before you buy or sell. When a value-tier verdict applies, the item header shows a **tier** chip (keep / sell / dump) with the reason.

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
  currency and unique prices from poe2scout (one request, ~800 entries,
  24h-averaged). Feed rows show read-only under "Market prices from the
  feed"; a manual row for the same item always wins. Crafting orb costs
  (chaos, annulment, divine…) update automatically through the table.
- **Item log → Market comps** searches the official trade site for listings
  like the evaluated item, converts asks to exalted, keeps only listings
  sharing its notable mod families, and shows the lowest/median comparable
  ask. One polite request pair per lookup, cached ten minutes. Works without
  login; a `POESESSID` in Settings is optional.
- **Tools → Settings → Market data**: league ("auto" tracks the current
  softcore league), optional daily auto-refresh while the app runs, optional
  session cookie. Nothing touches the network until you refresh or enable
  auto-refresh.

## Tools & QA

Open **Tools & QA** in the left rail.

### Deal analysis (on the Item log page)

Public, no input. Evaluate an item on **Item log**, then expand **Deal
analysis** under the item detail and enter the seller asking price and optional
fee/slippage. You get estimated margin, return, confidence, and stale-data
warnings. It never whispers, buys, or lists.

### Loot filter

Generates local filter text from a hide-below threshold and unique highlight option. Copy it yourself into your filter file. The app does not write game files or talk to an account API.

### Settings

- Automation defaults shared by every transfer, sort, and scan: process
  allowlist and actions-per-minute rates (stored locally). The **Dry-run**
  switch itself lives in the top bar and applies everywhere at once.
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
| Num4 | **Vendor** — quick-sell the bag to ZELINA (opening her window is wired; the sell click is not yet, see `docs/HANDOFF-hotkey-actions.md`) |
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

## Where data lives

Local-first. Typical Windows path:

`%APPDATA%\poe2-trade-companion\`

| File | Contents |
| --- | --- |
| `item-intelligence.sqlite` | Catalog, builds, rules, scan sessions |
| `scan-sessions.jsonl` | Scanner journal |
| `assistive-artifacts/` | QA traces and capture artifacts |
| `fixtures/benchmarks/occupancy-labels.jsonl` | Dry-run overlay Right/Wrong occupancy labels |

No account telemetry is sent by default. Do not commit this folder, cookies, or session files.

## What this build will not do

- Call undocumented GGG Trade2 APIs or scrape Mobalytics.
- Treat fixture quotes as live guaranteed sale prices.
- Send input from a browser preview.
- Click windows that are not on the Path of Exile process allowlist.

## If something looks wrong

| Symptom | What to try |
| --- | --- |
| Window never opens | Confirm `npm run dev` printed `Local: http://localhost:5173/` and no port conflict. |
| Native module / sqlite error | `npm run rebuild:native:host`, then restart. Electron and host Node use different ABIs. |
| Item will not parse | Clipboard must include `Item Class:`. Re-copy from the game tooltip. |
| Finder is empty | Evaluate or select a catalog item first. |
| Prices look fake or stale | They are fixture data. Confirm on official trade. |
| Transfer buttons disabled | Calibrate stash + bag + search, unlock the e-stop, and keep Path of Exile in the allowlist. |
| Input will not stop | **Ctrl+Shift+Esc**, then confirm the chip says **Emergency stop latched**. |

## Related docs

- `README.md` — project overview
- `docs/GGG_COMPLIANCE.md` — public vs QA boundary
- `docs/QA_AUTOMATION_BOUNDARY.md` — interlocks
- `docs/PRODUCT_SPEC.md` — acceptance criteria
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — parser/source reuse
