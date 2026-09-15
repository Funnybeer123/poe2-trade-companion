# WIRING — P1 `evaluate` (the price-check overlay)

Everything below is edited by the INTEGRATOR; this package never touches these
files. Every path named here exists in the tree.

Package summary: channels `evaluate:*` (11), event `evaluate:session`, settings
namespace `evaluate`, overlay panel `evaluate`, hotkey actions `evaluate`
(`Alt+E`) and `evaluate.clipboard` (unbound). No game input of its own — the
single audited `Ctrl+C` is `chatCommands.copyHoveredItem` (F3).

---

## 1. Module registry — `src/main/features/registry.ts`

Import (with the other feature imports, after the foundation imports):

```ts
import { evaluateModule } from "./evaluate/index.js";
```

Entry (first line under `// Features:`, the order REVIEW-conflicts §6 fixes):

```ts
  evaluateModule,
```

The module `ctx.require()`s `overlay`, `hotkeys` and `chatCommands`, so it must
stay after those three foundations (it already is: they are listed above
`// Features:`).

---

## 2. Overlay panel registry — `src/renderer/overlay/panels.ts`

Add to `OVERLAY_PANELS`, after `NOTICE_PANEL` (verbatim from REVIEW-conflicts §6):

```ts
  { id: "evaluate", title: "Evaluate", component: () => import("../features/evaluate/EvaluateOverlayPanel.vue"), defaultAnchor: "cursor", defaultSize: { width: 620, height: 560 }, resizable: true },
```

The component file is `src/renderer/features/evaluate/EvaluateOverlayPanel.vue`
(props `{ panelId, payload, visible }`, emits `close`). `payload` is
`{ sessionId }`; the panel reads the session over `evaluate:current` and the
`evaluate:session` event, so a re-`show()` can never deliver a stale copy.
Main shows it with `{ anchor: "cursor", focus: true, width: 620, height: 560 }` —
the same numbers as the registry line above.

---

## 3. Item log — `src/renderer/views/ItemsView.vue`

Import:

```ts
import EvaluateItemLogSection from "../features/evaluate/EvaluateItemLogSection.vue";
```

Template — immediately after the `<ItemDetail … />` element (line ~272, before the
existing `<details class="advanced-options market-comps">`), as a SIBLING of
ItemDetail (never inside it), and before P5's Inspect block:

```vue
      <EvaluateItemLogSection v-if="store.currentEvaluation.value" :evaluation="store.currentEvaluation.value" />
```

The section opens its session with `autoSearch: false` and `showOverlay: false`:
pressing "Evaluate this item" spends NO trade2 lookup. The first lookup is the
user's own press of Search inside it.

---

## 4. Settings — `src/renderer/components/tools/FilterSettingsTool.vue`

Import:

```ts
import EvaluateSettingsSection from "../../features/evaluate/EvaluateSettingsSection.vue";
```

Template — inside `panel="settings"`, after the Market data `</template>` and
before `<div class="settings-facts">` (line ~468), in the order REVIEW-conflicts §6
fixes (`<AppSettingsSections />` first, then this, then Inspect, then Session):

```vue
      <EvaluateSettingsSection />
```

It writes through `settings:set("evaluate", patch)` on every change (the
automation-defaults pattern, no Save button); main's `normalizeEvaluateSettings`
decides what survives. P10 does not render per-feature namespaces.

---

## 5. Ctrl+D — `src/main/index.ts` (line ~765)

```ts
  globalShortcut.register("CommandOrControl+D", () => {
    lastClipboard = "";
    void evaluateClipboard(true);
    void featureRuntime?.ctx.get("hotkeys")?.trigger("evaluate.clipboard");
  });
```

Budget note (compliance §0.3, "one keypress = at most 1 search + 1 fetch"): the
classic path (`evaluateClipboard(true)`) spends the one comps lookup; the
`evaluate.clipboard` action opens the panel with `autoSearch: false` and spends
NOTHING until the user presses Search. Keep it that way — the module hard-codes
`autoSearch: false` for that action, so no flag has to be passed here.

Held-key note: every `evaluate` / `evaluate.clipboard` press goes through a
500 ms debounce inside `EvaluateService.open()` (not inside the capture branch),
so an auto-repeating accelerator cannot queue one lookup per repeat in ANY
capture mode, and a repeat on the same item re-shows the session while its first
search is still in flight.

---

## 6. Hotkeys UI — nothing to add

`OverlayHotkeysSection.vue` lists contributed actions by group; both Evaluate
actions arrive in the existing "Overlay" group.

---

## 7. `tests/input-boundary.test.ts`

Nothing to add. The directory scan is already in the tree and
`src/main/features/evaluate/**` passes it unchanged: the package contains no
`startWinHost`, `winHostInputSink` or `gameInputController` import and no
`host.send({ op: … })` call (the design's `hoverCapture.ts` was struck by
REVIEW-conflicts §7 — the capture is `chatCommands.copyHoveredItem`). Do NOT add
`evaluate` to the `ALLOWED` exception list.

(Heads-up for the integrator, not this package: the boundary test currently
fails on `src/main/features/appSettings/index.ts`, whose header comment contains
the words `GameInputController` in prose. That is P10's file.)

---

## 8. e2e

No new primary route. The offline QA spec can assert the Item log section after
pasting `fixtures/items/rare-body.txt`:

```ts
await expect(page.getByRole("button", { name: "Evaluate this item" })).toBeVisible();
```

Nothing else: pressing it opens a session but sends no request, and the packaged
public build has no trade2 credentials.

---

## 9. electron-builder (`electron-builder.*.yml`)

Nothing to add. This package ships no data file (the pseudo-stat texts live in
`src/core/evaluateItem.ts`, and the stat catalogue comes from
`PriceFeedService.statCatalogue`). `fixtures/evaluate/**` is test-only.

---

## 10. Docs

**README** — under the item-intelligence bullets:

```markdown
- **Evaluate** — hover an item and press `Alt+E` (or `Ctrl+D`): one audited `Ctrl+C`, an editable trade2 query, the listings, the bulk-exchange price for stackables and an estimated band with its sample size — over the game or inside Item log.
```

**USER_GUIDE** — add `## Evaluate (price-check overlay)` from
`docs/features/evaluate.md` (sections: what it does · hotkeys · profiles · the
query builder · pseudo totals · results & filters · currency & history · budget
and etiquette · Item log · settings · what it never does).

**USER_GUIDE → "Where data lives"** — one row:

| `companion-settings.json` → `namespaces.evaluate` | Evaluate's profiles, auto-search switches and search defaults. No item text, no listings, no cookie. |

**ARCHITECTURE → "Current layout"**:

```
src/core/evaluate{Item,Query,Results}.ts   the pure price-check model
src/main/features/evaluate/*               the evaluate:* channels and service
src/renderer/features/evaluate/*           the workbench, overlay panel and Item log section
```

**GGG_COMPLIANCE** — one line in the game-input section:

```markdown
- Evaluate sends exactly one `Ctrl+C` per hotkey press, through the audited chat-commands capture (allowlist, foreground, kill switch, one trace line). Dry-run sends nothing and reads the clipboard instead; price lookups still run. Repeat presses inside 500 ms are one gesture, and re-pressing on the same item inside the 60 s search cache re-shows the panel instead of spending a second lookup.
```

---

## 11. HANDOFF — first live checks

1. Dry-run ON, `Ctrl+C` an item, press `Alt+E` → the panel opens at the cursor
   with the rows ticked and the chip "Dry-run · clipboard · lookups still run";
   Search fills the table and the band.
2. Dry-run OFF, hover an item, press `Alt+E` → the clipboard changes, one
   `copy-hovered` line appears in `assistive-artifacts/qa-action-trace.jsonl`,
   the panel shows "Copied with one Ctrl+C".
3. `Alt+E` with the desktop app focused → the notice panel says Path of Exile is
   not the foreground window; no input was sent.
4. A currency stack → the bulk-exchange table with a per-unit price and stock,
   labelled with the quote currency (an exalted stack is quoted in divine). A
   median that disagrees with the feed by over 25 % prints as a note under the
   median, not as a red error.
5. After the watchlist has spent the window → Search is disabled with a penalty
   countdown, and no request goes out.
5b. Press `Alt+E` on a rare with auto-search on → the panel must be on screen
   BEFORE the table fills (open() returns first; the lookup lands as an
   `evaluate:session` event), and a second press while it is still spinning must
   re-show the same panel without a second search.
6. Confirm the pseudo texts resolve against the REAL `/data/stats` payload
   (`+#% total Elemental Resistance`, `+# total maximum Life`, and whether the
   attribute/mana/ES ones exist at all) — unresolved pseudos silently produce no
   row, which is safe but invisible.
