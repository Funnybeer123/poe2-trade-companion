# Inspect (overlay)

Written as the USER_GUIDE section for this feature: paste it under the
overlay chapter as `## Inspect (overlay)` and keep the headings below.

Inspect reads one copied item and tells you what it is worth knowing:
prefix/suffix, tier and roll for every modifier, how good a tier this item
level could ever hold, weapon DPS and defences at 20 % quality, wiki and
poe2db links, and — for waystones and tablets — a danger rating of the map
modifiers.

**It reads the clipboard. It never plays the game.** No key is sent, no
click is made, and it makes no network request: the tier ranges come from
files the price feed already wrote (`artifacts/tab-admin/mod-tiers.json`,
`trade-stats.json`), read-only.

### How to use it

1. Hover the item in game.
2. Press `Ctrl+C` (the game's own copy).
3. Press `Alt+I` (Tools → Hotkeys renames or rebinds it; the action is
   **Inspect item**, group **Overlay**).

The panel opens at the cursor. `Escape` closes it; the pin button keeps it
open. Pressing `Alt+I` again on the same item closes the panel, so the
hotkey doubles as a toggle.

The same card lives in **Item log**, under the parsed item, with an
**Open in overlay** button.

**Tip — hold `Alt` before `Ctrl+C`.** The game then copies its *advanced*
description: affix names, prefix/suffix, the game's own tier numbers and
the roll ranges. Inspect uses all of it. Without it the panel falls back to
what it learned from past price checks and says so.

### Reading the modifier rows

| Badge | Meaning |
|---|---|
| `P` / `S` | Prefix / suffix (advanced copy only) |
| `I` | Implicit — does not use an affix slot |
| `R` / `E` | Socketed rune effect / enchantment — not affixes either |
| `C` / `F` / `D` | Crafted / fractured / desecrated |
| `U` | A unique item's own modifier |
| `?` | Side unknown — the plain copy does not say |
| `T3` | The tier. Hover it: "T3 of 3 · needs item level 68 · learned from 5 listing(s)" |
| `low` | No tier could be established; the rough hand thresholds rated the roll |

The bar under a modifier is how far into its range the roll landed
(100 % = the best end). For a penalty modifier ("reduced Movement Speed")
the bar is flipped, so full is still good.

"top tier for item level 73" means no better tier can appear on this base
at this item level. "T2 possible here (needs item level 76)" means a better
tier exists and this item could hold it. Either line can end with
"— T2 from item level 76": the cheapest step up a **higher**-level base of
the same type could hold, which is what makes a base one level short of a
tier worth knowing about. When Inspect cannot rank the roll at all, the row
reads "best tier at item level 73: T1" rather than implying you could do
better.

The open-affix count on a plain copy is an estimate, and it discounts the
implicit block (a plain copy does not mark implicits, so counting them would
make the same item read differently depending on how it was copied). Hold
`Alt` before `Ctrl+C` for the real numbers.

### Chips

| Chip | Meaning |
|---|---|
| `advanced text` / `plain text` | Whether the copy carried the extra annotations |
| `Corrupted`, `Mirrored`, `Sanctified` | The item is sealed: no affix can be added |
| `Unidentified` | Modifiers and tiers stay hidden until it is identified |
| `Deadly` / `Dangerous` / `Caution` / `Info` | The worst map modifier rating on a waystone or tablet |

### Map warnings

Waystones and tablets get their own block: every rated modifier with a
severity, what it does to you, the reward lines (quantity, rarity, pack
size) and a list of modifiers the table does **not** rate.

**The table is community-maintained and unverified.** It is one reading of
what is dangerous, not a fact about the game — a resistance-based build and
an evasion build fear different lines. Re-rate or silence any entry in
**Tools → Settings → Inspect overlay → Map warning overrides**; your
ratings apply immediately and survive restarts.

If the character is in a hideout or town with a waystone copied, the panel
adds where you are and that the warnings apply to the map you are about to
open. Inside a map it names the current area instead. Inspect cannot see
the Atlas — this is only from the client log.

### Settings (Tools → Settings → Inspect overlay)

| Setting | Default | What it does |
|---|---|---|
| Panel position | At the cursor | Where the overlay panel opens |
| Show DPS and defences at 20 % quality | On | The normalised estimate rows |
| Follow the clipboard while the panel is pinned | On | While pinned, re-reads the clipboard once a second and updates itself when you copy another item. Reads only; never writes the clipboard |
| Copy the hovered item on the hotkey | **Off** | Sends exactly one `Ctrl+C` through the audited chat-command path (kill switch, foreground check, dry-run, rate limit) so you can skip step 2. Leave it off to keep Inspect input-free |
| Map warning overrides | none | Your own severity per map modifier, or "ignore" |

### Troubleshooting

| Symptom | What to try |
|---|---|
| "Nothing to inspect — hover an item, press Ctrl+C…" | The clipboard holds no item text. Hover the item and copy it first (or turn on copy-on-hotkey) |
| Every tier says "hand thresholds" | No learned ranges yet for those modifiers. Run a price check (Ctrl+D / Evaluate) on a few similar items; Inspect uses whatever the feed learned |
| A tier badge says "the learned ladder does not cover this modifier yet" | The game printed a tier number Inspect cannot place on a ladder. The number is still the game's own |
| The knowledge line says "tier direction unknown" | The learned store has not seen two tiers with required levels yet, so Inspect will not claim which numbering means "best" |
| "Inspect could not read this item — the details are in the log" | The text was item text, but the analysis failed. Tools → Logs has the reason; the item itself is fine to copy again |
| "That clipboard text is far too large to be a copied item" | Something other than an item (a whole log, a page of text) is on the clipboard. Copy the item again |
| A link button does nothing | The panel now says why: either the URL was outside the two allowed wiki hosts, or Windows has no default browser for it |
| Sides show `?` | A plain copy. Hold `Alt` before `Ctrl+C` |
| A map modifier is listed under "Not rated" | The table does not know that wording. Nothing is hidden — read the line yourself, and the wording can be added to the table later |
| The panel does not open | Check Tools → Hotkeys: another application may have taken `Alt+I` (the row shows the registration error) |

### Estimates, never guarantees

Tiers, ranges, roll percentages, DPS, defences and map ratings are all
estimates — derived from the item text plus ranges learned from past
listings. They are decision support, not a promise about a price or a safe
map.
