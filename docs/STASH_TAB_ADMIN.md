# Stash tab administration

Renames and recolours stash tabs so there is one tab per equipment slot, and
keeps every automated tab selection away from tabs that must not be touched.

Available as the **Tools → Stash tabs** panel in the app, and as
`scripts/stash-tab-admin.ts` on the command line.

## What it does

| Step | App | CLI |
| --- | --- | --- |
| Survey the open folder row | *Survey folder* | `npm run tabs:admin:survey` |
| Build the gear-slot plan | *Build plan* | `npm run tabs:admin:plan` |
| Open each dialog, change nothing | *Dry run* | `npm run tabs:admin:dry-run` |
| Rename + recolour for real | *Apply* | `npm run tabs:admin:apply` |

The nine slots and their colours live in `GEAR_SLOT_TABS`
(`src/core/stashTabAdmin.ts`): Weapons (red), Helmets (yellow), Amulets
(magenta), Rings (purple), Gloves (lime), Belts (brown), Body Armours (green),
Boots (blue), Off-hands (amber). Colours are unique by construction and the
validator rejects a plan that repeats one.

## Tabs the automation must never rewrite

Two kinds of tab are **protected** — `isProtectedTabLabel()`:

- **Priced tabs.** A `~price 5 exalted` name *is* the public listing. Renaming
  one silently delists the stock inside it.
- **Remove-only tabs.** Items can leave but not enter; a deposit either fails
  silently or shuffles priced stock.

Protection is enforced at three independent layers, because any single one can
be defeated by a bad OCR read:

1. `buildGearTabPlan()` never selects a protected tab as a destination.
2. `validateStashTabPlan()` re-checks the plan before execution and returns
   blocking errors.
3. `StashTabKit.applyTabIdentity()` opens the dialog, reads the **Name field
   the game itself renders**, and aborts if that name is protected — so a
   mis-aimed right-click cannot rename the wrong tab.

### OCR garble is the reason for layer 3

The tab strip clips labels as it scrolls. A live survey read one physical
`~price 5 exalted` tab four different ways:

```
"~price 5 exalted"   "rice 5 exalted"   "price 5 exalted"   "exalted"
```

Only the first matches the strict `~price N` form. `looksPricedTabLabel()`
therefore treats *any* label pairing a currency word with a digit as priced.
Over-refusing costs one candidate tab; under-refusing destroys a listing.

The survey de-duplicates the same way: labels that match loosely, or that share
a grid size and occupancy count, are treated as one tab.

## The in-game UI contract

Learned from the live client at 3840×2160 fullscreen; all coordinates are
screen pixels.

- **Open a tab's settings:** right-click its header in the tab strip. (The gear
  icon at `(1286, 54)` opens the *stash* options menu instead — Hide Remove-only
  Tabs, Hide Unavailable Tabs, Enable Tab Affinities, Affinity Auto-navigation.)
- **Name field:** click `(700, 528)`, then `ctrl+a`, `backspace`, type.
- **Colour palette:** 9 columns × 3 rows, first swatch centre `(356, 648)`,
  pitch `76 × 82`. The dialog draws a 10th column — that is the current-colour
  preview and is **not** selectable.
- **Confirm tick:** not at a fixed position. The dialog grows when a tab is
  public (it gains price controls), so the tick is located by OCR, 73px below
  the "Multiple Stash tabs cannot share the same stash affinity" footer.
- **Close without saving:** `(1250, 371)`.

### Tab strip rows

The strip has two rows. Row 1 is the top level (tabs and folders); row 2
appears when a folder is open and shows that folder's contents. Both scroll
horizontally and neither is addressable by a stable index:

| | scroll left | scroll right |
| --- | --- | --- |
| top row | `(52, 212)` | `(1217, 210)` |
| folder row | `(52, 277)` | `(1217, 275)` |

`StashTabKit.locate()` rewinds a row and walks it rightwards to find a tab, so
callers never reuse a stale strip position.

### Affinities cannot route gear

The affinity checkboxes cover Currency, Fragment, Unique, Augment, Abyss,
Delirium, Waystone, Flask, Expedition, Relics, Essence, Breach, Gem and Ritual.
There is **no** affinity for weapon or armour slots, so gear cannot be
auto-routed by affinity — sorting gear into per-slot tabs requires moving the
items, using the highlight-search query from `highlightQueryForSlot()`.

## OCR settling

The game animates panel and dialog transitions. A single OCR taken mid-animation
returns a half-drawn frame with rows missing — an early probe read a stale
dialog that was not on screen. `StashTabKit.settledOcr()` therefore re-reads
until two consecutive results agree. On a static screen OCR is stable.

## Related

- Tab **navigation** for the sorter is in `src/adapters/tabNavigator.ts`, which
  now refuses protected tabs in both `goto(index)` and `gotoLabel(label)`, and
  verifies the row label before clicking, because the user reorders tabs live.
- Folder creation and family grouping stay in `src/core/tabFolders.ts`.
