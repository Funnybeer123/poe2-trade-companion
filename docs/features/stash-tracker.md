# Stash tracker

**Where:** Tools → Stash tracker (`/tools/stash-tracker`).
**Hotkey:** `Alt+P` toggles the in-stash price overlay.

The Wealth page prices your stash *now*. The Stash tracker adds *time*: it
freezes the sorter's Ctrl+C ledger into named snapshots, compares any two of
them (including what left the stash), tracks what a play session gained, sums
each tab, lets you exclude items you never intend to sell, and draws worth over
time. It can also label the tab you have open in-game with those same numbers.

**It never sends input to the game and never touches the network.** The only
game-facing call is a single passive read of the Path of Exile window
rectangle, and only when you press the hotkey or a button. Every number is an
estimate from your own price table and the sorter's appraisals — never a
guaranteed sale price.

## Snapshots

- **Take snapshot** saves the ledger's current worth. The name is optional; a
  named snapshot is a *manual* one and is never pruned automatically.
- **Auto-snapshots** happen on their own. The tracker checks the ledger file
  every 10 seconds; when it has changed and then stayed quiet for a minute (a
  sort run appends for several minutes), one auto snapshot is written. The same
  ledger state never produces two.
- **Start session** stamps a new session: gains are measured from that point.
  The app also anchors a session when it launches with a non-empty ledger.

## History and Compare

History lists snapshots newest first with their kind, item count, effective
worth and the change against the previous one. Rename is inline; delete takes
two clicks.

Compare puts two snapshots side by side. **Current (unsaved)** is the live
ledger, so you can measure a mapping run without saving first. Rows are:

| Kind | Meaning |
|---|---|
| added | in the newer snapshot only |
| removed | in the older snapshot only — the thing vendor tools usually forget |
| changed | same place, different stack size or different value |
| moved | the same item, a different tab |

Filters narrow by kind, by minimum |Δ| in exalted, and by text. Rows sort by
the size of the value change.

## Session gains

The metric strip shows the change since this session's anchor. It is also
mirrored to disk for the Home page (see "Where data lives").

## Per tab and exclusions

The per-tab table totals every location the ledger knows, with its items,
excluded items, unpriced items, value and how old that tab's last scan is.
Click a location to list its items.

**Exclude** removes an item from every total the tracker shows — the metric
strip, the per-tab table, compare, session gains, the timeline and the price
overlay. Excluded items keep their row (struck through) so you can put them
back. Use it for your own gear, league-start staples, or anything the price
table over-values.

View filters (minimum value per unit, minimum value for the row, search, show
excluded) are display-only and are never saved.

## Timeline

The last 24 hours are drawn snapshot by snapshot; older history collapses to
one point per day — that day's last snapshot, drawn hollow. Gold points are
named snapshots, blue ones are session starts. Only the axis labels are
abbreviated; hover any point for its exact value.

## The in-stash price overlay (`Alt+P`)

Press `Alt+P` with the stash open. The tracker:

1. reads the Path of Exile window rectangle — one passive query, no input;
2. works out where that tab's grid is;
3. draws one rounded box and one price per item, in a click-through window;
4. opens the small **Stash prices** legend in the F1 overlay.

The labels are the ledger's *last scan* of that tab, not live perception. The
grid caption always names the tab, the scan age and "est. prices", so a
screenshot can never read as a price sheet. Clicks over the grid go to the
game; only the legend itself is clickable, and it never takes keyboard focus.

Legend buttons: ◀ ▶ change the labelled tab, ▲ marks the tab as top-level, ↻
re-reads the window and redraws. The legend's × (or Escape) hides everything.

**Which tab is labelled is your choice.** The app cannot see which stash tab is
open without driving the game, so it labels the tab you pick and remembers it.
The tab selector next to **Show overlay** switches the labelled tab straight
away while the labels are up — no need to hide and show again.

**Top-level tabs.** A tab at the top level of the stash draws its grid one
strip row higher than a tab inside a folder. Tabs named `T1`…`T99` are detected
automatically; for anything else use ▲ or list the tab under Expert options. If
labels sit exactly one row off, that is this setting. Teaching the tab in
`grid-calibration.json` (the `calibrate-grid` tool) removes the ambiguity for
good.

**Prerequisites.** The overlay needs either a taught grid for that tab, a
taught `__default_*` grid, or a calibrated stash grid (Tools → Calibration).
Without any of them it refuses and says so rather than guessing. The bag needs
a calibrated bag grid.

**High-DPI.** Rectangles and label sizes are converted to the display's DIP
space, the same path the dry-run overlay uses. A mixed-DPI second monitor is
untested.

## Expert options

| Option | Default | What it does |
|---|---|---|
| Auto-snapshot when the ledger settles | on | The settle-based snapshot above |
| Keep at most (auto snapshots) | 100 (20–500) | Auto and session-start snapshots beyond the cap are dropped oldest-first; named ones never are |
| Overlay: fade labels by value | on | Opacity scales with √(value ÷ the tab's best) |
| Overlay: show unpriced items as "?" | on | Off hides items the price table does not know |
| Overlay: minimum value to label (ex) | 0 | Hides cheap clutter |
| Overlay: show the legend panel | on | Off draws labels with no legend |
| Top-level tabs | empty | Comma-separated tab names to shift up; `!Name` forces "folder tab" for a `T…` name |

## Where data lives

| File | What |
|---|---|
| `%APPDATA%/poe2-trade-companion/stash-tracker/snapshots.jsonl` | One snapshot per line. Auto snapshots beyond the cap are dropped; auto snapshots older than 7 days keep their totals and lose their item list |
| `%APPDATA%/poe2-trade-companion/stash-tracker/summary.json` | Session gains mirror, rewritten on every change |
| `%APPDATA%/poe2-trade-companion/stash-tracker-summary.json` | A byte-identical copy under the name the Home page looks for |
| `companion-settings.json` → `stash-tracker` | Exclusions, the auto-snapshot cap, overlay options |

Read-only, never written by this feature: `artifacts/tab-admin/inventory.jsonl`
(the sorter's ledger), `artifacts/tab-admin/grid-calibration.json`, and the
calibration profile under `perception-templates/`. Nothing under `artifacts/`
is ever rewritten or deleted here.

**Contract note (frozen).** `summary.json` and its mirror are what the Session
/ Home page reads: the field names of `TrackerSummaryFile` (`sessionStart`,
`latest`, `sessionGainExalted`, `sessionGainDivine`, `snapshotCount`,
`excludedCount`) and the `SnapshotKind` values (`manual`, `auto`,
`session-start`) must not change without updating that page.

## Audit

Every window-rectangle probe appends one line to
`%APPDATA%/poe2-trade-companion/assistive-artifacts/qa-action-trace.jsonl` as
`stash-tracker-rect-probe`, even though no input follows it. The probe is
refused while the emergency stop is latched, and skipped (the last known
rectangle is reused) while another input host — the numpad daemon, a CLI run —
is alive. A repeated or held `Alt+P` joins the probe already in flight instead
of starting a second host, and the 10 s poll never probes at all: it re-draws
from the rectangle the last gesture measured.

`docs/GGG_COMPLIANCE.md` carries this path in its inventory of everything that
reaches the game — this package is the second place in the app that spawns
`scripts/win-input-host.ps1`, so it belongs there even though it sends no
input. The exact line to add is in
`src/main/features/stashTracker/WIRING.md` §11.

## Troubleshooting

| Symptom | What to try |
|---|---|
| "Nothing in the ledger yet" | Run a sort; the tracker reads what the sorter records |
| Labels are one row too high or too low | Toggle ▲ in the legend, or list the tab under Expert options; better, teach the grid with `calibrate-grid` |
| "No calibration for this tab" | Tools → Calibration, or teach the tab's grid |
| "Path of Exile is not running" | The overlay only opens while the game is running |
| "Kill switch latched" | Re-arm from the top bar; the probe is refused while the emergency stop is on |
| "input host busy" | The numpad daemon or a CLI owns the input host; stop it, or press ↻ once it is idle |
| Labels show the wrong items | They are the last scan of that tab, not live — re-run the sort for that tab |
| Prices look wrong | They come from your price table and the sorter's appraisals. Fix the table (Item log → prices) or exclude the item |
| The timeline is flat | Only one snapshot exists so far, or your ledger has not changed |

## Not covered

- Special stash layouts (Breach, Expedition, Fragment, Delirium, Essence,
  Ritual, Socketables, Abyss, Gem tabs): the sorter does not perceive those as
  grids, so the ledger never sees them.
- Quantity tracking through public trade tabs: quantities come from the Ctrl+C
  `Stack Size` line instead, with no trade2 traffic.
- Stash profiles and "most traded currency" valuation: the ledger already *is*
  the set of scanned tabs, and values are exalted/divine like the rest of the
  app.
- Automatic detection of which tab is open — see above.
