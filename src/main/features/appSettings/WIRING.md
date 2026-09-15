# WIRING — `appSettings` (P10)

Exact lines the integrator adds. Nothing in this package edits a shared file
itself. Every referenced file exists today except `CHANGELOG.md`, which item 5
creates.

## 1. Registry — `src/main/features/registry.ts`

```ts
import { appSettingsModule } from "./appSettings/index.js";
```

Append `appSettingsModule,` as the **last** entry under `// Features:`
(REVIEW-conflicts §6 registry order). It only requires foundations, but going
last lets `app:setup-checklist` `ctx.get()` anything registered before it.

## 2. Settings panel — `src/renderer/components/tools/FilterSettingsTool.vue`

```ts
import AppSettingsSections from "../../features/appSettings/AppSettingsSections.vue";
```

```html
<AppSettingsSections />
```

Insert it after the closing `</template>` of the `v-if="feedApi"` Market data
block (line 466) and before `<div class="settings-facts">` (line 468) — the
first of the four wave-2 settings mounts, ahead of `<EvaluateSettingsSection />`
(P1), `<InspectSettingsSection />` (P5) and `<SessionSettingsSection />` (P7).

Optional: wrap the Market data heading in `<div id="market-data">` so the
checklist's `open-market-data` action (`/tools/settings#market-data`) scrolls
there.

`src/renderer/views/ToolsView.vue` keeps its existing entry
`{ id: "settings", label: "Settings", detail: "Automation defaults" }`.
(If the e2e `TOOLS` triple below is updated in step 7, `detail` must match.)

## 3. Nav, routes, Tools entries, overlay panels, hotkeys UI

**None.** No new route, no new Tools entry, no new overlay panel (the overlay
test reuses the foundation's `notice` panel). `app.show-window` appears
automatically under the group **Desktop** in `OverlayHotkeysSection.vue`,
because that section groups by `binding.group`.

## 4. P7 Home

Home invokes `app:setup-checklist` through its own local contract type. Do
**not** import `SetupChecklistCard.vue` outside
`src/renderer/features/appSettings/`. The `SetupChecklist` shape and the
`action` strings in `src/shared/appSettings.ts` are frozen for that reason.

## 5. `CHANGELOG.md` at the repo root (create) + packaging

Seed (Keep a Changelog):

```markdown
# Changelog

## [Unreleased]
### Added
- Overlay port: feature modules, overlay panels, hotkeys, client-log tailing

## [0.1.0] - 2026-09-01
- Initial companion
```

Add `- CHANGELOG.md` to the `files:` list in **both** builder configs (neither
lists it today):

- `electron-builder.public.yml` — after `  - fixtures/market/quotes.json` (line 6)
- `electron-builder.qa.yml` — after `  - scripts/win-input-host.ps1` (line 9)

Main reads `path.join(ctx.appPath, "CHANGELOG.md")`, which resolves inside the
asar. No Vite change. Bump `package.json` `version` when cutting a release so
the "N new" badge works.

## 6. Docs

- **README.md** bullet: `- **Settings** (Tools): overlay placement/scale/opacity, chat-command switch, Client.txt override, window reset, a first-run checklist and the changelog.`
- **docs/USER_GUIDE.md** `### Settings` — outline drafted in `docs/features/app-settings.md` §User guide.
- **docs/USER_GUIDE.md** "Where data lives": `companion-settings.json` — "Overlay, app, chat-command and per-feature settings — never a token or cookie (those live in `*.secret.json` files)"; `overlay-hotkeys.json` — "Overlay & command hotkey bindings".
- **docs/ARCHITECTURE.md** "Current layout": one line each for `src/main/features/appSettings/` and `src/renderer/features/appSettings/`.
- **docs/GGG_COMPLIANCE.md**: add to the read-only list "Settings sends no game input and makes no trade2 requests of its own", plus:
  - the **administrator-rights check** paragraph: pressing *Check administrator rights* in Settings → Game client runs one fixed PowerShell script that enumerates `PathOfExile*` processes and attempts a single handle open per process to see whether the handle is denied. It reads no process memory, writes nothing, and injects nothing. It runs **only** on that button press — never on page load, never on a timer — and `app:elevation` is refused outright in the `public-companion` build.
  - the **elevated-relaunch** paragraph (user-consented UAC prompt; never silent; an elevated companion drives an elevated game through the same audited chain — this is the UIPI point of the feature, not a bypass).
- **docs/HANDOFF-overlay-port.md** first live checks (all UNVERIFIED):
  1. Elevation probe against an elevated game (expect the hint) and a normal game (expect "no").
  2. Relaunch as administrator round-trip — confirm the elevated dev copy actually starts (the command now passes the absolute app path plus `-WorkingDirectory`; the `$env:` prefix does **not** survive the elevation broker, the mode travels in the `__POE2_BUILD_MODE__` bundle define). Check the packaged path too, which passes neither argument.
  3. Test overlay on a second monitor with `primaryMonitorOnly` on and off.
  4. Reset window positions hides a pinned panel too.
  5. Window bounds survive a restart and the reset re-centres — **the window appears centred first and then jumps to the saved bounds** (`createWindow()` has no `show: false`); expected, not a bug.
  6. `showOnGameStart` restores the window within ~20 s of the game appearing, without stealing its focus.

## 7. e2e — `e2e/public-companion.spec.ts`

Add to `TOOLS`: `["Settings", "Automation defaults", "/tools/settings"]`, and
after the loop:

```ts
await expect(page.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
await expect(page.locator("summary", { hasText: /^Changelog/ })).toBeVisible();
```

**Not** `getByText("Changelog", { exact: true })`: on a fresh user-data dir
`lastSeenVersion` is `""`, so the summary renders "Changelog" plus the "N new"
badge and an exact whole-string match fails. No network is touched (nothing
clicks *Check leagues*) and **no process is spawned**: nothing probes the
elevation on mount, and `app:elevation` is refused in `public-companion`
anyway, so visiting `/tools/settings` never launches powershell.exe.
`e2e/authorized-qa.spec.ts` needs nothing new.

## 8. Input boundary — `tests/input-boundary.test.ts`

The test reads a fixed file list. Add inside the existing `it`:

```ts
for (const file of [
  "src/main/features/appSettings/index.ts",
  "src/main/features/appSettings/windowBounds.ts",
  "src/main/features/appSettings/elevationProbe.ts",
]) {
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("startWinHost");
  expect(text).not.toContain("winHostInputSink");
  expect(text).not.toMatch(/(?:host|win)\.send\(/);
}
```

If the integrator instead adopts the compliance judge's directory walk over
`src/main/features/**` (REVIEW-compliance §0.2), these three files are covered
by it and the explicit lines are redundant but harmless.
