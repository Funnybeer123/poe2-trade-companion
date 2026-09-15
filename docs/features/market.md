# Market — the in-app trade browser

Package `market` · channels `market:*` · settings namespace `market` · hotkey
`market.open` (`Alt+M`, group **Desktop**) · route `/market`. No overlay panel:
Market is a desktop view.

Market builds trade2 searches, keeps favourite searches in folders, watches live
searches over the websocket, and whispers sellers — **one chat line per click**.
It never buys, never accepts a trade, never whispers by itself, and never
touches a secure ("Secure Item") listing except to open it on the trade site.

---

## What it is made of

| Layer | Files |
|---|---|
| Pure model | `src/core/marketQuery.ts` (drafts, labels, colours, sanitizer), `marketTabs.ts` (tab sessions), `marketFavorites.ts` (the folder tree), `marketStatSearch.ts` (autocomplete), `marketListing.ts` (row actions, local sort, seller fold), `marketExchange.ts`, `marketImport.ts`, `marketSettings.ts` |
| Contract | `src/shared/market.ts` |
| Main | `src/main/features/market/{index,service,files,statsSource}.ts` |
| Data | `src/data/market/{category-labels,exchange-currencies,weight-templates}.json` |
| Renderer | `src/renderer/features/market/` (`views/MarketView.vue`, `components/*`, `settings/MarketSettingsSection.vue`, `useMarketStore.ts`, `marketSound.ts`, `marketApi.ts`) |

Row derivation (price text, age band, online state, Q20 defences, DPS, flags),
the fractional-price split, the price note and the query-body inverse all come
from the shared trade2 core (`src/core/tradeListings.ts`, `src/core/tradeQuery.ts`)
so Market, Evaluate and Trade agree on every number.

---

## USER_GUIDE section

> ## Market (trade browser)
>
> ### Opening it
> Click **Market** in the sidebar, or press **Alt+M** from anywhere — the app
> comes to the front on the Market screen. Rebind it in Tools → Hotkeys.
>
> ### Building a search
> Name, base type and free text on the first row; category, rarity, seller
> status and the sort on the second. **Modifiers** below: each group is one
> trade2 stat filter (And / Not / Count / Weighted sum), each row a modifier
> picked from the trade site's own list with a minimum, a maximum and — in a
> weighted group — a weight. **Templates** drops in a ready-made weighted sum
> (total resistance, life + ES, attributes …). **From current item** turns the
> item you last copied with Ctrl+D into filters at 90 % of its rolls.
> *Weighted groups need a session cookie*: trade2 answers "Query is too complex"
> without one.
>
> Equipment, misc and trade filters live behind the **Equipment, misc and trade
> filters** disclosure and open by themselves once anything in them is set.
> Corrupted and Twice corrupted are one exclusive pair.
>
> Press **Enter** in any field to search, or click **Search**.
>
> ### Results and actions
> Each row shows the ask, the same figure in exalted, how long ago it was
> listed, the seller and their online state, and the numbers that matter for
> that kind of item. A `≈ 1 div + 203 ex` hint under a fractional divine price
> is what you would actually hand over — hover it for the rate and where the
> rate came from. Old rows fade.
>
> Per row: **Copy whisper**, **Send whisper** (types ONE line into the game),
> **/hideout** (a separate click, a separate line), **Use as filters** (the
> listing's own modifiers become this tab's filters) and **Copy price note**
> (`~price 5 exalted` for your own stash tab). Click the item name for the full
> item card.
>
> A **Secure listing** shows no whisper buttons at all: it is bought on the
> trade site, never by the app.
>
> After a whisper is sent, that seller's other rows fold into one line (turn it
> off in Market settings).
>
> ### Tabs and favourites
> Ten tabs stay alive at once, each with its own results and scroll position.
> A tab opened from a favourite is **temporary** (dashed outline) and is the
> first one closed when the eleventh tab opens; editing it makes it permanent.
> A dot means the tab no longer matches the favourite it came from.
>
> **Save as favourite** stores the current query; **Update favourite** writes it
> back into the one the tab came from. Those two buttons are the ONLY way a
> favourite's saved query changes — renaming, recolouring or moving a favourite
> in the explorer never touches the query it holds, whatever tab happens to be
> open. Favourites live in folders you can drag them between — or move with the
> ↑ ↓ buttons and the folder dropdown if you prefer the keyboard. Deleting asks
> twice, and so does replacing stat groups you already built (**Use as filters**
> and **From current item** ask once before overwriting them).
>
> `+ Search` and `+ Exchange` start from your Market defaults — seller status,
> sale type, instant buyout and the price sort — so the builder shows the query
> the request will carry.
>
> ### Import from the trade site
> **Import…** in the favourites panel takes pasted trade2 links or a raw search
> document. Parsing happens on this PC and spends nothing. A link that carries
> its full query (`…?q={…}`) becomes an editable tab; a short share link becomes
> an **id-only** tab — good for live search, and Search asks the site for that
> saved search rather than inventing one. The marker survives a restart, so a
> reloaded share-link tab still refuses to run a query you never wrote; edit the
> builder and it becomes a normal search of your own.
>
> ### Bulk exchange
> A `+ Exchange` tab swaps currency in bulk: pick what you have and what you
> want, set a minimum stock, and search. Above the offers, a strip shows what
> the price feed thinks each side is worth — an estimate from poe2scout, never a
> trade2 quote. With more than two currencies in play the offers group by
> seller automatically.
>
> ### Live search
> **Start from this tab** follows a search you already ran (no new search is
> spent) and tells you as new listings are posted. At most twenty run at once —
> the site's own limit. Each has a chime, an optional Windows notification, a
> **Clear** and a **Stop**. If the trade2 budget runs thin, announced listings
> are *dropped rather than queued*, and the count says so; a rate-limit penalty
> stops every live search and you restart them yourself.
>
> ### Request budget
> The chip at the top says how many trade2 slots are spare right now. Market
> shares the budget with Evaluate, Deals, comps and the shop CLI.
>
> | Action | Costs |
> |---|---|
> | Search | 1 search + 1 fetch (the first ten rows) |
> | Load 10 more | 1 fetch (ten ids, however many still exist) |
> | Re-running an unchanged query within 60 s | 0 searches (cached) + 1 fetch |
> | Search exchange | 1 search-policy request |
> | Live search | 0 searches; 1 fetch per ≤ 10 new listings |
> | Stat autocomplete | one request a week at most |
>
> Inside a penalty window every button is disabled with a countdown. Paging
> stops early so two fetch slots stay free for price checks — raise or lower
> that in Market settings → Expert.
>
> ### Settings
> At the bottom of the Market screen: default seller status, sale type and price
> currency for new tabs, when a row counts as old, the collapse-after-whisper
> rule, and the live-search chime and notification. Behind **Expert**: how many
> fetch slots to keep spare, how long a live search may stay open (6 h by
> default), and **Re-open saved live searches at start** — off by default,
> because it opens websockets to pathofexile.com with your POESESSID on every
> app start.
>
> Every number Market shows is an estimate or another player's ask. It is never
> a guaranteed sale price.

---

## Where data lives

All three files are private to this PC, under `%APPDATA%/poe2-trade-companion/`,
written atomically (temp + rename) and read through sanitizers that never throw.
Nothing is written under `artifacts/`.

| File | Holds | Never holds |
|---|---|---|
| `market-favorites.json` | Folders and saved queries (≤ 50 / ≤ 300) | listings, seller names |
| `market-tabs.json` | The open tabs: drafts, labels, colours, the active id (≤ 10) | results of any kind |
| `market-live-searches.json` | Live-search ids, leagues and labels (≤ 20) | listings |
| `companion-settings.json` → `namespaces.market` | The settings above | — |

The POESESSID never reaches the renderer: the state view carries a `hasSession`
boolean and nothing else. Seller names live only in memory, inside the rows a
tab currently holds.

---

## Safety

- **Game input**: only `ChatCommandService.send` — one line per click, with the
  focus hand-off. The kill switch, the process allow-list, the foreground check,
  the 30-per-minute limiter, the dry-run switch and the QA trace are all that
  service's. Market never starts an input host, never types, never clicks, never
  accepts a trade. Send whisper and /hideout are two separate gestures; there is
  no macro that chains them.
- **Network**: only `PriceFeedService` (pacer, HOUSE rules, cookie, 429 memory)
  and the foundation's live-search sockets. No auto-refresh, no polling, no
  background scan of favourites — a tab is searched when you click Search.
  Result ids are capped at 100 per search and fetched ten at a time.
- **Refusals** (each with the reason on screen): a rate-limit penalty window; an
  ambiguous league; fewer than one spare search or fetch; fewer spare fetches
  than the expert setting keeps back; a live search without a session cookie or
  without an existing search id.
- **Never automated**: buying, secure purchases, trade acceptance, whisper
  replies, repeated whispers, bulk scanning of favourites ("refresh all" is
  deliberately absent).

---

## First live checks

Run these once, in order, and record what happened:

1. **Search a base type** — `Ruby Ring`, sort by price. Expect exactly one
   search and one fetch in Tools → Diagnostics, and ten rows.
2. **Page once** — "Load 10 more". Expect exactly one more fetch.
3. **Copy a whisper**, then paste it into the game by hand. Confirm the text the
   site produced is what landed on the clipboard.
4. **Send one whisper with the global Dry-run switch ON.** Expect the notice
   "Dry-run: would type «…»" and no keystroke in the game.
5. **Send the same whisper live**, with Path of Exile in the foreground. Expect
   one line, and that seller's other rows to fold.
6. **/hideout** on a row that names a character.
7. **Bulk exchange** divine → exalted. Expect one request and a plausible ratio.
8. **Live search** from the tab in step 1, with a POESESSID set. Confirm the
   state chip goes `connecting → open`, that a new listing chimes, and that
   Stop closes it.
9. **Weighted template** with and without a session cookie — confirm the
   "too complex" message appears only without one.
10. **Import** a share link copied from the trade site, and confirm it opens as
    an id-only tab (or, once `tradeSearchById` is verified, with results).

---

## Deliberately not done

- **Window placement / ultrawide / in-game hint** — Market is a desktop view.
- **Virtual scrolling** — a tab holds at most 100 rows by budget design.
- **Custom sounds and images** — a WebAudio chime is enough; no asset store.
- **Affix ranges, cultivated symbols, unrevealed mod tiers on rows** — Inspect
  owns tiers, and the per-mod range data does not exist here.
- **Server-side sorting by pseudo stats** — trade2 refuses it anonymously; the
  column headers sort the rows already loaded instead.
- **Market insights from the in-game currency exchange** — the rate strip uses
  the poe2scout feed, the app's only price source.
- **Localisation** — English only, like the rest of the app.
- **Secure-item purchase** — never automated; the row opens the trade site.
- **Currency icons** — text everywhere (`5 exalted`, `≈ 404.62 ex`).

## Unverified, and flagged in the UI

- **Instant buyout** maps to `sale_type: "priced_with_price"`; the option is
  labelled *(unverified)* and the Sale type select is the reliable control.
- **Secure-listing JSON** (the fee field) is read tolerantly; the row is badged
  rather than priced.
- **Exchange currency ids** beyond the orbs are curated guesses until
  `PriceFeedService.fetchStatic()` answers; those rows say "(unverified id)".
- **`tradeSearchById`** is implemented by the feed but unverified live, so an
  id-form import stays an id-only tab.
- **Category ids** past the ones the sorter already uses are transcribed from
  the site's option list and are marked "(unverified)" in the dropdown.
