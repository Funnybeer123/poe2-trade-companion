# WIRING — P8 `campaign-guide` (feature module `campaignGuide`)

Everything below lives in files this package does not own. The integrator adds
them verbatim. Package id `campaign-guide` · module id `campaignGuide` · channel
prefix `campaign:*` · settings namespace `campaign-guide` · overlay panel id
`campaign` · hotkey action `campaign.toggle` (`Alt+G`, group `Overlay`) · Tools
entry "Campaign guide" at `/tools/campaign`.

Files this package ships (all exist):

- `src/core/campaignGuide.ts`, `src/core/campaignGuideMap.ts`
- `src/shared/campaignGuide.ts`
- `src/main/features/campaignGuide/index.ts`, `src/main/features/campaignGuide/routeStore.ts`
- `src/data/campaign/route.json`
- `src/renderer/features/campaignGuide/` (`campaignApi.ts`, `useCampaignGuide.ts`,
  `CampaignGuideTool.vue`, `CampaignAreaCard.vue`, `CampaignObjectiveList.vue`,
  `CampaignWorldMap.vue`, `CampaignXpHelper.vue`, `CampaignAreaEditor.vue`,
  `CampaignGuideSettingsSection.vue`, `CampaignPanel.vue`)
- `fixtures/campaign-guide/{route-mini.json,customisations.json,client-log-campaign.txt}`
- `tests/campaign-guide.test.ts`, `tests/campaign-guide-map.test.ts`,
  `tests/campaign-guide-route-data.test.ts`, `tests/campaign-guide-module.test.ts`,
  `tests/component/campaign-guide-tool.test.ts`, `tests/component/campaign-guide-panel.test.ts`
- `docs/features/campaign-guide.md`

---

## 1. `src/main/features/registry.ts`

Import (with the other feature imports):

```ts
import { campaignGuideModule } from "./campaignGuide/index.js";
```

Entry in `FEATURE_MODULES`, under `// Features:` — after `sessionModule`, before
`pricingHistoryModule` (REVIEW-conflicts §6 registry order):

```ts
  campaignGuideModule,
```

It `require`s `clientLog` and `hotkeys` and `get`s `overlay`, so it must come
after the foundations (it already does — they are the first five entries).

## 2. `src/renderer/overlay/panels.ts`

Append to `OVERLAY_PANELS` (verbatim from REVIEW-conflicts §6):

```ts
{ id: "campaign", title: "Campaign guide", component: () => import("../features/campaignGuide/CampaignPanel.vue"), defaultAnchor: "right", defaultSize: { width: 380, height: 520 }, resizable: false },
```

`PanelHost.vue` supplies the title bar, pin and close chrome; the panel body
scrolls itself.

## 3. `src/renderer/views/ToolsView.vue`

Import:

```ts
import CampaignGuideTool from "../features/campaignGuide/CampaignGuideTool.vue";
```

`tools` entry — last, after `stash-tracker` (REVIEW-conflicts §6 Tools order):

```ts
{ id: "campaign", label: "Campaign guide", detail: "Route, map & XP" },
```

Mount, above the final `v-else`:

```vue
<CampaignGuideTool v-else-if="selectedTool === 'campaign'" />
```

No new router route: the tool lives at `/tools/campaign` under the existing
`/tools/:tool?` (its `meta` is unchanged). Deep links from other packages use
`router.push("/tools/campaign")`, or `ctx.emit("app:navigate", { path: "/tools/campaign" })`
from main.

## 4. Hotkeys UI — nothing to add

`OverlayHotkeysSection.vue` lists every contributed action by group, so
`campaign.toggle` ("Campaign guide", `Alt+G`, group `Overlay`) appears in
Tools → Hotkeys on its own.

## 5. `src/renderer/components/tools/FilterSettingsTool.vue` (`panel="settings"`)

The five guide preferences live on the Campaign guide tool
(`CampaignGuideSettingsSection.vue`), per REVIEW-conflicts §6 ("P4/P6/P8/P9 on
their tools"). Tools → Settings gets ONE cross-reference line, next to the other
cross-references (or as a `.settings-facts` line):

> Campaign guide: overlay position, automatic show/hide, compact mode and the
> level override live under Tools → Campaign guide → Guide settings.

If the integrator prefers the section under Settings instead, mount
`<CampaignGuideSettingsSection :settings="…" />` there — it depends only on
`getAppFeatureApi()`; no P8 change needed. It writes through `settings:set`
itself, but the current values come in as a **required `settings` prop**, so
the host screen needs a source for them: either `invoke("campaign:route")` and
pass `view.settings`, or `useCampaignGuide()` and pass `store.settings.value ??
defaultCampaignGuideSettings()`. It emits `changed` after a successful write —
re-read the route (or ignore it and let `campaign:route-changed` do the work).

## 6. Packaging — `electron-builder.qa.yml` and `electron-builder.public.yml`

Add to both `files:` lists (REVIEW-conflicts §6, next to P10's `CHANGELOG.md`):

```yaml
  - src/data/campaign/route.json
```

Main reads it from `ctx.appPath` in a packaged build. Without the line the
packaged app degrades to `bundled.source: "missing"` with a visible warning —
the guide still works for the user's own areas.

## 7. `tests/input-boundary.test.ts`

The new directory scan (REVIEW-compliance §0.2) must include
`src/main/features/campaignGuide/**` and `src/core/campaignGuide*.ts`. This
package needs **no exception**: it imports no `startWinHost`,
`winHostInputSink` or `gameInputController` and sends no host op.

## 8. e2e — `e2e/public-companion.spec.ts`

Append to `TOOLS`:

```ts
  ["Campaign guide", "Campaign guide", "/tools/campaign"],
```

Assert only the heading and the community chip:

```ts
await expect(page.getByText("Community-maintained · verify in game")).toBeVisible();
```

Do NOT assert the "No area seen yet" empty state: `withPackagedElectron`
launches with `env: { ...process.env, … }` and the tailer auto-locates the real
Client.txt, so on a machine with PoE2 installed the strip shows a real area. If
a branch is wanted later, read `client-log:status` through
`page.evaluate(() => window.poe2.features.invoke("client-log:status"))` and
assert the empty line only when `source === "none"`.

## 9. Docs

**`README.md`** — Item intelligence workspace bullets:

```md
- **Campaign guide** (Tools) — community-maintained levelling route with the current area from Client.txt, an under/over-levelled estimate, a schematic world map, and an in-game overlay (Alt+G) that appears in campaign areas. No input, no network.
```

**`docs/USER_GUIDE.md`** — under "## Tools & QA" add `### Campaign guide` from
`docs/features/campaign-guide.md` (it is written as that section: purpose, the
"never moves your character" sentence, numbered steps, the community
disclaimer, the XP-chip table, the overlay paragraph, the troubleshooting table
and the estimates sentence). Also add the "Where data lives" row:

```md
| %APPDATA%\poe2-trade-companion\companion-settings.json → campaign-guide | Route customisations, ticked objectives, visited areas (area ids and timestamps only) |
```

and, under "What this build will not do": "no quest automation or waypoint
travel — the guide only tells".

**`docs/ARCHITECTURE.md`** — "Current layout":

```md
- `src/core/campaignGuide.ts` + `campaignGuideMap.ts` — campaign route sanitizer, merge, area resolution, XP estimate, map layout (pure).
- `src/main/features/campaignGuide/` — the `campaign:*` channels, the auto-showing overlay panel and the `campaign-guide` settings namespace.
- `src/renderer/features/campaignGuide/` — Tools → Campaign guide and the `campaign` overlay panel.
- `src/data/campaign/route.json` — the bundled community route (every entry `verified: false`).
```

"Data on disk": the `campaign-guide` namespace of `companion-settings.json`.

**`docs/GGG_COMPLIANCE.md`** — the "Read-only features" sentence
(REVIEW-compliance §12 item 6) covers the Campaign guide: no game input, no
trade2; the campaign overlay panel is display-only and pinned.

**`docs/HANDOFF-overlay-port.md`** — "Packages", P8 paragraph: BUILT / ZERO LIVE
RUNS. First live checks:

1. Enter Clearfell with the app running → the panel appears pinned at the right edge and the game keeps the mouse.
2. Portal to the hideout → the panel hides within one poll.
3. × on the panel → it does not return until the next area.
4. `Alt+G` toggles it.
5. A level-up line updates the XP chip.
6. Quit the game with the panel open, relaunch, enter an area → it auto-shows again (the silent-sweep path).
7. `Ngakanu` and the act-4 names: rename in-app, export, and paste the JSON into `route.json` if it is right.

## 10. `npm run check`

`tests/campaign-guide*.test.ts` run in `test:unit`;
`tests/component/campaign-guide-*.test.ts` run in `test:component`. No new
dependency, no `package.json` change.
