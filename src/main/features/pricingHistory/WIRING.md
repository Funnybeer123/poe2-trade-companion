# WIRING — P9 `pricing-history` (Tools → Pricing)

Everything below is an edit to a SHARED file, so the integrator makes it. The
package itself is complete and green without any of these lines; until they
land the module is simply not registered and the tool is not reachable.

Files this package owns (all present):

- `src/core/pricingHistory.ts`
- `src/shared/pricingHistory.ts`
- `src/main/features/pricingHistory/index.ts`
- `src/main/features/pricingHistory/historyStore.ts`
- `src/renderer/features/pricingHistory/pricingApi.ts`
- `src/renderer/features/pricingHistory/PricingHistoryTool.vue`
- `src/renderer/features/pricingHistory/PriceSparkline.vue`
- `src/renderer/features/pricingHistory/PriceTimeline.vue`
- `tests/pricing-history.test.ts`, `tests/pricing-history-store.test.ts`,
  `tests/pricing-history-module.test.ts`,
  `tests/component/pricing-history-tool.test.ts`
- `fixtures/pricing-history/price-trends.cache.json`,
  `fixtures/pricing-history/history.runes-of-aldur.json`,
  `fixtures/pricing-history/settings.junk.json`
- `docs/features/pricing-history.md`

---

## 1. Registry — `src/main/features/registry.ts`

Import (with the other feature imports):

```ts
import { pricingHistoryModule } from "./pricingHistory/index.js";
```

Entry, in the wave-2 order of REVIEW-conflicts §6 (after `campaignGuideModule`,
before `appSettingsModule`):

```ts
  pricingHistoryModule,
```

No wave-2 module depends on this one, and this one requires nothing but the
scaffold; it uses `ctx.get("hotkeys")` (never `require`), so it also registers
cleanly when the hotkeys module failed.

## 1b. Input boundary — `tests/input-boundary.test.ts`

REVIEW-compliance §0.2 (BLOCKING) — **nothing to add, but check it still
holds.** The shared guard walks `src/main/features` recursively, so
`src/main/features/pricingHistory/**` is already scanned for
`startWinHost` / `WinHostInputSink` / `GameInputController` imports and for
`host.send({ op: … })`, and `"pricingHistory"` is already in the test's
`src/core` prefix list (so `src/core/pricingHistory.ts` is covered too). This
package needs **no** entry in `FEATURE_INPUT_EXCEPTIONS` — it sends no input
at all. If that scan is ever narrowed to an explicit directory list, add
`src/main/features/pricingHistory`. The package repeats the same assertion
locally (last case in `tests/pricing-history-module.test.ts`).

## 2. Tools entry — `src/renderer/views/ToolsView.vue`

Import:

```ts
import PricingHistoryTool from "../features/pricingHistory/PricingHistoryTool.vue";
```

`tools` entry, in the §6 order (after `deals`, before `stash-tracker`):

```ts
  { id: "pricing", label: "Pricing", detail: "History & favorites" },
```

Mount, above the final `v-else`:

```vue
      <PricingHistoryTool v-else-if="selectedTool === 'pricing'" />
```

The tool renders `<h2 id="pricing-title">Pricing history</h2>` — the heading
the e2e smoke asserts.

## 3. Router / nav — nothing

The tool lives under the existing `/tools/:tool?` route. Deep link:
`#/tools/pricing?q=<name>` (the search field is pre-filled from `?q=`).

## 4. Overlay panels — nothing

No line in `src/renderer/overlay/panels.ts`; Pricing is a browse screen on the
desktop window. Other packages that want an item's history call the
`pricing:history` channel.

## 5. Hotkeys UI — nothing

`pricing.open` (unbound by default, group **Desktop**) appears automatically in
`OverlayHotkeysSection.vue`. Its `run` fronts the main window
(`isMinimized → restore; show; focus`) and then emits the scaffold event:

```ts
ctx.emit("app:navigate", { path: "/tools/pricing" });
```

so the single `App.vue` `app:navigate` subscription from REVIEW-conflicts §5
(F0) is all the routing this needs.

## 6. Settings — nothing

The namespace `pricing-history` registers itself with its own sanitizer. Per
the minimal-config rule, its knobs live on the Pricing panel (`Show prices in`,
`Hide low-stock`, and behind `<details class="advanced-options">`: keep
collecting bars, the file stats and a two-click **Clear local history**).

Optional cross-reference line in the Settings → Market data block:

```
Price history and favorites live under Tools → Pricing.
```

## 7. e2e

`e2e/public-companion.spec.ts`, `TOOLS`:

```ts
  ["Pricing", "Pricing history", "/tools/pricing"],
```

On a fresh user-data dir with no network the tool renders its "No price history
yet" state (one `pricing:overview` call, `cachedOnly`, zero requests) and emits
no `pageerror`.

## 8. electron-builder

Nothing. The package bundles no data file; its history lives under
`%APPDATA%/poe2-trade-companion/pricing-history/`.

## 9. Docs

`README.md`, Item intelligence bullets:

```md
- **Pricing (Tools)** — poe2scout price history per item: categories, favorites, sort by 1/3/7-day change, sparklines and a local timeline that grows past the seven days the feed serves. Estimates, never guarantees.
```

`docs/USER_GUIDE.md`, under "Tools & QA", add `### Pricing history` from
`docs/features/pricing-history.md` (that file is the draft: UI path, what it
reads and never does, the four steps, chips table, network etiquette, files,
troubleshooting).

`docs/USER_GUIDE.md`, "Where data lives" — one new row:

```md
| `%APPDATA%\poe2-trade-companion\pricing-history\<league>.json` | Daily poe2scout price bars kept per league so the timeline grows past 7 days. Item names, prices, quantities only. Delete any time (Tools → Pricing → Expert options → Clear local history). |
```

and add `pricing-history` to the `companion-settings.json` namespaces row
(favorites, sort, display unit, category, keep-history).

`docs/ARCHITECTURE.md`, current layout:

```md
- `src/core/pricingHistory.ts` — pure pricing-history helpers: row building, filters, display units, sparkline/timeline geometry, the stored-history merge.
- `src/main/features/pricingHistory/` — the `pricing:*` channels and the per-league history store under userData.
- `src/renderer/features/pricingHistory/` — Tools → Pricing (table, sparklines, timeline).
```

`docs/GGG_COMPLIANCE.md`, the read-only features paragraph: Pricing history
sends no game input and makes no trade2 request — it reads the paced poe2scout
trends cache (one page per category, ≥ 5 min between refreshes, shared with
Tools → Market) and writes only its own files under userData.

`docs/HANDOFF-overlay-port.md`, packages list:

```md
- P9 `pricing-history` — BUILT, offline-tested. First live check: pin the league in Settings → Market data, press Refresh once and confirm the header stamp and row counts; next day, Refresh again and confirm `pricing-history\<league>.json` gained bars (Expert options shows items · bars · file size).
```

## 10. Check

```
npm run check
npm run test:component
```
