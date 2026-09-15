# WIRING — package `market` (P2, the in-app trade browser)

Every line below goes into a file this package does **not** own. Paths are
repo-relative and all of them exist. Order follows REVIEW-conflicts §6.

---

## 1. Registry — `src/main/features/registry.ts`

Import:

```ts
import { marketModule } from "./market/index.js";
```

Entry, under `// Features:` — after `inspectModule`, before `tradeModule`
(§6 registry order: `evaluateModule, inspectModule, marketModule, tradeModule, …`):

```ts
  marketModule,
```

Market calls `ctx.require("liveSearch")` and `ctx.require("chatCommands")`, so it
must register **after** the foundation modules (`clientLogModule, hotkeysModule,
overlayModule, chatCommandsModule, liveSearchModule`). `hotkeys` and `overlay`
are optional (`ctx.get`) — the module registers without them.

## 2. liveSearch budget guard — `src/main/features/liveSearch/index.ts`

The live-search fetch guard is inert until the feed's budget is wired in
(FOUNDATION-EXTENSIONS, owner 4, note 1). Add one property to the existing
`createLiveSearchService({ … })` call:

```ts
        budget: () => ctx.core.priceFeed.tradeBudget(),
```

Without it, compliance §0.4 is not actually enforced.

Market's own `minSpareFetches` expert setting governs **paging** only; the live
fetch guard uses the live-search service's own `minSpareFetches` option
(default 2). Market cannot forward its setting — that option is set where the
service is constructed, in the file above. If the two should ever agree, add
`minSpareFetches: <n>` there too; this package deliberately does not reach into
another module's service to change it.

## 3. Router — `src/renderer/router/index.ts`

Insert before the `/tools/:tool?` record:

```ts
  {
    path: "/market",
    name: "market",
    component: () => import("../features/market/views/MarketView.vue"),
    meta: {
      title: "Market",
      eyebrow: "Operate",
      description:
        "Browse trade2 listings, keep favourite searches, run live searches, and whisper sellers — one chat line per click.",
    },
  },
```

## 4. Nav — `src/renderer/App.vue`

In `navigation`, immediately after the Shop entry:

```ts
  { to: "/market", label: "Market", short: "MK", detail: "Trade browser" },
```

Market's `Alt+M` hotkey fronts the window and then emits the scaffold's
`app:navigate` event. It relies on the ONE subscription the integrator adds in
`App.vue`'s `onMounted` (REVIEW-conflicts §5 F0) — Market adds no subscription
of its own and ships no `useMarketFocus`:

```ts
  getAppFeatureApi()?.on("app:navigate", ({ path }) => void router.push(path));
```

## 5. Tools entries — none

Market is a primary view. `Tools → Market` (id `market`, the trends tool) is a
different landmark and is left alone; this package never registers
`market:trends` or `market:trends-refresh`.

## 6. Settings — none in `FilterSettingsTool.vue`

Per REVIEW-conflicts §7 P2.2 the Market settings live on the Market view
(`<details class="advanced-options">Market settings</details>` at the bottom of
`MarketView.vue`). Optional cross-reference line for the Settings panel's
Market-data sub-section:

```html
<p class="muted">Trade-browser defaults, live-search sound and the request budget live on <RouterLink to="/market">Market</RouterLink>.</p>
```

## 7. Overlay panels — none

Market registers no panel in `src/renderer/overlay/panels.ts`. It only *uses*
the foundation's `notice` panel for live-search toasts when the overlay service
is present.

## 8. Hotkeys UI — nothing to add

`OverlayHotkeysSection.vue` lists contributed actions. `market.open` appears
under the group **Desktop** with `Alt+M`.

## 9. `tests/input-boundary.test.ts`

Per REVIEW-compliance §0.2, the directory scan must include
`src/main/features/market/**` (no `startWinHost` import, no `host.send({op: …})`).
Market passes as written: its only game-input path is
`ctx.require("chatCommands").send(...)`.

## 10. electron-builder — `electron-builder.public.yml` and `electron-builder.qa.yml`

Add under `files:` (the curated data the module reads from `ctx.appPath`):

```yaml
  - src/data/market/category-labels.json
  - src/data/market/exchange-currencies.json
  - src/data/market/weight-templates.json
```

`category-labels.json` is also imported by the renderer bundle, so the two
exchange/template files are the ones that strictly need the entry; listing all
three keeps them together.

## 11. e2e — `e2e/public-companion.spec.ts`

In `WORKSPACES`, after the Shop row:

```ts
  ["Market", "Market", "/market"],
```

And inside the per-workspace loop, the fresh-profile assertion (the view renders
this without any network):

```ts
      if (label === "Market") {
        await expect(page.getByText("No tabs yet — start a search or open a favourite.")).toBeVisible();
      }
```

## 12. e2e — `e2e/authorized-qa.spec.ts`

In `routes`, after the Shop row:

```ts
      ["Market", "Market", "/market"],
```

## 13. Docs

`README.md`, under the item-intelligence bullets:

```md
- **Market** — in-app trade2 browser: query builder with stat autocomplete, favourites in folders, bulk exchange, live search (≤ 20), whisper/hideout with one chat line per click. Never buys or accepts trades.
```

`docs/USER_GUIDE.md` — new `## Market (trade browser)` after the Shop section
and before Wealth, with the H3s and the exact copy in
[`docs/features/market.md`](../../../../docs/features/market.md) § "USER_GUIDE
section". Add three rows to "Where data lives":

| File | What it holds |
|---|---|
| `market-favorites.json` | Saved searches and their folders — queries only, never listings |
| `market-tabs.json` | The open Market tabs: drafts, labels, colours. Never results |
| `market-live-searches.json` | Live-search ids and labels, so they can be restarted |

and the settings namespace `market` to the `companion-settings.json` row.

`docs/ARCHITECTURE.md` "Current layout":

```md
- `src/core/market*.ts` — Market's pure model: drafts, tab sessions, favourites, stat autocomplete, exchange and import helpers.
- `src/main/features/market/` — the Market feature module: tab sessions, trade2 requests, live searches, the three `market-*.json` files.
- `src/renderer/features/market/` — the `/market` view: builder, results, favourites explorer, live-search column.
- `src/data/market/` — curated category labels, exchange currency ids and weighted-sum templates.
```

`docs/GGG_COMPLIANCE.md`, in the chat-commands section:

```md
- Market: one whisper (or one `/hideout`) per click, through the same chat-command path; secure listings are never whispered or bought; live-search results never trigger input.
```

`docs/HANDOFF-overlay-port.md`, "Packages": link the first-live-check list in
`docs/features/market.md` § "First live checks".

## 14. Preload contract test — unchanged

Market rides the generic `window.poe2.features` bridge; no
`src/main/preload.ts` or `src/shared/ipc.ts` change.
