# WIRING — `inspect` (item insight overlay + map warnings)

Every line the integrator adds for this package. Nothing here touches a
file the package owns; every path below exists in the tree.

Package files (for reference):

- `src/core/inspect.ts`, `src/core/inspectTiers.ts`, `src/core/inspectMapMods.ts`, `src/core/inspectLinks.ts`
- `src/data/inspect/dangerousMapMods.ts`
- `src/shared/inspect.ts`
- `src/main/features/inspect/index.ts`
- `src/renderer/features/inspect/{inspectApi.ts,InspectCard.vue,InspectPanel.vue,InspectSection.vue,InspectSettingsSection.vue}`
- `fixtures/inspect/**`, `docs/features/inspect.md`
- tests: `tests/inspect-{tiers,map-mods,links,report,settings,module}.test.ts`, `tests/component/inspect-{card,panel,section,settings-section}.test.ts`

---

## 1. Registry — `src/main/features/registry.ts`

Import:

```ts
import { inspectModule } from "./inspect/index.js";
```

Entry, under `// Features:` (REVIEW-conflicts §6 order: after `evaluateModule`):

```ts
  inspectModule,
```

It requires `overlay` and `hotkeys` (both foundations, registered earlier) and
looks up `clientLog` / `chatCommands` loosely, so it never depends on their order.

## 2. Overlay panel — `src/renderer/overlay/panels.ts`

Add to `OVERLAY_PANELS`, after `NOTICE_PANEL`:

```ts
  { id: "inspect", title: "Inspect", component: () => import("../features/inspect/InspectPanel.vue"), defaultAnchor: "cursor", defaultSize: { width: 440, height: 560 }, resizable: true },
```

## 3. Nav, router, Tools — nothing

Inspect adds no primary view, no route and no Tools entry. Its desktop
surface is the Item log section (§4) and the Settings section (§5).

## 4. Item log — `src/renderer/views/ItemsView.vue`

Import:

```ts
import InspectSection from "../features/inspect/InspectSection.vue";
```

In the template, after `<ItemDetail …/>` and P1's `<EvaluateItemLogSection …/>`,
before the existing `market-comps` / `deal-analysis` disclosures:

```vue
<details v-if="store.currentEvaluation.value" class="advanced-options" open>
  <summary>Inspect — tiers, rolls, DPS, map warnings</summary>
  <InspectSection :raw="store.currentEvaluation.value.raw" />
</details>
```

Use the `store.currentEvaluation.value` path exactly as written — `ItemsView.vue`
has no bare `evaluation` binding in its template, and `InspectSection` declares
`raw: string` as required, so the `v-if` also keeps it unmounted until an item
has been copied. `InspectSection` re-analyses that raw text, debounced, whenever
it changes.

## 5. Settings — `src/renderer/components/tools/FilterSettingsTool.vue` (`panel="settings"`)

Import:

```ts
import InspectSettingsSection from "../../features/inspect/InspectSettingsSection.vue";
```

Mount after `<EvaluateSettingsSection />`, before `.settings-facts`:

```vue
<InspectSettingsSection />
```

## 6. Hotkeys UI — nothing

`OverlayHotkeysSection.vue` lists contributed actions on its own. `inspect.show`
appears under group **Overlay** with the default accelerator `Alt+I`.

## 7. Input boundary — `tests/input-boundary.test.ts`

Include this package in the directory scan required by REVIEW-compliance §0.2:

- `src/main/features/inspect/**/*.ts`
- `src/core/inspect*.ts`

Neither imports the Windows input host, the input sink or the game input
controller, and neither sends a host op. The one optional game gesture (`settings.inspect.copyOnHotkey`,
default off) goes through `ctx.get("chatCommands").copyHoveredItem(...)`, which
owns every gate — so this package needs no exception in that test.

## 8. Docs

**README.md**, "Item intelligence" bullets:

```md
- **Inspect (overlay, `Alt+I`)** — mod tiers, rolls and prefix/suffix from the copied item, weapon DPS and defences at 20 % quality, wiki/poe2db links, and waystone danger ratings. Reads the clipboard only; never touches the game.
```

**docs/USER_GUIDE.md**: add a `## Inspect (overlay)` section from
`docs/features/inspect.md` (that file is written as the section: paste it
under the overlay chapter, keeping its `###` headings one level below).
Add to "Where data lives": the `inspect` namespace of
`%APPDATA%/poe2-trade-companion/companion-settings.json` (panel anchor,
two display toggles, copy-on-hotkey, map warning overrides). Inspect writes
nothing else and reads `artifacts/tab-admin/mod-tiers.json` and
`trade-stats.json` read-only.

**docs/ARCHITECTURE.md**, "Current layout":

```md
- `src/core/inspect*.ts` — Inspect's pure analysis: tier ladders from learned ranges, map-mod matching, wiki links, the assembled report.
- `src/data/inspect/` — the curated (unverified, community-maintained) waystone/tablet danger table.
- `src/main/features/inspect/` — the `inspect:*` channels, the `Alt+I` hotkey and the overlay panel plumbing.
- `src/renderer/features/inspect/` — the Inspect card, overlay panel, Item log section and settings section.
```

**docs/GGG_COMPLIANCE.md**:

```md
- Inspect sends no input and makes no request: it analyses the text the game's own Ctrl+C put on the clipboard. With `inspect.copyOnHotkey` enabled (off by default) it asks the chat-command service for exactly one Ctrl+C, through the same kill-switch, foreground, dry-run and rate-limit gates as every other line.
```

**docs/HANDOFF-overlay-port.md**, first live checks for Inspect:

```md
- Copy one item with advanced descriptions (hold Alt before Ctrl+C) and compare the game's `(Tier: N)` with the learned ladder — the tier NUMBERING DIRECTION is still unverified (`knowledge.tierDirection`).
- Confirm the advanced `value(min-max)` range form exists in PoE2; if not, add a real paste to `fixtures/inspect/` and adjust `stripAdvancedRanges`.
- Check a real T15 waystone against `src/data/inspect/dangerousMapMods.ts`: every entry is `verified: false` and unmatched lines are listed in the panel.
- Confirm tablet and waystone affix limits (currently 2/2 and 3/3, unverified).
```

## 9. e2e — optional

`e2e/authorized-qa.spec.ts`, Item log: after pasting `fixtures/items/rich-affixes.txt`
the page contains `Inspect — tiers`. Not required for the smoke; Inspect adds no
route, so `WORKSPACES` / `routes` / `TOOLS` are unchanged.

## 10. electron-builder — nothing

The danger table is a TypeScript module bundled into `dist-electron/`, not a
data file: no new `files:` entry in either yml.
