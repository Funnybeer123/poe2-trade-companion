# Ange ring gambling

Open **Tools → Bag cleanup & rings → Ange · Gamble rings**. Stand within view of Ange
with panels closed, then select **Gamble rings · buy & sort** and return to the
game during the three-second countdown. This explicitly enables spending gold
and selling weak rings for one batch. Existing automation mutual exclusion,
Stop, Num0, Num5 and Ctrl+Shift+Esc apply.

The worker Alt-left-clicks the unique visible Ange nameplate (the game handles
walking to her), confirms Gamble, clicks Jewelry/Jewellery, and targets the fixed
ring slot (first column, second row) in the calibrated vendor grid. It confirms
the Random Ring hover label before buying; vendor stock is not clipboard-scanned.
It buys one native Ctrl-click burst bounded by verified free capacity and the
purchase cap (at most 60), then reconciles every added ring before evaluating it.
It then evaluates this batch and Ctrl-clicks weak rings back to the vendor.
It never replenishes slots freed by selling and never touches pre-existing items.

Prerequisites: inventory and Vendor grid calibration at the current resolution,
plus the bag tool's existing empty-cursor/inventory-title references. Missing
setup appears beside the button. A hidden/off-screen Ange is not a navigation
target: move closer before starting. No guessed coordinates are used.

## Retention criteria

The gambling-specific policy uses actual tiers from Ctrl+Alt+C advanced copies.
Generic appraisal scores, implicit strength and broad keep/price rules do not
promote low-quality gambled rings. See [research and exact rules](RING_QUALITY_POLICY.md).

- Keep useful core explicit T1/T2 rolls on sparse crafting bases; rares with
  three or more affixes also need a second useful T1–T3 core affix or supported
  synergy. A single premium mana roll amid junk, such as Brood Circle, is sold.
- Utility rolls (light radius, life regeneration, leech, accuracy and weak mana-regen hybrids) never qualify alone.
- Without a qualifying top roll, require a supported substantial three-affix
  caster, mana, attack or defensive combination; all T4 or better, at least two T3.
- Count prefix/suffix groups, not displayed lines, when establishing crafting room.
- Retain special items, unidentified items and incomplete/ambiguous advanced
  annotations for separate review. Ordinary complete lower-tier rings that fail
  the filter are sold even when the old generic modifier regex missed them.

Every verdict states the observed tier or the supported combination. These are
screening decisions, not current market prices or guaranteed profitable crafts.

## Verification and manual test

Each inventory snapshot requires an open inventory title, an empty cursor,
and stable pixels. Occupied or uncertain changed cells require two agreeing
clipboard reads. Clearly empty cells can instead match every interior pixel in
both cursor-proof frames against a verified empty-inventory reference, with a
final stability check. This checks the slot ornament, rejects even small bright
sprites and falls back to clipboard reads on any uncertainty. Purchases may change only previously
empty cells into rings, up to the requested count. A partial purchase burst is
logged and never repeated. The complete reject list is sold in one burst of at
most 60 clicks. The completed modifier scan is reused, with a cached inventory
check and a visual guard immediately before clicking. There is no second modifier
sweep or check between individual sales. One final inventory reconciliation must
show exactly the selected sale cells empty and all retained items unchanged.
Delayed clipboard observations get at most three fresh paired reads. Purchases
and sales are never retried. Empty-cursor checks combine the native cursor hash
with two screenshots to reject a ring rendered on the cursor by the game.
Fading new-item highlights allow at most two extra observation sweeps; these never
repeat a purchase or sale. Uncertain mutations stop without retry. There is no
automatic resume after errors.

Start manual testing with only one or two free slots and enough gold for them.
Keep an existing ring in the inventory to verify it survives. Confirm that the
correct Gamble panel and Jewelry tab open, purchased rings occupy the free
slots, useful rolls remain, and only new weak rings are sold. Check Num0 stop
and focus loss separately. The next test can use a larger bag.

Logs are saved under `artifacts/map-triage/rings-*.jsonl`, with screenshots in
the adjacent `.evidence` folder and counts in `.result.json`. Worker failures
also appear in `.worker.log`. The first live test must validate OCR labels,
vendor-grid alignment, and calibrated empty-cursor art.

Terminal preview, which emits no OS input:

```powershell
node dist-electron/ring-gamble.cjs
```

For a capped live diagnostic run, pass `--run --max-purchases=1` together with
absolute `--calibration=...` and `--perception=...` paths. The desktop button
uses available capacity with a hard cap of 60.

## Live validation — 2026-09-17

Validated against the 3840×2160 client with the static Jewellery ring slot:

- Closed panels → Alt-left-click Ange → Gamble → Jewellery opened successfully.
- One-ring test: 1 purchased, 0 sold, 1 retained.
- Six-ring test: 6 purchased, 1 sold, 5 retained; the existing ring survived.
- Full-bag test (`artifacts/ring-gamble/live-test-14.jsonl`): 18 existing items,
  exactly 42 purchases to fill all 60 slots, then 9 verified sales and 33 retained.
  Retention comprised 8 craft candidates, 8 keeps and 17 uncertain rings for review.
  All 18 existing items survived; no purchases followed the sell pass.

Live testing corrected modifier timing (Control must span mouse-down/up), legacy
vendor grid row geometry, duplicate Ange text on the minimap, inventory grid
alignment, Unicode OCR transport and intermittent clipboard reads. A prior
interrupted test left its rings intact; the full-bag test treated them as existing
items. The saved local inventory calibration was aligned and backed up.

Lint/typecheck, the full 1,752-test suite, then 57 focused tests after the final
read-retry change passed. Packaged bag smoke tests passed in both build modes;
the final public package was rebuilt and smoke-tested after the retry fix.

### Rescan existing rings without buying

The desktop shortcut **Ctrl+Alt+V** and **Tools → Bag cleanup & rings → Clean up rings ·
sell rejects** start a fresh cleanup at Ange after a three-second countdown.
They scan existing rings, apply the same useful T1/T2 and synergy policy, and
sell rejects in one batch without buying anything. Non-ring items remain.
The app must be running; a shortcut conflict is shown beside the button.
Repeated presses during an active bag operation are ignored. Num0 stops and
Num5 pauses/resumes. The existing configurable **Vendor** daemon action now
appears as **Clean up rings** and launches the same `--rescan --run` worker;
it remains unbound by default so existing numpad assignments are preserved.

Cleanup integration passed the desktop service and component tests (including
`--rescan` routing and duplicate-hotkey protection), all 1,783 regression tests,
lint/typecheck, and the rebuilt packaged bag-worker smoke test.

An explicit cleanup request can use `--rescan --run` with the same calibration,
perception and journal arguments. It freshly reads all inventory cells, evaluates
only rings, and uses the same identity checks before each Ctrl-click sale. It
never buys or acts on other item classes. `--rescan` without `--run` previews only.

### Faster live workflow — 2026-09-17

The native host counts elapsed scheduler time instead of multiplying Windows
sleep overshoot. Advanced item copies use one guarded native request with a
25 ms hover and 50 ms clipboard-sequence timeout. Reads still require an
agreeing pair and retry only observation. Repeated vendor OCR uses a header crop.
Purchases hold Control across one capacity-bounded burst, with a 20 ms button-down
and 10 ms release gap; there is no hover delay between clicks on the same stock
slot. Actual throughput depends on Windows scheduling and game load. Sale bursts
contain at most eight freshly verified rejects, with 10 ms cursor settle.

Live measurements at 3840×2160, approximately 46–60 FPS:

- `speed-test-09.jsonl`: all 24 purchases accepted in 2.294 seconds; 16 sold,
  eight retained, four pre-existing rings preserved. Entire run: 63.293 seconds.
- Final `speed-test-10.jsonl`: all eight purchases accepted in 0.831 seconds;
  six sold, two retained, all 12 pre-existing rings preserved. Entire run:
  39.086 seconds, including a 17.071-second initial scan.
- Final highlight-settling retries recopied only changed cells and completed
  in approximately 1.75 seconds; stable cells were reused only after matching
  both ends of the preceding sweep.
- The four purchase tests acquired 50 rings total; 36 rejects were sold and
  the final inventory contained 14 retained rings. No missed purchase clicks
  were observed. These are measured reliable settings, not a claim of the
  game's absolute maximum input rate.

Validation: lint/typecheck and 1,776 tests passed, including native interlock,
replay, integration and component tests. After the final cache optimization,
51 focused tests and the final live eight-ring run passed. The desktop package
was rebuilt and its bag-worker smoke test was rerun.

### Visual empty-slot checks

The optional reference lives beside the perception file, with `.ring-empty.bmp`
appended. A run learns it automatically only after all 60 cells have been fully
verified empty through paired copies. Missing, unreadable or mismatching references
fall back to the existing clipboard checks. This machine was initialized from
the previously verified empty `speed-test-06` frame 2. OCR still confirms panel
labels; full-resolution image matching determines empty slots.

Live full-capacity validation (`visual-full-02.jsonl`): empty 60-slot inventory
verified in 898 ms with 60 visual matches and zero clipboard reads. All 60
purchases were accepted in a 4.531-second burst; 42 rejects were sold and 18
crafting candidates retained, with no unread items. Entire open/buy/read/sell
cycle: 84.083 seconds. Lint, typecheck, all 1,780 tests and the rebuilt desktop
bag-worker smoke test passed. The replay also rejects all 60 occupied cells
from this run as nonempty.

### One sale burst — 2026-09-17

The eight-item groups and second modifier sweep were removed. After the one
post-purchase modifier scan, the worker classifies all items, visually guards
the recorded inventory, sells the complete reject list and verifies the final
result. Emergency stop and per-click native focus/input guards remain active.

`single-batch-01.jsonl`: 60 bought, 46 sold in one 5.161-second sale burst,
14 retained. Total cycle 35.225 seconds, versus 84.083 seconds for the previous
full-bag run. Initial empty scan 864 ms; purchase burst 3.350 seconds. No unread
items or missed purchases. Lint, typecheck, the 1,780-test suite and the rebuilt
public desktop bag smoke test passed; focused coverage also checks the single
sale call, fixed snapshot count, changed-inventory rejection and partial failures.

## Master integration — 2026-09-17

Integrated with the existing master features. The desktop bag worker is bundled from scripts/bag-triage.ts; the existing map-triage CLI remains available. Ring cleanup uses its dedicated cancellable native host. Validation: lint and typecheck passed; 3,262 tests passed with 7 optional fixture tests skipped; the packaged public bag/ring worker smoke test passed.

