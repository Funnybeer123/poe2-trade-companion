# Pricing history (Tools → Pricing)

Draft for `docs/USER_GUIDE.md` → "Tools & QA" → `### Pricing history`.

**Where:** Tools → **Pricing** (`#/tools/pricing`). Deep link with a search
term: `#/tools/pricing?q=Divine`. The optional hotkey **Open Pricing history**
(Tools → Hotkeys, group *Desktop*, unbound by default) brings the window to
front on this screen.

## What it is

Every item poe2scout prices for your league in one table: current price, the
1-, 3- and 7-day change, how much of it traded, and a seven-day sparkline.
Selecting a row draws its timeline — the daily price line over the daily
quantity bars.

poe2scout serves about **seven days** of bars. Each time the price history is
refreshed the app merges those bars into one file per league, so the timeline
keeps growing the longer you use the app. History before your first refresh
cannot be recovered — the header says what it has: *collected since …*.

## What it never does

- No game input at all: no clicks, no chat lines, no Ctrl+C. The Dry-run switch
  and the emergency stop have nothing to stop here.
- No trade2 request, so it never spends the shared trade2 budget and can never
  trigger a rate-limit lockout.
- Nothing is uploaded. The history files hold item names, prices and
  quantities, nothing else — no account, no cookie, no character name.

## Using it

1. **Refresh** — pulls one page per poe2scout category (about 12 paced
   requests, ~7 s). The same 12-hour cache and 5-minute courtesy interval as
   Tools → Market: pressing Refresh on either screen serves both.
2. **Pick a category or search** — the strip counts every row per category.
   Typing in the search box switches to **All** so a search finds items in every
   category (it returns to your category when you clear the box). Press `/`
   anywhere in the tool to jump to the search field, `Esc` to clear it.
3. **Star what you watch** — the star column toggles a favorite, and the
   ★ Favorites tab lists them. Favorites are remembered between sessions
   (up to 200).
4. **Select an item** — click its name for the detail list and the timeline.
   `↑`/`↓` move between rows.

**Show prices in** picks the unit: *Auto* shows anything worth a Divine Orb or
more in divine and everything cheaper in exalted; you can pin *Exalted* or
*Divine*. The footer names the rate it used and where it came from (poe2scout's
own divine price, your price table, or the 40-exalted fallback). The timeline
always draws one unit for the whole window — picked from its most expensive bar
— so an item hovering around one divine is never plotted half in each.

**Sort** by name, price, 1/3/7-day change or 7-day volume, ascending or
descending. Rows without that reading (items with no history) always sink to
the bottom. **Show more** adds another 100 rows.

## Chips and columns

| Chip / cell | Meaning |
|---|---|
| `Estimates, never guarantees` | Every number is poe2scout's daily median, not a sale you are promised. |
| `older than 12 h` | The cached prices are past their refresh window. Press Refresh when convenient. |
| `no history` | The app knows a price for this item from the feed, but poe2scout serves no daily bars for it (uniques and thin currencies). No changes, no sparkline. |
| `low stock` | Under 10 units traded over 7 days, or fewer than 2 bars. Hidden by default — untick *Hide low-stock* to see them; the footer counts what is hidden. |
| `Volume 7 d` | poe2scout's daily quantity summed over the window, plus `deep`/`thin` — not your own sales. |
| `Last refresh failed: …` | The last fetch failed; the table is still showing the cache it had. |

The newest bar keeps moving until that day closes, so the right-hand end of a
timeline can change during the day.

## Expert options

Behind *Expert options* at the bottom of the panel:

- **Keep collecting daily bars locally** — off means the table still works from
  the 7-day feed cache, but the timeline stops growing.
- The history file's path, the date it started, how many items and bars it
  holds and its size (each league file is kept under about 4 MB; past that the
  oldest bars of the biggest items are dropped first, and no item ever falls
  below seven bars).
- **Clear local history** — two clicks, and it deletes only this app's own
  `pricing-history` files.

## Where data lives

| File | Contents |
|---|---|
| `%APPDATA%\poe2-trade-companion\pricing-history\<league>.json` | The merged daily bars for one league: item names, prices, quantities. |
| `%APPDATA%\poe2-trade-companion\companion-settings.json` → `pricing-history` | Favorites, sort, display unit, last category, keep-history. |
| `artifacts\tab-admin\price-trends.json` | The shared poe2scout trends cache. Owned by Tools → Market; Pricing never opens the file itself — it asks the same Market trends service for the cached snapshot, which is why one paced refresh serves both screens. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No price history yet" and an error about several current softcore leagues | poe2scout lists more than one current league, so the app refuses to guess. Pin the league in Tools → Settings → Market data, then Refresh. |
| Refresh does nothing for a few minutes | The trends service allows one fetch every 5 minutes, shared with Tools → Market. |
| Header says a different league than you play | The history is per league and never mixes economies. Pin the right league in Settings → Market data; the old file stays until you clear it. |
| Timeline has only the feed's bars | *Keep collecting daily bars locally* is off, or this is the first refresh for that league. |
| "The history file could not be written" | The app could not write under `%APPDATA%` (disk full, or a sync client holding the file). The table keeps working from memory. |
