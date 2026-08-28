# Handoff: One-press game actions (Sort / Fill / Vendor / Stash) on numpad mouse keys

## Goal

Bind the companion's core actions to the numpad keys emitted by the user's
mouse side-buttons, so they can walk up to the stash in their hideout and
press one button:

- **Stash** (primary): validate that the stash panel AND inventory are open
  (OCR the STASH / INVENTORY title banners — never grid heuristics). If not
  open and we're in the hideout, locate the world **"Stash" nameplate via
  OCR**, click it to open (character walks over automatically), wait for the
  panels, then **dump the bag** (deposit all bag items).
- **Sort**: run the class-routed sorter (`sort:tabs --run` flow) on the bag.
- **Fill**: run the fill flow (stash → bag).
- **Vendor**: semantics TBD (see open questions).
- **Future**: the Stash action becomes *sorting* stash — items whose type has
  a tab **affinity** get plain ctrl-clicked (the game auto-routes them);
  everything else (body armour, boots, etc.) is identified (hover + Ctrl+C)
  and routed to the correct tab per `tab-routes.json`, eventually into
  folders/subfolders.

## Where everything lives (all live-tested this week, branch `perception-reliability`)

- `src/adapters/drainKit.ts` — the primitives to reuse:
  `ensurePanelsOpen()` (OCR banners at bands (450,100,700x110) and
  (2900,100,800x110); reopens stash via the OCR'd "Stash" nameplate +
  presses `i` for the bag — this IS the Stash action's validation step),
  `depositBag()` (ctrl-clicks all 60 calibrated bag cells — deposit with no
  perception dependency), `gotoLabel()` (tab navigation by label; the tab
  list scrolls ONLY via its scrollbar at x≈2005, direction-ordered grabs).
- `scripts/assistive-sort-tabs.ts` — identification + routed deposits.
- `src/main/assistiveRunService.ts` — audited fill/empty services.
- `scripts/win-input-host.ps1` — host ops incl. `ocr`, `ctrlburst(+shift)`,
  `wheel`, `drag`; `AssistiveWin` already imports **GetAsyncKeyState**.

## Implementation sketch for the hotkey listener

Add a host op `keywatch` (or a dedicated daemon loop): poll
`GetAsyncKeyState` for VK_NUMPAD0-9 (0x60–0x69) at ~50ms, and only while the
foreground window is PoE (existing foreground check). Emit one JSON line per
keypress; a Node daemon (`scripts/action-daemon.ts`) maps keys → actions and
invokes the existing flows. Debounce (ignore repeats within ~1s) and refuse
to start a new action while one runs. Surface progress with the existing
event logging; the kill switch must stop any action instantly.

## Hard-won quirks the next session must respect (see also project memory)

- Panel truth = OCR title banners. A full bag defeats grid detection; world
  floor tiles can hallucinate an open bag.
- Tab strip reorders itself; the dropdown auto-scrolls; user reorders and
  folders tabs live → always address tabs by label at click time. Foldered
  tabs vanish from the flat list (folder support is unbuilt).
- `~price N <currency>` tab names are the public pricing — never rename;
  deposits inherit the tab's price.
- Escape with no panel open = pause menu. `i` toggles (can CLOSE) the bag —
  only press it after OCR confirms the bag is closed.
- Specialty tabs (gem/map/currency/essence/delirium) have phantom occupancy
  and nested sub-views; mapped views are in
  `fixtures/perception/templates/specialty-views.json`.

## Open questions for the user

1. Which numpad keys → which actions? (e.g. Num1=Stash, Num2=Sort, Num3=Fill,
   Num4=Vendor?)
2. Vendor: what exactly should it do — open the nearest vendor (which NPC?),
   ctrl-click all bag items into the sell window, and stop before accepting
   the trade (user confirms the sale manually)? Auto-accepting a sale is
   riskier and needs an explicit go-ahead.
3. For the future sorting-stash: which item classes have affinities set on
   your tabs (those can be blind ctrl-clicked), and should unrouted items
   stay in the bag or go to a designated dump tab?
4. Should the hotkeys work only while the stash/vendor is reachable in the
   hideout, or anywhere (with the action refusing gracefully elsewhere)?
