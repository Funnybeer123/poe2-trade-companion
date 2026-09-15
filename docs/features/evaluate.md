# Evaluate — the price-check overlay

Hover an item in Path of Exile 2, press **Alt+E**, and Evaluate copies it with a
single audited `Ctrl+C`, parses it, builds an **editable** trade2 query out of
what the item actually is, runs **one** paced search plus **one** paced fetch,
and shows the listings, an estimated price band with its sample size, and — for
currency — the bulk-exchange price.

Every number it shows is an **estimate** built from other players' asking
prices. Evaluate never whispers, buys, lists or prices anything in game.

---

## What it does

| | |
|---|---|
| **Hotkey** | `Alt+E` (rebindable in Tools → Hotkeys, group "Overlay"). `Ctrl+D` opens the same panel for whatever is already on the clipboard. |
| **Capture** | One `Ctrl+C` through the shared chat-commands capture: process allowlist, Path of Exile must be the foreground window, kill switch checked, one line in `assistive-artifacts/qa-action-trace.jsonl`. The item text stays on your clipboard afterwards, exactly like a manual copy. |
| **Where it appears** | As an overlay panel at the cursor over the game, and as the "Evaluate — trade listings & price band" section inside Item log. |
| **Closing it** | `Escape`, the Close button, or a click outside the panel. |

---

## Hotkeys

| Action | Default | What it does |
|---|---|---|
| `evaluate` | `Alt+E` | Copies the hovered item and opens the panel. In dry-run nothing is sent to the game: the clipboard text is used instead (price lookups still run). |
| `evaluate.clipboard` | unbound | Opens the panel for the item already on the clipboard, **without** searching. `Ctrl+D` triggers this alongside the classic price check. |

Repeat presses inside half a second count as one gesture — whatever the
capture mode — and pressing the hotkey again on the same item re-shows the
panel instead of spending a second lookup, both while the first search is
still running and for a minute after it answered.

The panel appears as soon as the item is parsed: an auto-search runs behind it
and fills the table when trade2 answers, so a slow lookup never leaves a blank
screen.

---

## Profiles

A profile decides how much of the item goes into the search: how many modifiers
are ticked, and how close a listing has to roll.

| Profile | Ticks | Roll share |
|---|---|---|
| **Quick Price** | the four strongest modifiers (one per family), the strongest pseudo total, and DPS (or the dominant defence) | 85 % |
| **Exact Match** | every searchable line and every property | 100 % (a modifier is pinned at min = max = your roll; a derived property such as DPS stays a floor, because an exact decimal matches nothing) |
| **Crafting Base** | fractured lines only, plus the item's exact item level | 100 % |
| **Broad** | the two strongest modifiers, no item-level floor | 70 % |

The percentages and mod caps are editable in Tools → Settings → Evaluate
(behind "Profile percentages and mod caps").

---

## The query builder

Every line of the item is a row you can tick, untick and re-bound:

- **Modifiers** — with the affix side and tier when your copy carried the
  advanced description (`Ctrl+Alt+C`), otherwise a "T2·learned" badge from the
  ranges the app learned from earlier comps. Hovering a row shows its score,
  its trade2 stat ids and (for a pseudo total) which lines it summed.
- **Pseudo totals** — the trade site's own aggregates: total Elemental
  Resistance, total Resistance, total to Strength, total maximum Life, … They
  only appear when the fetched stat catalogue actually carries them; Evaluate
  never invents a stat id. When a total is ticked, the lines it speaks for are
  tagged "in pseudo" and left unticked (tick one to take it back).
- **Properties** — pDPS, eDPS, DPS, attacks per second, crit, armour, evasion,
  energy shield, ward, block. Values below 20 % quality are shown normalised to
  Q20 and labelled "Q20 est." — an estimate, since the parser cannot tell a
  local modifier from a global one.
- **Item level, quality, sockets and flags** — plus the tri-state flags
  (Corrupted / Mirrored / Sanctified / Fractured / Desecrated: any, yes, no) and
  "Modifiable only", which asks for an item nothing has sealed.
- **Search filters** — seller status, listing age and the currency a listing is
  priced in.

A line the stat catalogue does not carry is shown **disabled** with the reason,
rather than silently dropped. With no catalogue at all (first run, offline) the
search falls back to the base type and says so.

Press <kbd>Enter</kbd> anywhere in the builder to run the search.

---

## Results

Sortable columns follow the item kind: weapons add DPS, gems level and quality,
uniques the required level, currency the stack size, rares the item level. Each
row shows the price (and its exalted equivalent), the listing's age, the seller
with an online dot, and whether it is a Secure or a whisper listing.

Client-side controls — currency chips, "Online only", "≤ 3 days", "Secure only",
"Group by seller" — never send another request. Listings older than three days
fade; past fourteen days they fade further.

- **◉** opens the listing's own item, with the lines your item also has
  highlighted.
- **Note** copies `~price 5 exalted` to your clipboard (`~b/o` too) — you paste
  it into the stash tab yourself.
- **Whisper** copies the trade site's whisper. Nothing is ever sent.

Changing **Listed in** (the price currency) re-runs the search on its own — it
is the one filter that does, and a repeat inside a minute is served from the
cache. Every other control in the table (sorting, the currency chips, the
online / age / secure toggles, grouping by seller) is client-side and spends
nothing.

The **estimated band** below the table gives low · fair · high with a confidence
bucket, how many of the fetched listings were comparable, and which source
produced the number (trade listings, price table, or the local appraisal). It
carries the same sentence the Item log does: *this is an estimate, not a
guaranteed sale price.*

---

## Currency and history

For a stackable whose trade2 exchange id is known, Evaluate asks the bulk
exchange once: the best asks, the median price per unit and the stock on offer.
Exalted Orbs are quoted in divine (pricing exalted in exalted says nothing) —
the panel always prints the currency the per-unit numbers are in. When the
exchange median and the price feed disagree by more than a quarter, the panel
says so next to the median: it is a cross-check between two estimates, not a
failed request.
Stackables outside the known currency list show the feed price and the history
only.

The seven-bar **price history** comes from the Market trends cache on disk — it
never triggers a poe2scout fetch of its own. "Open in Market trends" takes you to
the tool that owns refreshing it.

---

## Budget and etiquette

- One press = **one search + one fetch** (ten listings). "Load 10 more" is one
  further fetch; the bulk exchange is one request.
- The panel shows the spare trade2 lookups live, and a countdown while a penalty
  window is in force. Inside that window every button is disabled and **nothing
  is sent** — no retries, ever.
- The same query body inside 60 seconds is served from the app's cache, so
  toggling a filter costs nothing.
- Auto-search is per item kind (Tools → Settings → Evaluate): on for rares,
  magic items, uniques, gems and currency; off for waystones, normal bases and
  the long tail, which wait for you to press Search.
- The trade2 budget is shared with Deals, Market and the shop CLI. A few rapid
  presses can exhaust the five-minute window — the panel will say so.

---

## Item log

The "Evaluate — trade listings & price band" section shows the same workbench
for whatever is in the log. It opens **without** searching: Item log has already
spent a comps lookup on that item, so the first Evaluate lookup is a deliberate
press of Search.

---

## Settings (Tools → Settings → Evaluate)

| Field | Default | Meaning |
|---|---|---|
| `defaultProfile` | `quick-price` | Which profile a new session opens with. |
| `profiles[id].slack` | 0.85 / 1 / 1 / 0.7 | Share of your roll a listing must reach (0.5–1). |
| `profiles[id].maxMods` | 4 / 99 / 0 / 2 | How many modifiers the profile ticks (99 = every searchable line). |
| `autoSearch.*` | waystone and normal off, rest on | Which item kinds search on their own. |
| `defaultStatus` | `online` | Seller status for new searches. |
| `defaultIndexed` | any age | Listing-age filter for new searches. |
| `defaultCurrency` | any | Restrict listings to one price currency. |
| `captureMode` | `auto` | `clipboard-only` never sends a `Ctrl+C`; the clipboard is used. |
| `pseudoMods` | true | Offer the pseudo totals. |
| `exchangeForCurrency` | true | Use the bulk exchange for stackables. |
| `groupBySeller` | false | Group the result table by seller by default (applied to every new session). |
| `pageSize` | 10 | Listings per fetch (1–10; one trade2 fetch takes ten ids). |

Everything is read through a sanitizer: a hand-edited settings file can never
widen a search past these bounds.

---

## What it never does

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
