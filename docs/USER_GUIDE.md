# How to use PoE2 Trade Companion

Windows-first Electron app for Path of Exile 2 item intelligence. The default app includes parsing, stash queries, builds, and stash automation. Prices come from the poe2scout feed in your price table, on-demand trade2 listings, and a local appraisal heuristic — every number is an estimate, never a guaranteed sale (see [Market prices](#market-prices-live-feed--comps)). Emergency stop is **Ctrl+Shift+Esc**.

> **New in 2026-09:** Home, Market, Trade, Evaluate, Inspect, Commands & notes,
> Stash tracker, Campaign guide, Pricing history and the reworked Settings come
> from the PoE Overlay II port. They are implemented and unit-tested offline;
> **none of them has been run against the live game yet**, so treat their
> in-game behaviour as unverified and keep the **Dry-run** switch on for the
> first pass. `docs/HANDOFF-overlay-port.md` lists every check still open.

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

## Teach and correct prices

Open **Tools → Price training**, or **Teach this price** beside an evaluated
item in Item log. Select a review item or paste its copied text, enter its
league and price, then save. Start with **Your estimate** and **Exact item**.
Record a completed sale only after the item actually sells. Edit that saved
example when you have better evidence; the earlier entry remains in local history.

The bag checker now keeps unknown-value gear by default and queues it for
review. Normal Heavy Belts and Utility Belts remain protected crafting bases.
Saved positive prices also keep matching items. **Similar items** is an
optional scope restricted to the same base, rarity, modifier patterns and
condition, with nearby rolls and item level. It does not teach every Sapphire
the same price. Evidence older than 30 days or conflicting prices requires review.

Local previews and saves use no trade requests. **Check market** is a separate
action: it reuses cached listings, otherwise allows at most one search and one
fetch of up to ten listings. Pin the same league in **Tools → Settings → Market
data** to use lessons during bag appraisal and to check listings. Items found
before a league is pinned enter the queue as **Unassigned**; choose their
actual league before teaching. See [Price training details](features/price-training.md).

## Status chips

| Chip | Meaning |
| --- | --- |
| **Automation on** | Transfers, sort, and scans can send input to Path of Exile. |
| **Preview · no input** | Browser-only Vite page, not the Electron app. Intelligence still works on pasted text. |
| **E-stop ready · Ctrl+Shift+Esc** | Generated input can be killed instantly. |
| **Emergency stop latched** | Generated input is frozen until you click **Re-arm input**. |

## Home

**Home** is the app's landing screen. It answers who is playing, what this
session did, what the stash and the market look like, and what is still worth
setting up.

Everything on it is derived from Path of Exile 2's own `Client.txt` and from
files other parts of this app already wrote. **It sends no game input and makes
no network request** — the refresh links point at the paced tools that do (Sort
for the price feed, Tools → Market for trends). Every worth figure on it is an
estimate from your own price table, never a guaranteed sale price.

### Character & campaign

The character comes from the game's own lines, in this order of trust:

1. a `… (<class>) is now level N` line seen while the app is running;
2. the same line found in the last 2 MB the client log backfills at start-up,
   so starting the app mid-session still shows the character;
3. the manual override in **Tools → Settings → Session & recap**;
4. a `<name> has been slain.` line — a name only, no class or level.

A real level-up always beats the override. Campaign progress tracks the
furthest area by act, part and area level, with towns ordered after the act's
areas; the campaign is marked complete the first time a map run starts or the
endgame town is entered. The card shows the level difference against the
current area as a tone ("On pace", "N levels under the area — consider side
areas", "Over-levelled by N — move on"). It never prints a percentage and never
says XP: experience maths belongs to the campaign guide.

Experience per hour, time to next level, and experience or gold per map need an
account link this app does not have. They render as `Needs account link (not
available)` and are never estimated.

### Session & maps

A session starts with the first log line (or the first time Path of Exile is
seen running) and ends when

- the process is gone for four consecutive polls (about a minute) **and** the
  log has been silent for two minutes (`game-exit`) — and only if the process
  probe saw Path of Exile at least once during this session, because a probe
  that fails looks exactly like a closed game;
- the log has been silent for the configured idle window while the process is
  gone (`idle`);
- the app quits (`app-quit`);
- or you press **End session & start fresh** (`manual`).

Area lines are the only source of map runs — PoE2 has no "you have entered"
line. The rules:

| Situation | What happens |
| --- | --- |
| A map area at level 65+ that is not a claimable hideout | Starts a run; tier = area level − 64, with 81/82 (irradiated, corrupted) shown as T16 |
| A Sanctum area | Starts a `trial` run |
| A Breach / Delirium / Expedition / Ritual / Incursion / Abyss area | Starts a `league` run, unless it was entered from inside a map — then it counts as part of that map |
| Hideout or town | Suspends the run; time there is not counted as active |
| The same area id **and seed** again | Resumes the same run and counts a portal |
| A different map, a campaign area, or thirty minutes without coming back | Finalizes the run |

"Completion" is by hideout return: a map you left on purpose counts as
complete; one the session ended inside counts as abandoned. There is no
in-game completion signal to read, and the card says so. Maps per hour excludes
AFK time and stays blank until ten active minutes have passed, because a rate
from three minutes is noise.

### AFK and post-game recap

`/afk` opens the **Session recap** overlay panel, centred, without keyboard
focus, with three pages (Session · Maps · Stash) you switch by clicking.
`/afk off` hides it again when *Close it again when AFK ends* is on. Closing
the panel yourself keeps it closed until the next AFK.

The post-game recap is a card on Home rather than an overlay panel, because the
overlay hides itself once Path of Exile is gone. A Windows notification carries
counts only (maps, rate, deaths, duration) — never item or chat text.

Trade activity in the recap is read from the Trade page's `trade-history.json`
when it exists; without it the recap shows the `Trade accepted` /
`Trade cancelled` and whisper counts from the log. The trade card always names
the period it covers ("Since 21:00" while a session is running, "All recorded
trades" when none is), because that file keeps two weeks. Stash gains in divine
are labelled "at an assumed 405 ex/div" whenever neither the tracker summary
nor any snapshot carried a real rate.

### Death screenshots (replay-lite)

A moment after each `has been slain.` line the app captures one frame of the
game window and writes it, plus a thumbnail, under
`%APPDATA%\poe2-trade-companion\deaths\`. The capture hotkey does the same on
demand.

- **Window only by default.** The whole-screen fallback is an expert switch
  (off): a screen grab can include Discord, a browser and other people's chat.
- **Exclusive fullscreen captures black.** The app detects that, retries once
  and then skips the shot with an explanation. Set the game to borderless
  windowed.
- Screenshots stay on this PC. They are never uploaded, never attached to a
  webhook and never included in a notification. They can show chat and player
  names — the Deaths tab says so.
- The newest 60 (`maxDeathScreenshots`) are kept; older files and their index
  rows are removed automatically. Deleting one by hand is a two-click action.

This is not a replay recorder: there is no video and no pre-death buffer, so
nothing before the death line can be recovered.

### What is set up

The setup checklist is the same payload Tools → Settings renders (see
[Settings](#settings)); Home draws it with links to whatever fixes each step.
Below it, at most five **recommended actions**, blocking ones first: no
Client.txt, an ambiguous pricing league, an empty or stale price feed, no stash
session, a stale trends cache, repeated deaths.

## Sort & triage

The **Sort** screen runs the gear sorter and holds the value logic that pulls
winners aside automatically.

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

## Market (trade browser)

**Market** builds trade2 searches, keeps favourite searches in folders, watches
live searches over the websocket, and whispers sellers — **one chat line per
click**. It never buys, never accepts a trade, never whispers by itself, and
never touches a secure ("Secure Item") listing except to open it on the trade
site. Every number it shows is an estimate or another player's ask, never a
guaranteed sale price.

### Building a search

1. Click **Market** in the left rail, or press **Alt+M** from anywhere — the app
   comes to the front on the Market screen. Rebind it in Tools → Hotkeys.
2. Fill the first row (name, base type, free text) and the second (category,
   rarity, seller status and the sort).
3. Add **Modifiers**: each group is one trade2 stat filter (And / Not / Count /
   Weighted sum), each row a modifier picked from the trade site's own list with
   a minimum, a maximum and — in a weighted group — a weight. **Templates**
   drops in a ready-made weighted sum (total resistance, life + ES,
   attributes …). **From current item** turns the item you last copied with
   `Ctrl+D` into filters at 90 % of its rolls.
4. Press **Enter** in any field to search, or click **Search**.

*Weighted groups need a session cookie*: trade2 answers "Query is too complex"
without one. Equipment, misc and trade filters live behind the **Equipment,
misc and trade filters** disclosure and open by themselves once anything in
them is set. Corrupted and Twice corrupted are one exclusive pair.

### Results and actions

Each row shows the ask, the same figure in exalted, how long ago it was listed,
the seller and their online state, and the numbers that matter for that kind of
item. A `≈ 1 div + 203 ex` hint under a fractional divine price is what you
would actually hand over — hover it for the rate and where the rate came from.
Old rows fade.

Per row: **Copy whisper**, **Send whisper** (types ONE line into the game),
**/hideout** (a separate click, a separate line), **Use as filters** (the
listing's own modifiers become this tab's filters) and **Copy price note**
(`~price 5 exalted` for your own stash tab). Click the item name for the full
item card. A **Secure listing** shows no whisper buttons at all: it is bought on
the trade site, never by the app. After a whisper is sent, that seller's other
rows fold into one line (turn it off in Market settings).

### Tabs and favourites

Ten tabs stay alive at once, each with its own results and scroll position. A
tab opened from a favourite is **temporary** (dashed outline) and is the first
one closed when the eleventh tab opens; editing it makes it permanent. A dot
means the tab no longer matches the favourite it came from.

**Save as favourite** stores the current query; **Update favourite** writes it
back into the one the tab came from. Those two buttons are the ONLY way a
favourite's saved query changes — renaming, recolouring or moving a favourite in
the explorer never touches the query it holds. Favourites live in folders you
can drag them between, or move with the ↑ ↓ buttons and the folder dropdown.
Deleting asks twice, and so does replacing stat groups you already built.

`+ Search` and `+ Exchange` start from your Market defaults — seller status,
sale type, instant buyout and the price sort — so the builder shows the query
the request will carry.

### Import from the trade site

**Import…** in the favourites panel takes pasted trade2 links or a raw search
document. Parsing happens on this PC and spends nothing. A link that carries its
full query (`…?q={…}`) becomes an editable tab; a short share link becomes an
**id-only** tab — good for live search, and Search asks the site for that saved
search rather than inventing one. The marker survives a restart, so a reloaded
share-link tab still refuses to run a query you never wrote; edit the builder
and it becomes a normal search of your own.

### Bulk exchange

A `+ Exchange` tab swaps currency in bulk: pick what you have and what you want,
set a minimum stock, and search. Above the offers, a strip shows what the price
feed thinks each side is worth — an estimate from poe2scout, never a trade2
quote. With more than two currencies in play the offers group by seller
automatically.

### Live search

**Start from this tab** follows a search you already ran (no new search is
spent) and tells you as new listings are posted. At most twenty run at once —
the site's own limit. Each has a chime, an optional Windows notification, a
**Clear** and a **Stop**. If the trade2 budget runs thin, announced listings are
*dropped rather than queued*, and the count says so; a rate-limit penalty stops
every live search and you restart them yourself.

### Request budget

The chip at the top says how many trade2 slots are spare right now. Market
shares the budget with Evaluate, Deals, comps and the shop CLI.

| Action | Costs |
| --- | --- |
| Search | 1 search + 1 fetch (the first ten rows) |
| Load 10 more | 1 fetch (ten ids, however many still exist) |
| Re-running an unchanged query within 60 s | 0 searches (cached) + 1 fetch |
| Search exchange | 1 search-policy request |
| Live search | 0 searches; 1 fetch per ≤ 10 new listings |
| Stat autocomplete | One request a week at most |

Inside a penalty window every button is disabled with a countdown. Paging stops
early so two fetch slots stay free for price checks — raise or lower that in
Market settings → Expert.

### Market settings

At the bottom of the Market screen: default seller status, sale type and price
currency for new tabs, when a row counts as old, the collapse-after-whisper
rule, and the live-search chime and notification. Behind **Expert**: how many
fetch slots to keep spare, how long a live search may stay open (6 h by
default), and **Re-open saved live searches at start** — off by default, because
it opens websockets to pathofexile.com with your POESESSID on every app start.

## Trade

**Trade** in the left rail, or **Alt+T** for the in-game panel.

Trade reads the whispers Path of Exile already writes to your `Client.txt` and
turns them into offer cards: who wants what, for how much, and where the item
sits in your stash. Every button types **exactly one chat line** into the game —
the same line you would type yourself. The trade window's **Accept is always
yours**; nothing here accepts, confirms or moves anything, and nothing is priced
through the trade site on this screen (the exalted figures come from your local
price table and are estimates).

### The flow

1. A buyer whispers you. The card appears within a second, the in-game panel
   opens (if the game is running) and you get a Windows notification, an in-game
   toast, or a beep.
2. **Invite** types `/invite <buyer>`.
3. The buyer joins your area — the card moves to **Joined**.
4. **Trade** types `/tradewith <buyer>`.
5. You accept the trade window yourself. The game writes `Trade accepted.` and
   the card becomes a history row.

A **purchase** (a whisper *you* sent) is quieter by design: with *Notify on my
own purchases* off (the default) it makes a card and a history row, but no
notification, no beep and no panel of its own — open the panel with **Alt+T** or
from the Trade view if you want to drive it from in-game.

### Offer cards and states

| Chip | Meaning |
| --- | --- |
| **Buyer** / **Seller** | Someone is buying from you (a sale), or you whispered someone (a purchase). |
| **New** | The whisper arrived; nothing typed yet. |
| **Invited** | You typed `/invite` (or `/hideout` for a purchase). |
| **Joined** | The game logged them joining your area (or you joining their party). |
| **Trading** | You typed `/tradewith`. |
| **Completed** | `Trade accepted.` was matched to this card. |
| **Cancelled** / **Dismissed** | The trade was cancelled, you dismissed the card, or it timed out. |
| **×N** | The same whisper arrived N times (one card, not N). |
| **wrong league** | The whisper's league is not your pinned pricing league. |
| **Secure item** / **Secure?** | The whisper looks like a merchant (Secure) listing, or it carries no stash tab and position. A guess, never a fact. |
| **untested template** | The whisper matched a non-English trade-site template. Those were transcribed, not observed. |

### Actions

| Button | What is typed | Notes |
| --- | --- | --- |
| Invite | `/invite <player>` | Buyers only. |
| Trade | `/tradewith <player>` | |
| Hideout | `/hideout <player>` | Purchases only. |
| Highlight | The item name into the stash search box | Open your stash first. Clearing the box again is your Escape — the app never types a second time for you. |
| Whisper ▾ | Your quick whisper, or a custom line | `Ctrl+Enter` sends. |
| Copy whisper line | Nothing — the clipboard only | Use it when the chat service refuses a non-ASCII name. |
| Kick | `/kick <player>` | |
| Leave | `/kick <your character>` | Needs your character name (seen from a level-up line). |
| Dismiss / Reopen | Nothing | Card bookkeeping only. |

With **Dry-run** on (top bar) the buttons show the line they *would* type and
nothing is sent.

### In-game panel

The panel opens by itself on a new offer while Path of Exile is running
(setting: *In-game panel opens* — Always / Only in town or hideout / Never) and
hides again when no offer is left, unless you opened it yourself or pinned it.
**Alt+T** toggles it. Escape or the × closes it.

**Custom… takes keyboard focus.** While the input is open the overlay is the
foreground window, so press Escape or send the line before clicking the game —
otherwise the click-outside rule closes the unpinned panel. Pinning the panel
keeps it open either way.

### Quick whispers

Up to eight, edited in **Trade → Trade settings**. A template must start with
`@{player}` (a whisper) or `/` (a command) so it can never land in local chat,
and it can only use characters the input host can type. Placeholders:
`{player} {item} {price} {tab} {left} {top} {league} {char} {area}
{latestWhisper}`.

### Notifications and webhooks

Windows notification, in-game toast and a built-in beep are toggled in **Trade →
Trade settings**. Discord and Telegram go to endpoints **you** create, in
**Tools → Settings → Trade webhooks** (next to the market-data cookie):

- Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy
  Webhook URL.
- Telegram: talk to `@BotFather`, create a bot, copy the token, then get your
  chat id.

**Privacy.** Each message contains the item, the price, the league and the stash
position from the whisper — and the other player's character name unless you
untick *Include the other player's name*. That is the same text the game wrote
to your own `Client.txt`; nothing else is sent, ever. Messages are capped at ten
a minute per target, are never retried, time out after ten seconds, and
redirects are refused. The URL, token and chat id live only in
`%APPDATA%\poe2-trade-companion\trade-webhooks.secret.json`, are never shown
again, and are never written into `companion-settings.json`.

### Trade history

The **History** tab keeps 14 days by default (1–90). Rows come from matched
trades, from your own verified shop sales (the Earnings tab the shop flow
re-reads), or from **Add trade**. Edit any row inline; Delete asks twice.

Earnings, Spendings and Profit are **estimates in exalted** at the price table's
current divine rate — the rate and its source are printed under the totals, and
a row whose currency has no rate is counted as "unpriced" rather than guessed.
**Export CSV (includes player names)…** writes
`at,kind,player,item,base_type,quantity,amount,currency,exalted_estimate,league,secure,matched,note`
(UTF-8 with a BOM, so Excel opens it directly); **Copy CSV** puts the same text
on the clipboard. A text value that starts with `=`, `+`, `-` or `@` is exported
with a leading apostrophe so a spreadsheet shows it as text instead of running
it as a formula.

### If Trade looks wrong

| Symptom | What to try |
| --- | --- |
| No cards at all | Tools → Settings: is the Client.txt path found? The readiness row on the Trade view says so. |
| Buttons disabled | Chat commands are off in Tools → Settings, the kill switch is latched (re-arm in the top bar), or an action is already running. |
| "Blocked: Path of Exile is not the foreground window" | Click the game first, or use the in-game panel / a hotkey instead of the desktop button. |
| "the input host cannot type …" | A non-ASCII name or item. Use **Copy whisper line** and paste it into the game. |
| "wrong league" on every card | Pin your league in Tools → Settings → Market data. |
| Panel never appears | The game was not detected; the panel only opens while Path of Exile runs. |
| Panel closed while I was typing | The Custom… input holds focus; press Escape or send first, or pin the panel. |
| Totals look wrong | The divine rate is a fallback — refresh market prices. Every figure is an estimate. |

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

## Evaluate (price-check overlay)

Hover an item in Path of Exile 2, press **Alt+E**, and Evaluate copies it with a
single audited `Ctrl+C`, parses it, builds an **editable** trade2 query out of
what the item actually is, runs **one** paced search plus **one** paced fetch,
and shows the listings, an estimated price band with its sample size, and — for
currency — the bulk-exchange price.

Every number it shows is an **estimate** built from other players' asking
prices. Evaluate never whispers, buys, lists or prices anything in game.

### Using it

1. Hover the item in game.
2. Press **Alt+E**. The panel opens at the cursor as soon as the item is parsed;
   an auto-search runs behind it and fills the table when trade2 answers, so a
   slow lookup never leaves a blank screen.
3. Tick, untick and re-bound rows in the query builder, then press
   <kbd>Enter</kbd> anywhere in it (or click Search) to run it again.
4. Read the **estimated band** under the table: low · fair · high, a confidence
   bucket, how many of the fetched listings were comparable, and which source
   produced the number (trade listings, price table, or the local appraisal).
5. Close it with `Escape`, the Close button, or a click outside the panel.

| Action | Default | What it does |
| --- | --- | --- |
| `evaluate` | `Alt+E` | Copies the hovered item and opens the panel. In dry-run nothing is sent to the game: the clipboard text is used instead (price lookups still run). |
| `evaluate.clipboard` | unbound | Opens the panel for the item already on the clipboard, **without** searching. `Ctrl+D` triggers this alongside the classic price check. |

The capture is one `Ctrl+C` through the shared chat-commands path: process
allowlist, Path of Exile must be the foreground window, kill switch checked, one
line in `assistive-artifacts/qa-action-trace.jsonl`. The item text stays on your
clipboard afterwards, exactly like a manual copy. Repeat presses inside half a
second count as one gesture, and pressing the hotkey again on the same item
re-shows the panel instead of spending a second lookup.

### Profiles

A profile decides how much of the item goes into the search: how many modifiers
are ticked, and how close a listing has to roll.

| Profile | Ticks | Roll share |
| --- | --- | --- |
| **Quick Price** | The four strongest modifiers (one per family), the strongest pseudo total, and DPS (or the dominant defence) | 85 % |
| **Exact Match** | Every searchable line and every property | 100 % (a modifier is pinned at min = max = your roll; a derived property such as DPS stays a floor) |
| **Crafting Base** | Fractured lines only, plus the item's exact item level | 100 % |
| **Broad** | The two strongest modifiers, no item-level floor | 70 % |

The percentages and mod caps are editable in Tools → Settings → Evaluate.

### The query builder

Every line of the item is a row you can tick, untick and re-bound:

- **Modifiers** — with the affix side and tier when your copy carried the
  advanced description (`Ctrl+Alt+C`), otherwise a "T2·learned" badge from the
  ranges the app learned from earlier comps. Hovering a row shows its score, its
  trade2 stat ids and (for a pseudo total) which lines it summed.
- **Pseudo totals** — the trade site's own aggregates: total Elemental
  Resistance, total Resistance, total to Strength, total maximum Life, … They
  only appear when the fetched stat catalogue actually carries them; Evaluate
  never invents a stat id. When a total is ticked, the lines it speaks for are
  tagged "in pseudo" and left unticked.
- **Properties** — pDPS, eDPS, DPS, attacks per second, crit, armour, evasion,
  energy shield, ward, block. Values below 20 % quality are shown normalised to
  Q20 and labelled "Q20 est." — an estimate, since the parser cannot tell a local
  modifier from a global one.
- **Item level, quality, sockets and flags** — plus the tri-state flags
  (Corrupted / Mirrored / Sanctified / Fractured / Desecrated: any, yes, no) and
  "Modifiable only".
- **Search filters** — seller status, listing age and the currency a listing is
  priced in.

A line the stat catalogue does not carry is shown **disabled** with the reason,
rather than silently dropped. With no catalogue at all (first run, offline) the
search falls back to the base type and says so.

### Results

Sortable columns follow the item kind: weapons add DPS, gems level and quality,
uniques the required level, currency the stack size, rares the item level. Each
row shows the price (and its exalted equivalent), the listing's age, the seller
with an online dot, and whether it is a Secure or a whisper listing.

- **◉** opens the listing's own item, with the lines your item also has
  highlighted.
- **Note** copies `~price 5 exalted` to your clipboard (`~b/o` too) — you paste
  it into the stash tab yourself.
- **Whisper** copies the trade site's whisper. Nothing is ever sent.

Changing **Listed in** (the price currency) re-runs the search on its own — it is
the one filter that does, and a repeat inside a minute is served from the cache.
Every other control in the table (sorting, the currency chips, the online / age /
secure toggles, grouping by seller) is client-side and spends nothing.

### Currency and history

For a stackable whose trade2 exchange id is known, Evaluate asks the bulk
exchange once: the best asks, the median price per unit and the stock on offer.
Exalted Orbs are quoted in divine, and the panel always prints the currency the
per-unit numbers are in. When the exchange median and the price feed disagree by
more than a quarter, the panel says so next to the median: it is a cross-check
between two estimates, not a failed request.

The seven-bar **price history** comes from the Market trends cache on disk — it
never triggers a poe2scout fetch of its own. "Open in Market trends" takes you to
the tool that owns refreshing it.

### Budget and etiquette

- One press = **one search + one fetch** (ten listings). "Load 10 more" is one
  further fetch; the bulk exchange is one request.
- The panel shows the spare trade2 lookups live, and a countdown while a penalty
  window is in force. Inside that window every button is disabled and **nothing
  is sent** — no retries, ever.
- The same query body inside 60 seconds is served from the app's cache, so
  toggling a filter costs nothing.
- Auto-search is per item kind (Tools → Settings → Evaluate): on for rares, magic
  items, uniques, gems and currency; off for waystones, normal bases and the long
  tail, which wait for you to press Search.
- The trade2 budget is shared with Deals, Market and the shop CLI.

### Evaluate inside Item log

The "Evaluate — trade listings & price band" section shows the same workbench for
whatever is in the log. It opens **without** searching: Item log has already
spent a comps lookup on that item, so the first Evaluate lookup is a deliberate
press of Search.

### Evaluate settings (Tools → Settings → Evaluate)

| Field | Default | Meaning |
| --- | --- | --- |
| `defaultProfile` | `quick-price` | Which profile a new session opens with. |
| `profiles[id].slack` | 0.85 / 1 / 1 / 0.7 | Share of your roll a listing must reach (0.5–1). |
| `profiles[id].maxMods` | 4 / 99 / 0 / 2 | How many modifiers the profile ticks (99 = every searchable line). |
| `autoSearch.*` | Waystone and normal off, rest on | Which item kinds search on their own. |
| `defaultStatus` | `online` | Seller status for new searches. |
| `defaultIndexed` | Any age | Listing-age filter for new searches. |
| `defaultCurrency` | Any | Restrict listings to one price currency. |
| `captureMode` | `auto` | `clipboard-only` never sends a `Ctrl+C`; the clipboard is used. |
| `pseudoMods` | true | Offer the pseudo totals. |
| `exchangeForCurrency` | true | Use the bulk exchange for stackables. |
| `groupBySeller` | false | Group the result table by seller by default. |
| `pageSize` | 10 | Listings per fetch (1–10; one trade2 fetch takes ten ids). |

Everything is read through a sanitizer: a hand-edited settings file can never
widen a search past these bounds.

### What Evaluate never does

- It never sends a whisper, accepts a trade, buys, lists, or prices an item in
  game. "Copy whisper" and "Copy note" only write to your clipboard.
- It never sends more than one `Ctrl+C` per press, and none at all in dry-run,
  while the kill switch is latched, while another input host is running, or when
  Path of Exile is not the foreground window.
- It never retries a rate-limited request, polls trade2 in the background, or
  scans in bulk.
- It never writes your session cookie, item text or listings anywhere: sessions
  live in memory, and only the settings namespace is persisted.
- It never claims to know a price. Every number is an estimate with its sample
  size next to it.

## Inspect (overlay)

Inspect reads one copied item and tells you what it is worth knowing:
prefix/suffix, tier and roll for every modifier, how good a tier this item level
could ever hold, weapon DPS and defences at 20 % quality, wiki and poe2db links,
and — for waystones and tablets — a danger rating of the map modifiers.

**It reads the clipboard. It never plays the game.** No key is sent, no click is
made, and it makes no network request: the tier ranges come from files the price
feed already wrote (`artifacts/tab-admin/mod-tiers.json`, `trade-stats.json`),
read-only.

### How to use it

1. Hover the item in game.
2. Press `Ctrl+C` (the game's own copy).
3. Press `Alt+I` (Tools → Hotkeys renames or rebinds it; the action is
   **Inspect item**, group **Overlay**).

The panel opens at the cursor. `Escape` closes it; the pin button keeps it open.
Pressing `Alt+I` again on the same item closes the panel, so the hotkey doubles
as a toggle. The same card lives in **Item log**, under the parsed item, with an
**Open in overlay** button.

**Tip — hold `Alt` before `Ctrl+C`.** The game then copies its *advanced*
description: affix names, prefix/suffix, the game's own tier numbers and the roll
ranges. Inspect uses all of it. Without it the panel falls back to what it
learned from past price checks and says so.

### Reading the modifier rows

| Badge | Meaning |
| --- | --- |
| `P` / `S` | Prefix / suffix (advanced copy only) |
| `I` | Implicit — does not use an affix slot |
| `R` / `E` | Socketed rune effect / enchantment — not affixes either |
| `C` / `F` / `D` | Crafted / fractured / desecrated |
| `U` | A unique item's own modifier |
| `?` | Side unknown — the plain copy does not say |
| `T3` | The tier. Hover it: "T3 of 3 · needs item level 68 · learned from 5 listing(s)" |
| `low` | No tier could be established; the rough hand thresholds rated the roll |

The bar under a modifier is how far into its range the roll landed (100 % = the
best end). For a penalty modifier ("reduced Movement Speed") the bar is flipped,
so full is still good.

"top tier for item level 73" means no better tier can appear on this base at this
item level. "T2 possible here (needs item level 76)" means a better tier exists
and this item could hold it. Either line can end with "— T2 from item level 76":
the cheapest step up a **higher**-level base of the same type could hold. The
open-affix count on a plain copy is an estimate, and it discounts the implicit
block — hold `Alt` before `Ctrl+C` for the real numbers.

### Chips

| Chip | Meaning |
| --- | --- |
| `advanced text` / `plain text` | Whether the copy carried the extra annotations |
| `Corrupted`, `Mirrored`, `Sanctified` | The item is sealed: no affix can be added |
| `Unidentified` | Modifiers and tiers stay hidden until it is identified |
| `Deadly` / `Dangerous` / `Caution` / `Info` | The worst map modifier rating on a waystone or tablet |

### Map warnings

Waystones and tablets get their own block: every rated modifier with a severity,
what it does to you, the reward lines (quantity, rarity, pack size) and a list of
modifiers the table does **not** rate.

**The table is community-maintained and unverified.** It is one reading of what
is dangerous, not a fact about the game — a resistance-based build and an evasion
build fear different lines. Re-rate or silence any entry in **Tools → Settings →
Inspect overlay → Map warning overrides**; your ratings apply immediately and
survive restarts.

If the character is in a hideout or town with a waystone copied, the panel adds
where you are and that the warnings apply to the map you are about to open.
Inside a map it names the current area instead. Inspect cannot see the Atlas —
this is only from the client log.

### Inspect settings (Tools → Settings → Inspect overlay)

| Setting | Default | What it does |
| --- | --- | --- |
| Panel position | At the cursor | Where the overlay panel opens |
| Show DPS and defences at 20 % quality | On | The normalised estimate rows |
| Follow the clipboard while the panel is pinned | On | While pinned, re-reads the clipboard once a second and updates itself when you copy another item. Reads only; never writes the clipboard |
| Copy the hovered item on the hotkey | **Off** | Sends exactly one `Ctrl+C` through the audited chat-command path (kill switch, foreground check, dry-run, rate limit) so you can skip step 2. Leave it off to keep Inspect input-free |
| Map warning overrides | None | Your own severity per map modifier, or "ignore" |

### If Inspect looks wrong

| Symptom | What to try |
| --- | --- |
| "Nothing to inspect — hover an item, press Ctrl+C…" | The clipboard holds no item text. Hover the item and copy it first (or turn on copy-on-hotkey) |
| Every tier says "hand thresholds" | No learned ranges yet for those modifiers. Run a price check (Ctrl+D / Evaluate) on a few similar items |
| A tier badge says "the learned ladder does not cover this modifier yet" | The game printed a tier number Inspect cannot place on a ladder. The number is still the game's own |
| The knowledge line says "tier direction unknown" | The learned store has not seen two tiers with required levels yet, so Inspect will not claim which numbering means "best" |
| "That clipboard text is far too large to be a copied item" | Something other than an item is on the clipboard. Copy the item again |
| A link button does nothing | The URL was outside the two allowed wiki hosts, or Windows has no default browser for it |
| Sides show `?` | A plain copy. Hold `Alt` before `Ctrl+C` |
| A map modifier is listed under "Not rated" | The table does not know that wording. Nothing is hidden — read the line yourself |
| The panel does not open | Check Tools → Hotkeys: another application may have taken `Alt+I` |

Tiers, ranges, roll percentages, DPS, defences and map ratings are all
estimates — derived from the item text plus ranges learned from past listings.
They are decision support, not a promise about a price or a safe map.

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

## Overlay panels & hotkeys

The overlay is one transparent, frameless window that floats above Path of Exile
2. It is **click-through everywhere except over an open panel**, so the game
keeps every other click; it follows the display under your cursor (or the
primary display), and it hides itself within five seconds of the game closing.
Panels that take keyboard focus — a search field, Trade's Custom… box — close
when you click the game ("close on click outside"); the rest close with `Escape`
or the Hide-all hotkey. Pin a panel to keep it open either way.

| Hotkey | What it opens | Group |
| --- | --- | --- |
| `Alt+E` | **Evaluate** — price check at the cursor (one audited `Ctrl+C`) | Overlay |
| `Alt+I` | **Inspect** — tiers, rolls, DPS, map warnings, from the clipboard | Overlay |
| `Alt+T` | **Trade** — offer cards for the whispers in `Client.txt` | Trade |
| `Alt+N` | **Notes** — the last cheat-sheet note, without taking focus | Overlay |
| `Alt+F` | **Stash search** — a focused field plus your saved searches | Overlay |
| `Alt+P` | **Stash prices** — price labels over the stash tab you picked | Overlay |
| `Alt+G` | **Campaign guide** — the levelling panel, pinned, auto-showing | Overlay |
| `Alt+M` | **Market** — the desktop window on the Market screen (no panel) | Desktop |
| unbound | Hide all overlay panels | Overlay |
| unbound | Evaluate from the clipboard; show the session recap; capture a screenshot now; invite / trade the latest offer; take a stash snapshot; open Pricing history; show the app window | various |

Every one of them is rebindable under **Tools → Hotkeys**, which groups the
actions by feature, shows the accelerator each one registered with, and reports
a combination another application already holds (the row then reads **Not
active**). Bindings are saved to
`%APPDATA%\poe2-trade-companion\overlay-hotkeys.json`. A few keys are reserved
and cannot be bound: `Ctrl+C`, `Ctrl+V`, `Ctrl+D`, `Ctrl+Shift+Esc`, the voice
hotkey, and Num0–9 with the numpad operators (the game-action daemon owns
those).

Overlay placement, panel scale and opacity, ultrawide handling,
primary-monitor-only and *Test overlay* live in **Tools → Settings → Overlay**.

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

### Pricing history

**Tools & QA → Pricing** lists every item poe2scout prices for your league:
current price, the 1-, 3- and 7-day change, how much of it traded, and a
seven-day sparkline. Selecting a row draws its timeline — the daily price line
over the daily quantity bars. Deep link with a search term:
`#/tools/pricing?q=Divine`.

poe2scout serves about **seven days** of bars. Each refresh merges those bars
into one file per league, so the timeline keeps growing the longer you use the
app; history before your first refresh cannot be recovered, and the header says
what it has (*collected since …*). No game input, no trade2 request, nothing
uploaded — the history files hold item names, prices and quantities and nothing
else.

1. **Refresh** — pulls one page per poe2scout category (about 12 paced requests,
   ~7 s). The same 12-hour cache and 5-minute courtesy interval as Tools →
   Market: pressing Refresh on either screen serves both.
2. **Pick a category or search** — the strip counts every row per category.
   Typing in the search box switches to **All** so a search finds items in every
   category, and returns to your category when you clear it. Press `/` anywhere
   in the tool to jump to the search field, `Esc` to clear it.
3. **Star what you watch** — the star column toggles a favorite and the
   ★ Favorites tab lists them (up to 200, remembered between sessions).
4. **Select an item** — click its name for the detail list and the timeline;
   `↑`/`↓` move between rows.

**Show prices in** picks the unit: *Auto* shows anything worth a Divine Orb or
more in divine and everything cheaper in exalted; you can pin *Exalted* or
*Divine*. The footer names the rate it used and where it came from (poe2scout's
own divine price, your price table, or the 40-exalted fallback). **Sort** by
name, price, 1/3/7-day change or 7-day volume; rows without that reading sink to
the bottom, and **Show more** adds another 100.

| Chip / cell | Meaning |
| --- | --- |
| `Estimates, never guarantees` | Every number is poe2scout's daily median, not a sale you are promised. |
| `older than 12 h` | The cached prices are past their refresh window. Press Refresh when convenient. |
| `no history` | The feed knows a price but serves no daily bars for it (uniques, thin currencies). No changes, no sparkline. |
| `low stock` | Under 10 units traded over 7 days, or fewer than 2 bars. Hidden by default — untick *Hide low-stock*. |
| `Volume 7 d` | poe2scout's daily quantity summed over the window, plus `deep`/`thin` — not your own sales. |
| `Last refresh failed: …` | The last fetch failed; the table still shows the cache it had. |

Behind **Expert options**: *Keep collecting daily bars locally* (off means the
table still works from the 7-day feed cache, but the timeline stops growing),
the history file's path, start date, item/bar counts and size (each league file
is kept under about 4 MB, oldest bars of the biggest items dropped first, never
below seven bars per item), and **Clear local history** — two clicks, and it
deletes only this app's own `pricing-history` files.

If the tool says "No price history yet" and reports several current softcore
leagues, pin the league in Tools → Settings → Market data and refresh: the app
refuses to guess which economy you play in.

### Commands & notes

**Tools & QA → Commands & notes** keeps four small lists. Every entry can be
bound to a global hotkey, and every hotkey press does exactly one thing:

| List | One key press does |
| --- | --- |
| Commands | Types **one** chat line (Enter, the text, Enter) |
| Stash searches | Fills the game's stash search box **once** |
| Bookmarks | Opens a page in your browser, or in one always-on-top window |
| Notes | Shows a cheat sheet in the overlay |

**What it never does.** It never repeats a line, never chains two gestures,
never retries a blocked attempt, never clicks anything in the game, and never
touches the network. Chat lines go through the same audited path as every other
in-game keystroke in this app: the emergency stop (`Ctrl+Shift+Esc`) blocks
them, the global **Dry-run** switch turns them into previews, Path of Exile must
be the foreground window, and every attempt — sent, previewed or blocked — is
written to the QA action trace. Those gates apply in every build mode.

- **Commands** are a name plus one chat line, which may carry placeholders
  filled from your `Client.txt` and the resolved league: `{player}` (the last
  incoming whisper's sender), `{latestWhisper}`, `{char}` (your character name
  from the last level-up line), `{area}`, and `{item} {price} {tab} {left}
  {top} {league}` from the last incoming **trade** whisper. The editor shows a
  live **Would send:** line with today's values, so `/invite {player}` reads
  `/invite Bob` before you ever bind a key. Two things stop a line and both are
  visible in the editor first: an **unresolved placeholder** (no whisper has
  arrived, so the line is refused rather than sent with a hole in it) and **a
  character the input host cannot type** (anything outside printable ASCII — a
  whisper that lost its `@` would become public chat). A line starting with
  neither `/` nor `@` goes to whatever chat channel the game has selected,
  usually local chat; the editor says so. Starter examples are only written to
  disk once you press **Save**.
- **Stash searches** are a name plus the text to type, typed into the search box
  exactly as written, so the game's regex forms work: `"^Waystone"`,
  `"tier: 1[5-6]"`, `rarity: unique`. `Alt+F` opens the **Stash search** overlay
  panel — a focused field plus your saved searches as chips. Press Enter (or
  click a chip) and the panel hands keyboard focus back to the game, the app
  brings Path of Exile to the front, verifies it, and fills the box once. If the
  game was not there you get "Blocked: not-foreground" and nothing is typed or
  retried.
- **Bookmarks** are a name plus an `http`/`https` address; anything else
  (`javascript:`, `file:`, `data:`, an address carrying a user name and
  password) is refused when you save it and again when it is opened. Two modes:
  **External browser** (default), or an **overlay window (always on top)** — one
  sandboxed browser window with its own cookie jar (it never sees the app's
  trade session), no pop-ups, and no camera/microphone/location. It **does**
  take keyboard focus, and an exclusive-fullscreen client will cover it.
- **Notes** are a title, an icon, a markdown body and one optional image
  (PNG/JPEG/WebP/GIF, at most 2 MB). `Alt+N` shows the last note in the overlay
  without stealing focus from the game; a per-note hotkey opens that note
  directly. The markdown subset is deliberately small — headings, paragraphs,
  bullets, numbered lists, fences, quotes, rules, bold/em/code and `[text](https://…)`
  links. Tables, images-by-URL and raw HTML are not rendered; HTML in a note is
  shown as text, never executed, and a link only opens after the address has
  been validated again.

Bind keys inline on each row, or in **Tools → Hotkeys**, where these actions
appear in the groups **Overlay** (Notes `Alt+N`, Stash search `Alt+F`),
**Commands**, **Stash searches**, **Bookmarks** and **Notes**. Per-item keys have
no default: nothing is bound until you choose a key, and switching an item off
removes its hotkey and keeps the row.

| Symptom | What to try |
| --- | --- |
| "Blocked: another input host" | A sorting run, the numpad daemon or the flask guard owns the input host. Stop it and press again. |
| "Blocked: empty — unresolved placeholder(s): {player}" | No whisper has arrived yet. Wait for one, or use a line without placeholders. |
| "Blocked: not-foreground" | Click the game first (hotkeys pressed while playing already satisfy this). |
| Hotkey row shows **Not active** | Another application holds that combination. Pick a different one. |
| Nothing is typed at all | The **Dry-run** switch is on (the buttons say "Preview"), or chat commands are switched off in Settings. |
| The bookmark window is invisible | Path of Exile is in exclusive fullscreen. Switch the bookmark to "External browser". |

### Stash tracker

The Wealth page prices your stash *now*. **Tools & QA → Stash tracker** adds
*time*: it freezes the sorter's `Ctrl+C` ledger into named snapshots, compares
any two of them (including what left the stash), tracks what a play session
gained, sums each tab, lets you exclude items you never intend to sell, and
draws worth over time. It can also label the tab you have open in-game with
those same numbers.

**It never sends input to the game and never touches the network.** The only
game-facing call is a single passive read of the Path of Exile window rectangle,
and only when you press the hotkey or a button. Every number is an estimate from
your own price table and the sorter's appraisals — never a guaranteed sale price.

- **Snapshots.** **Take snapshot** saves the ledger's current worth; a named
  snapshot is a *manual* one and is never pruned automatically. **Auto-snapshots**
  happen on their own: the tracker checks the ledger file every 10 seconds and
  writes one when it has changed and then stayed quiet for a minute. The same
  ledger state never produces two. **Start session** stamps a new session, and
  the app anchors one when it launches with a non-empty ledger.
- **History and Compare.** History lists snapshots newest first with kind, item
  count, effective worth and the change against the previous one. Compare puts
  two side by side — **Current (unsaved)** is the live ledger, so you can measure
  a mapping run without saving first. Rows are `added`, `removed` (the thing
  vendor tools usually forget), `changed` (same place, different stack size or
  value) and `moved` (same item, different tab), filtered by kind, by minimum
  |Δ| in exalted and by text.
- **Per tab and exclusions.** The per-tab table totals every location the ledger
  knows, with its items, excluded items, unpriced items, value and how old that
  tab's last scan is. **Exclude** removes an item from every total the tracker
  shows and keeps its row struck through so you can put it back — use it for
  your own gear, league-start staples, or anything the price table over-values.
- **Timeline.** The last 24 hours are drawn snapshot by snapshot; older history
  collapses to one point per day (that day's last snapshot, drawn hollow). Gold
  points are named snapshots, blue ones session starts; hover any point for its
  exact value.

**The in-stash price overlay (`Alt+P`).** Press it with the stash open and the
tracker (1) reads the Path of Exile window rectangle — one passive query, no
input; (2) works out where that tab's grid is; (3) draws one rounded box and one
price per item in a click-through window; (4) opens the small **Stash prices**
legend in the overlay. The labels are the ledger's *last scan* of that tab, not
live perception, and the caption always names the tab, the scan age and "est.
prices". Clicks over the grid go to the game; only the legend is clickable, and
it never takes keyboard focus. Legend buttons: ◀ ▶ change the labelled tab, ▲
marks the tab as top-level, ↻ re-reads the window and redraws, × (or Escape)
hides everything.

**Which tab is labelled is your choice** — the app cannot see which stash tab is
open without driving the game. **Top-level tabs** draw their grid one strip row
higher than a tab inside a folder; tabs named `T1`…`T99` are detected
automatically, and for anything else use ▲ or list the tab under Expert options.
The overlay needs a taught grid for that tab, a taught `__default_*` grid, or a
calibrated stash grid (Tools → Calibration) — without any of them it refuses and
says so rather than guessing.

Expert options hold the auto-snapshot switch and its cap (100, 20–500; named
snapshots are never dropped), label fading by value, showing unpriced items as
"?", a minimum value to label, the legend toggle and the top-level tab list.

| Symptom | What to try |
| --- | --- |
| "Nothing in the ledger yet" | Run a sort; the tracker reads what the sorter records |
| Labels are one row too high or too low | Toggle ▲ in the legend, or list the tab under Expert options; better, teach the grid with `calibrate-grid` |
| "No calibration for this tab" | Tools → Calibration, or teach the tab's grid |
| "Kill switch latched" / "input host busy" | Re-arm from the top bar, or wait for the daemon or CLI that owns the input host |
| Labels show the wrong items | They are the last scan of that tab, not live — re-run the sort for that tab |

Special stash layouts (Breach, Expedition, Fragment, Delirium, Essence, Ritual,
Socketables, Abyss, Gem tabs) are not covered: the sorter does not perceive those
as grids, so the ledger never sees them.

### Campaign guide

**Tools & QA → Campaign guide** is a levelling companion: the route for every
act, the area you are standing in right now, whether you are under- or
over-levelled for it, a schematic world map, and a small in-game panel that
appears by itself while you are in the campaign.

The guide never moves your character, never types, never clicks and never
fetches anything. It reads two kinds of line out of `Client.txt` — the
"Generating level N area" line and the level-up line — and nothing else. The
only thing it can send anywhere is a wiki link you click, which opens in your
normal browser. **Route data is community-maintained and unverified:** every
area and every objective in the bundled route carries `verified: false`, both
screens say so, and anything wrong can be fixed in the app.

1. **Open the tool.** Without the game running it still shows the whole route;
   the "you are here" strip fills in as soon as the game writes an area line.
2. **Enter a campaign area.** The strip shows the area, its act and the
   instance's own monster level, and the in-game panel appears at the edge of the
   screen (unless you turned that off).
3. **Read the current strip.** The chip is the experience estimate; the line
   under it is the suggested next step ("Next (suggested): …").
4. **Tick objectives** with the checkbox. "Reach …" objectives tick themselves
   when you walk into the area they name; un-tick one and it stays un-ticked.
5. **Filter by reward.** The chips above the acts (gems, passives, stats,
   currency, unlocks, ascendancy, league) hide objectives whose rewards you do
   not care about. Objectives with no reward tag always show; "optional" hides
   the side objectives.
6. **The map tab** draws one lane per act: main-path areas on the line, side
   areas below them, towns as squares, waypoints ringed. Click a node to read its
   card beside the map.
7. **Fix what is wrong.** "Edit area", "Add objective", "Hide", "Up"/"Down" and
   the per-area note live on the area cards; "Add an area" is on the Edit tab,
   pre-filled when the guide met an area it does not know. Your changes never
   touch the bundled file — they live in your own settings.
8. **Share corrections.** Edit → "Copy route JSON" exports the merged route with
   your edits folded in; "Import (merge)" and "Import (replace my edits)" read
   someone else's JSON back in. Imports over 2 MB are refused.
9. **`Alt+G`** toggles the in-game panel (rebind it under Tools → Hotkeys).
10. **Guide settings** at the bottom of the tool hold the five preferences: show
    automatically in campaign areas, hide when leaving the campaign, overlay
    position, compact overlay, and a character-level override.

XP percentages are estimates from the community formula, never a guarantee, and
the area level used is the instance's real monster level rather than a table
value. The chip appears for campaign areas only.

| Chip | Meaning |
| --- | --- |
| safe (green) | On level, or losing at most ~10 % experience |
| warning (amber) | Roughly 50–90 % experience — you are drifting off level |
| danger (red) | Under 50 % experience, or under-levelled by more than the safe zone + 3 |

The character level comes from the last level-up line in the log; if the app
started long after your last level-up, press **Rescan log (16 MB)** or type the
level into the override box. The in-game panel is pinned, so `Escape` and "Hide
all overlay panels" leave it alone; the × hides it until you enter another area,
and it never takes keyboard focus or captures the mouse from the game.

### Settings

- Automation defaults shared by every transfer, sort, and scan: process
  allowlist and actions-per-minute rates (stored locally). The **Dry-run**
  switch itself lives in the top bar and applies everywhere at once.
- Market data: league picker, daily auto-refresh, optional `POESESSID` (see
  [Market prices](#market-prices-live-feed--comps)).
- Runtime: mode, e-stop, detected PoE windows.
- Reminder: **Ctrl+D** price-check, **Ctrl+Shift+Esc** e-stop, **Ctrl+Alt+V** voice transfer.

The overlay port adds these blocks to the same screen:

- **Setup checklist** — ten steps, five of them required (Client.txt, pricing
  league, market prices, hotkeys, overlay); the optional ones (game detected,
  session cookie, administrator rights, calibration, chat commands) can never
  block completion, and a step that cannot be read says `unknown` rather than
  failing. The same payload is what Home draws. Dismiss it, or show it again,
  from the card.
- **Overlay** — panel scale and opacity, ultrawide handling, primary-monitor
  only, show only while Path of Exile runs, and *close on click outside*: panels
  that took keyboard focus (search fields) close when you click the game; the
  rest close with Escape or the Hide-all hotkey — the game always keeps its
  clicks. *Test overlay* shows one panel so you know where they appear.
- **Notifications & chat** — the chat-command switch (one line per gesture,
  stopped by `Ctrl+Shift+Esc` and by the Dry-run switch). Trade offers, quick
  whispers and Discord/Telegram webhooks live in Trade → Trade settings and in
  **Trade webhooks** below; the live-search chime lives in Market → Market
  settings.
- **Game client** — the Client.txt detection order (Steam → standalone → Epic →
  your override), the language/resolution/chat-key read-outs, *Re-read game
  config*, and *Check administrator rights*: it lists the game's processes and
  tries to open one handle, nothing else, and runs **only** when you press it.
  *Relaunch as administrator* raises Windows' own prompt and is hidden in the
  public build. Windows silently drops input and global hotkeys sent from a
  normal process to an elevated window, so if the game runs as administrator and
  the companion does not, hotkeys and chat lines fail with focus errors; this is
  the one sentence that explains why. The verdict is a heuristic
  ("likely" / "no" / "unknown") and nothing is ever blocked by it.
- **Window** — remember position and size, keep above the game, open when the
  game starts (a 20 s poll that never steals the game's focus), and *Reset
  window positions*, which also hides every overlay panel including pinned ones.
  On a restart the window appears centred and then jumps to the saved
  rectangle — that is expected.
- **Changelog** — what changed, with a badge counting releases you have not
  opened yet.
- **About & maintenance** — version and paths, *Open data folder* / *Open shared
  config folder*, and *Reset app & overlay settings* (two clicks; it touches only
  the `app` and `overlay` namespaces).
- **Feature settings mounted here** — Evaluate (profiles, auto-search, search
  defaults), Inspect overlay (panel position, display toggles, copy-on-hotkey,
  map warning overrides), Session & recap (AFK recap, post-game recap, death
  screenshots, the character override), and **Trade webhooks**, the only place
  the Discord webhook URL or Telegram token is entered. Market, Stash tracker,
  Campaign guide and Pricing keep their own options on their own screens.

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
The default FAST mode reads the complete bag by clipboard, resolves each
item's exact footprint using measured sizes and class defaults, and identifies
unidentified gear in one Shift-held chain, checking each result before the
next click. If the client cannot copy while Shift is held, verified individual
identification provides the fallback. It evaluates all identified gear
using your saved rules, price table and learned modifier tiers. It does not
fetch fresh trade comparisons. Unknown sizes or inconsistent reads stop the
run before any item moves.

Each ground drop is verified before another item is picked up. The remaining
bag is compacted from one plan, with at most one two-click move per item;
each move verifies destination space and the final item footprint. The scroll
stays pinned at the top-left. `--no-compact` skips compaction; `--careful`
keeps the per-item flow that only drops what it just identified (there,
`--include-identified` widens the evaluation scope). Numpad 5 pauses/resumes;
Numpad 0 and Ctrl+Shift+Esc stop input, including during batches. Keep the
inventory open before starting; a failed scroll copy stops without toggling it.

The September 14 rewrite is offline-tested and awaits a new supervised live
benchmark; the earlier ~30-second timing belongs to the previous implementation.
See `docs/HANDOFF-map-triage-2026-09-14.md` for its validation checklist.
Every identify and drop is verified by re-copying the cell and journaled to
`artifacts/map-triage/journal.jsonl`. Every action is logged to
`artifacts/action-daemon.log`. Stop the daemon with **Ctrl+C**.

### Auto-flask (life & mana)

The daemon also runs an **auto-flask guard**: it watches the life and mana
globes and presses the flask key the moment the fluid drops below a trigger
point you set by clicking — measured reaction is roughly 30–60 ms (one
screen readback per tick, ~33 Hz, plus a 25 ms key press).

1. Stand somewhere safe with full life and mana (town / hideout).
2. In the app open **Tools → Hotkeys → Auto-flask & auto-cast** and press
   **Calibrate by clicking** for *life*: the game comes to the front with a
   banner; click the
   life globe at the exact height where the flask should fire. Repeat for
   *mana*. (CLI alternative: `npm run flask:calibrate`.)
3. Check the keys (defaults **1** life, **2** mana — any digit or letter, or
   `m4` / `m5` for a flask on a mouse side button, `m3` for the middle
   button), the cooldowns (minimum gap between presses while the globe stays
   low; 2 s / 4 s by default), tick **Enable auto-flask and auto-cast**, and
   **Save**.
4. Optional: **Test now** samples both globes and every calibrated skill and
   shows filled / low (ready / cooling for a skill) for each.
   `npm run flask:status` prints the same from the CLI, after listing every
   globe and skill row with its key and calibration state.

The guard is live whenever `npm run actions:daemon` runs (or standalone:
`npm run flask:guard`; `npm run flask:guard:dry` and
`npm run actions:daemon -- --flask-dry-run` log WOULD-fire / WOULD-cast
events without pressing anything). **Numpad −** pauses / resumes it in game.
Config lives in `artifacts/flask-guard.json`; saves apply within a second.

How it decides: the averaged colour at the trigger point is compared with
what your calibration click measured. Fluid is saturated and bright at any
hue (red life, teal energy shield over life, blue mana); empty glass is dark
and grey. So "filled" = chroma and brightness above a fraction of the
calibrated colour (expert ratios in the panel). A patch that is near-black
(a loading fade) or bright with no colour (loading art, dialogs) is not the
globe at all and is never pressed on. It never presses before the HUD has
been seen filled once, only while Path of Exile 2 is the foreground window,
and after ~12 s without any filled read (death screen, passive tree) it slows
to one press per 10 s. Presses go through SendInput with real scan codes,
the same as a physical key. Every press also saves a 960×540 screenshot of
what the guard saw to `artifacts/flask-guard/` (at most one per 1.5 s) and
names it in the `flask` log line — check those first if it ever seems not to
react. Known limits: a full energy shield covering a low life globe reads as
"filled" (set the life trigger higher on ES builds), and a low globe while
the chat box is open would type the key into chat.

### Auto-cast (skills on cooldown)

The same guard can **auto-cast** skills: it watches a skill-bar icon and
presses that skill's key whenever the icon is lit, i.e. the moment the
skill comes off cooldown. It ships with one row, **Powered by Verisium** on
**T**; add more (Unleash, for instance) with **Add skill**.

1. In **Tools → Hotkeys → Auto-flask & auto-cast**, check the row's key
   (the key the skill is bound to in game; digit, letter, or `m3`–`m5`).
2. Press **Calibrate by clicking** on the row, switch to the game and click
   the **top edge** of the skill's icon on the skill bar **while it is
   ready** (not on cooldown, with enough mana). The icon's lit colour there
   becomes the reference. Top edge matters: the cooldown overlay is a
   clockwise pie sweep that starts and ends at 12 o'clock, so the top is the
   last spot to relight — a point at the icon's centre reads "ready" more
   than a second before the skill actually is (measured on a 5 s cooldown).
   The row is saved first, so a new skill needs a name and key before
   calibrating. (CLI: `npm run flask:calibrate -- skill:verisium`;
   `npm run flask:status` lists every skill id.)
3. Tick **Enable auto-flask and auto-cast** if it is off, and **Save**.

How it decides: the icon reads "ready" while every colour channel of the
averaged patch is within the **skill colour tolerance** (expert option,
40 by default) of the calibrated colour. The cooldown sweep darkens the
icon, and a skill the game will not let you cast yet (its effect still
running, not enough mana) is drawn uniformly dimmed to about half
brightness, so both read "cooling" and nothing is pressed — the guard
casts the moment the icon is fully lit, which is the moment the game
accepts the cast. Firing is edge-triggered: a press disarms the row, and
the icon going dark (the cooldown sweep, or the dimmed unusable state)
re-arms it, so after a real cast the next press comes the moment the icon
relights. A press the game did not take — the chat box had focus, the
skill was out of range — leaves the icon lit; the row then retries after
the **retry gap** (3 s by default) rather than every tick, so an open chat
box receives at most one stray letter per retry gap. Close chat with Esc
rather than leaving it open while the guard runs. Skill presses are logged
one line per guard cycle ("cast 3x this cycle") and never save a
screenshot. **Numpad −** pauses auto-cast together with auto-flask, and
every numpad action (stash, sort, shop, vendor cycle…) holds auto-cast for
its duration — those flows type into price dialogs and chat — while the
flasks keep running. Known
limits: an icon that glows or animates while ready may drift outside the
tolerance (raise it), a skill with no cooldown (its icon never goes dark)
is pressed once per retry gap while it is castable, and a lit icon while
the chat box is open still gets that one stray letter per retry gap. Live-verified 2026-09-14 on a 4K client: with the
top-edge point the guard cast exactly once per 5 s cooldown, three casts in
16 s, and the icon read "cooling" about 100 ms after each press.

## Where data lives

Local-first, in two places. Per-user data under `%APPDATA%\poe2-trade-companion\`:

| File | Contents |
| --- | --- |
| `item-intelligence.sqlite` | Catalog, builds, rules, scan sessions, value tiers, price table |
| `price-feed.secret.json` | The optional `POESESSID`, alone — never under the repo folder |
| `scan-sessions.jsonl` | Scanner journal |
| `assistive-artifacts/` | QA traces and capture artifacts, including `qa-action-trace.jsonl` — every chat line, stash search and window probe that was sent, previewed or blocked |
| `companion-settings.json` | Overlay, app, chat-command and per-feature settings, one sanitized namespace each (`app`, `overlay`, `client-log`, `chat-commands`, `live-search`, `evaluate`, `inspect`, `market`, `trade`, `commands`, `bookmarks`, `notes`, `stash-tracker`, `session`, `campaign-guide`, `pricing-history`) — never a token or cookie (those live in `*.secret.json` files) |
| `overlay-hotkeys.json` | Overlay & command hotkey bindings |
| `session-current.json` | The session in progress, rewritten at most once a minute and removed when it ends |
| `session-history.jsonl` | The newest 200 finished sessions, one line each |
| `deaths\` | Death screenshots (JPEG + thumbnail) and their index. They stay on this PC, are never uploaded, and can show chat and player names |
| `stash-tracker\snapshots.jsonl` | Stash tracker snapshots, one per line (auto ones pruned to the cap; auto snapshots older than 7 days keep totals only) |
| `stash-tracker\summary.json` | Session gains mirror for the Home page (copied to `stash-tracker-summary.json` next to it) |
| `market-favorites.json` | Saved searches and their folders — queries only, never listings |
| `market-tabs.json` | The open Market tabs: drafts, labels, colours. Never results |
| `market-live-searches.json` | Live-search ids and labels, so they can be restarted |
| `trade-offers.json` | Active offer cards: the other players' character names and whisper text. ≤ 100 cards, expire by timeout |
| `trade-history.json` | 14-day trade history: names, items, prices. Also read by Home for the session recap |
| `trade-webhooks.secret.json` | Discord webhook URL / Telegram bot token + chat id. Never synced, never under the repo, never in `companion-settings.json` |
| `notes-images\` | Note image bytes, beside `companion-settings.json` |
| `pricing-history\<league>.json` | Daily poe2scout price bars kept per league so the timeline grows past 7 days. Item names, prices, quantities only. Delete any time (Tools → Pricing → Expert options → Clear local history) |

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
- Accept or complete a trade, invite or whisper without a click, or clear the
  stash search box for you.
- Report experience or gold per map, or time to next level: those need an
  account link this app does not have, so they read `Needs account link (not
  available)` instead of being estimated.
- Automate a quest or travel to a waypoint — the campaign guide only tells.

**What Dry-run does and does not stop.** The top-bar switch stops every
generated keystroke and click: chat lines, stash searches and the Evaluate
capture become previews, and the window probe behind the stash price overlay
still sends no input. It does not stop reading `Client.txt`, does not stop paced
price lookups, and does not stop Discord/Telegram webhooks — those are outbound
messages you configured yourself, not game input.

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
| An overlay hotkey does nothing | Tools → Hotkeys: the row says **Not active** when another application holds that combination, or names the registration error. Reserved keys (`Ctrl+C/V/D`, `Ctrl+Shift+Esc`, the voice hotkey, the numpad) cannot be bound. |
| No overlay panel ever appears | The overlay only shows while Path of Exile runs. Press *Test overlay* in Tools → Settings → Overlay; if the game runs as administrator and the companion does not, Windows drops the hotkeys — see *Check administrator rights*. |
| A panel closed while I was typing in it | Panels that take keyboard focus close when the game gets a click. Pin the panel, or send/Escape first. |

## Related docs

- `README.md` — project overview
- `docs/GGG_COMPLIANCE.md` — public vs QA boundary
- `docs/QA_AUTOMATION_BOUNDARY.md` — interlocks
- `docs/PRODUCT_SPEC.md` — acceptance criteria
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — parser/source reuse
- `docs/HANDOFF-overlay-port.md` — the ported feature packages and their open live checks
- `docs/features/` — one reference doc per ported feature
