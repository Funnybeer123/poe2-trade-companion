# WIRING — package `session` (P7: Home, character, mapping, recap, deaths)

Everything below is an edit to a SHARED file. The session package owns none of
them; the integrator applies these lines verbatim. Every path named here exists
in the tree.

Files this package ships:

| Path | What |
|---|---|
| `src/core/sessionTracker.ts` | pure reducer: areas → runs, deaths, AFK, campaign, metrics |
| `src/core/sessionHistory.ts` | session records, sanitizers, JSONL, summaries |
| `src/core/sessionHome.ts` | stash gains, trade earnings, market movers, recommendations |
| `src/core/sessionDeaths.ts` | death-screenshot index, file names, prune plan |
| `src/shared/session.ts` | `SessionContract`, `SessionEvents`, settings + sanitizer |
| `src/main/features/session/index.ts` | the feature module (`sessionModule`) |
| `src/main/features/session/service.ts` | `SessionService` |
| `src/main/features/session/deathCapture.ts` | `DeathCapturer` (desktopCapturer) |
| `src/main/features/session/stashFiles.ts` | read-only access to P6's and P3's files |
| `src/renderer/features/session/api.ts` | renderer clients |
| `src/renderer/features/session/format.ts` | display helpers |
| `src/renderer/features/session/views/HomeView.vue` | route `/home` |
| `src/renderer/features/session/components/*.vue` | Home cards, Maps, History, Deaths, Settings section |
| `src/renderer/features/session/panels/SessionRecapPanel.vue` | overlay panel `session-recap` |
| `fixtures/session/*` | offline fixtures |
| `tests/session-home-*.test.ts`, `tests/component/session-home-*.test.ts` | tests |
| `docs/features/session-home.md` | the feature doc |

---

## 1. Registry — `src/main/features/registry.ts`

Import:

```ts
import { sessionModule } from "./session/index.js";
```

Entry, in the `// Features:` block, in the order REVIEW-conflicts §6 fixes
(`… stashTrackerModule, sessionModule, campaignGuideModule …`):

```ts
  sessionModule,
```

`sessionModule` requires the `clientLog` service and only *gets* `overlay` and
`hotkeys`, so it must come after the foundations but needs no wave-2 module.

## 2. Router — `src/renderer/router/index.ts`

Replace `{ path: "/", redirect: "/sort" }` with:

```ts
  {
    path: "/",
    redirect: "/home",
  },
  {
    path: "/home",
    name: "home",
    component: () => import("../features/session/views/HomeView.vue"),
    meta: {
      title: "Home",
      eyebrow: "Overview",
      description:
        "Character, session and map activity from Client.txt, stash gains, market movers, and what to set up next.",
    },
  },
```

and change the catch-all to `/home`:

```ts
  { path: "/:pathMatch(.*)*", redirect: "/home" },
```

## 3. Nav — `src/renderer/App.vue`

Prepend to `navigation` (Home first, per REVIEW-conflicts §6):

```ts
  { to: "/home", label: "Home", short: "HO", detail: "Session & setup" },
```

and point the brand link at it:

```vue
<RouterLink class="brand" to="/home" aria-label="PoE2 Intelligence home">
```

"Home" is not a word-prefix of any other rail label.

## 4. Overlay panel — `src/renderer/overlay/panels.ts`

Add after `NOTICE_PANEL` (anchor `center`, per REVIEW-conflicts §6 and §7 P7.5):

```ts
export const SESSION_RECAP_PANEL: OverlayPanelDefinition = {
  id: "session-recap",
  title: "Session recap",
  component: () => import("../features/session/panels/SessionRecapPanel.vue"),
  defaultAnchor: "center",
  defaultSize: { width: 380, height: 300 },
};
```

and list it in `OVERLAY_PANELS`:

```ts
export const OVERLAY_PANELS: OverlayPanelDefinition[] = [NOTICE_PANEL, /* … */ SESSION_RECAP_PANEL];
```

## 5. Tools — `src/renderer/views/ToolsView.vue`

Nothing. P7 adds no tool; its settings live in the Settings panel (below) and
everything else is on `/home`.

## 6. Settings — `src/renderer/components/tools/FilterSettingsTool.vue` (`panel="settings"`)

Mount last of the four sections (order from REVIEW-conflicts §6: P10, P1, P5, P7),
after the Market data `</template>` and before `.settings-facts`:

```vue
<SessionSettingsSection />
```

with

```ts
import SessionSettingsSection from "../../features/session/components/SessionSettingsSection.vue";
```

The section reads and writes the `session` namespace through the scaffold's own
`settings:get` / `settings:set`, so it needs no other wiring.

## 7. Hotkeys UI

Nothing. `OverlayHotkeysSection.vue` groups by `group`, so the "Session" group
("Show session recap", "Capture a screenshot now") appears by itself. Both
actions ship unbound (`defaultAccelerator: null`).

## 8. Item log — `src/renderer/views/ItemsView.vue`

Nothing.

## 9. `tests/input-boundary.test.ts`

Include this package in the directory scan required by REVIEW-compliance §0.2:

```
src/main/features/session/**
```

It must contain no `startWinHost` / `winHostInputSink` / `gameInputController`
import and no `host.send({ op: … })`. P7 sends no game input at all.

## 10. e2e

`e2e/public-companion.spec.ts` — prepend to `WORKSPACES`:

```ts
  ["Home", "Home", "/home"],
```

and, inside the per-workspace loop:

```ts
  if (label === "Home") {
    await expect(
      page.getByRole("list", { name: "Setup checklist" }).getByText("Client.txt", { exact: false }),
    ).toBeVisible();
  }
```

(On a fresh user-data directory there is no session; the checklist still renders
— the Client.txt row comes from the app-settings checklist, or from Home's own
fallback row when that package is absent.)

`e2e/authorized-qa.spec.ts` — prepend the same triple to `routes`.

Any assertion that assumed `/sort` is the first screen now moves behind
`navigatePrimary(page, "Sort", …)`: the launch route is `/home`.

## 11. electron-builder

Nothing. P7 bundles no data file.

## 12. Docs

**README.md**, under the item-intelligence bullets:

```markdown
- **Home** — character, session, map runs and deaths from Client.txt; stash gains and market movers from local caches; what is still worth setting up. No game input, no network.
```

**docs/USER_GUIDE.md** — a new `## Home` section (full text in
`docs/features/session-home.md`), with H3s:

```
### Character & campaign
### Session & maps
### AFK and post-game recap
### Death screenshots (replay-lite)
### What is set up
```

"Where data lives" rows:

| File | What |
|---|---|
| `%APPDATA%\poe2-trade-companion\session-current.json` | the session in progress, rewritten at most once a minute |
| `%APPDATA%\poe2-trade-companion\session-history.jsonl` | the newest 200 finished sessions |
| `%APPDATA%\poe2-trade-companion\deaths\` | death screenshots (JPEG + thumbnail) and their index. They stay on this PC, are never uploaded and can show chat and player names. |

"What this build will not do": "no experience or gold per map, and no time to
next level — those need an account link this app does not have."

**docs/ARCHITECTURE.md**, "Current layout":

```
src/core/session*.ts            — session reducer, history records, Home aggregation, death index (pure)
src/main/features/session/      — the session service: Client.txt → runs, recap, death screenshots
src/renderer/features/session/  — Home (/home), the Maps/History/Deaths tabs and the session-recap overlay panel
```

**docs/HANDOFF-overlay-port.md**, first live checks for this package:

1. Start the app after the game with a level-up in the last 2 MB of Client.txt → Home shows the character.
2. Run one map → a run row with its tier appears under Home → Maps.
3. Die → a screenshot lands under Home → Deaths within ~2 s (or the black-frame note appears: the game must be borderless windowed).
4. `/afk` in game → the recap panel opens centred; `/afk off` hides it again.
5. Quit the game → a Windows notification and the "Last session" card on Home within ~2–3 min
   (four absent process polls plus two minutes of log silence; the probe must have seen the game
   at least once during the session, so a blocked PowerShell never ends one on its own).

**docs/GGG_COMPLIANCE.md**: one line — "Home / session: reads Client.txt and
local files only. No game input, no network requests, no account data."
