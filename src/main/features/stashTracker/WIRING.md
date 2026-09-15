# WIRING — `stash-tracker` (P6)

Everything below is owned by the INTEGRATOR: these are the only edits outside
`src/{core,shared}/stashTracker*`, `src/main/features/stashTracker/`,
`src/renderer/features/stashTracker/`, `fixtures/stashTracker/`,
`tests/stash-tracker*`, `tests/component/stash-tracker*` and
`docs/features/stash-tracker.md`. Every path named here exists.

---

## 1. Feature registry — `src/main/features/registry.ts`

Import:

```ts
import { stashTrackerModule } from "./stashTracker/index.js";
```

Entry, under `// Features:` (after the foundations; order among wave-2 modules
does not matter — this module requires only `overlay` and `hotkeys`):

```ts
  stashTrackerModule,
```

## 2. Tools entry — `src/renderer/views/ToolsView.vue`

Import:

```ts
import StashTrackerTool from "../features/stashTracker/StashTrackerTool.vue";
```

In `tools`, after the `pricing` entry:

```ts
  { id: "stash-tracker", label: "Stash tracker", detail: "Snapshots & history" },
```

In the template, above the final `v-else`:

```vue
        <StashTrackerTool v-else-if="selectedTool === 'stash-tracker'" />
```

The tool renders `<h2 id="stash-tracker-title">Stash tracker</h2>`, which is
the heading the e2e smoke asserts. Deep link: `/tools/stash-tracker`; the hash
selects the sub-tab (`#history`, `#compare`, `#tabs`, `#timeline`).

## 3. Router and nav — nothing

`/tools/:tool?` already covers the route, and the package adds no primary nav
item. Optional one-line cross-link in `src/renderer/views/WealthView.vue`'s
hero copy:

```vue
        <RouterLink to="/tools/stash-tracker">Snapshots &amp; history →</RouterLink>
```

## 4. Overlay panel — `src/renderer/overlay/panels.ts`

Inside `OVERLAY_PANELS`, after `NOTICE_PANEL`:

```ts
  {
    id: "stash-prices",
    title: "Stash prices",
    component: () => import("../features/stashTracker/panels/StashPricesPanel.vue"),
    defaultAnchor: "bottom-right",
    defaultSize: { width: 300, height: 168 },
  },
```

The service shows it with the same anchor and size, so a panel definition that
disagrees only changes where it first lands.

## 5. Hotkeys UI — nothing

`OverlayHotkeysSection.vue` lists contributed actions by `group`. This package
contributes three:

| id | group | default |
|---|---|---|
| `stash-tracker.overlay-toggle` | Overlay | `Alt+P` |
| `stash-tracker.overlay-next-tab` | Overlay | (unbound) |
| `stash-tracker.snapshot` | Stash tracker | (unbound) |

If `Alt+P` collides with a reserved accelerator, `hotkeys:validate` reports it
and the action stays unbound — the tool's "Show overlay" button still works.

## 6. Settings — nothing in Tools → Settings

The package's options live behind `<details class="advanced-options">Expert
options</details>` on its own tool (minimal-config rule). A cross-reference
line is all that Settings needs, if anything:

> Stash tracker options: Tools → Stash tracker → Expert options.

## 7. Item log — nothing

## 8. `tests/input-boundary.test.ts`

`src/main/features/stashTracker/hostProbe.ts` is the ONE allowed
`startWinHost` import outside the chat-commands package. Add it to the
exceptions with an assertion that pins it to a query:

```ts
  // stash-tracker: the price overlay reads the PoE window rectangle and
  // nothing else. Its only op must stay "rect".
  const stashProbe = readFileSync("src/main/features/stashTracker/hostProbe.ts", "utf8");
  expect(stashProbe).toContain('op: "rect"');
  expect(stashProbe).not.toMatch(/op:\s*"(?:click|ctrlclick|ctrlburst|rightclick|drag|hotkey|type|move|focus)"/);
```

The directory scan over `src/main/features/**/*.ts` and
`src/core/stashTracker*.ts` should otherwise find no `startWinHost`,
`winHostInputSink` or `gameInputController` import from this package.

## 9. e2e — `e2e/public-companion.spec.ts`

In `TOOLS`:

```ts
  ["Stash tracker", "Stash tracker", "/tools/stash-tracker"],
```

On a fresh `--user-data-dir` the tool renders without network and without a
`pageerror`; its empty state reads `Nothing in the ledger yet — run a sort,
then come back.` `e2e/authorized-qa.spec.ts`: no change.

## 10. electron-builder — nothing

No bundled data files; `fixtures/stashTracker/**` is test-only.

## 11. Docs

**`README.md`**, under the item-intelligence bullets:

```md
- **Stash tracker** (Tools) — snapshots of the stash ledger, history and compare (incl. removed items), session gains, per-tab totals, exclusions and a worth timeline; `Alt+P` labels the open stash tab with your ledger's price estimates (read-only overlay, no game input).
```

**`docs/USER_GUIDE.md`**, a new `### Stash tracker` section under "Tools & QA",
from `docs/features/stash-tracker.md`. "Where data lives" rows:

```md
| `%APPDATA%/poe2-trade-companion/stash-tracker/snapshots.jsonl` | Stash tracker snapshots, one per line (auto ones pruned to the cap; auto snapshots older than 7 days keep totals only) |
| `%APPDATA%/poe2-trade-companion/stash-tracker/summary.json` | Session gains mirror for the Home page (copied to `stash-tracker-summary.json` next to it) |
```

Settings namespace row: `stash-tracker` in `companion-settings.json`
(exclusions, auto-snapshot cap, overlay options).

**`docs/ARCHITECTURE.md`** "Current layout":

```md
- `src/core/stashTracker{Snapshot,Timeline,Overlay}.ts` — snapshot/diff model, worth timeline, in-stash price overlay plan (pure).
- `src/main/features/stashTracker/` — snapshot journal + summary mirror under userData, the `{ op: "rect" }` window probe, and the click-through price label window.
- `src/renderer/features/stashTracker/` — Tools → Stash tracker, and the `stash-prices` overlay legend.
```

**`docs/HANDOFF-overlay-port.md`** first live checks:

```md
- Stash tracker: `Alt+P` over an open, previously scanned tab — labels align with the items (top-level tabs shifted one strip row); clicks over the grid still reach the game; the legend's × hides the labels too.
```

**`docs/GGG_COMPLIANCE.md`**: ADD one line. This package is the second place in
the app that spawns `scripts/win-input-host.ps1`, and it introduces a new
QA-trace record type, so the compliance doc stops being a complete inventory
without it. Paste under the game-facing paths list:

```md
- Stash tracker price overlay (`src/main/features/stashTracker/hostProbe.ts`): one passive `{ op: "rect" }` window query per user gesture — no key, no click, no focus change. Refused while the emergency stop is latched, skipped while another input host is alive, and traced in `qa-action-trace.jsonl` as `stash-tracker-rect-probe`. Timers never probe; they re-draw from the last measured rectangle.
```

## 12. Cross-package contract (P7 `session-home`)

P6 writes `<userData>/stash-tracker/summary.json` AND a byte-identical copy at
`<userData>/stash-tracker-summary.json`. The shape is
`TrackerSummaryFile` in `src/core/stashTrackerSnapshot.ts`
(`sessionStart`, `latest`, `sessionGainExalted`, `sessionGainDivine`,
`snapshotCount`, `excludedCount`, plus `SnapshotKind`). Those names are FROZEN;
P7 should read one of the two paths and nothing else from this package.

The mirror is written FIRST and the canonical file last, so a half-failed
write can only leave the mirror ahead of the canonical file — never a stale
mirror presented as current. P7 is free to pin either path; pinning the
canonical `<userData>/stash-tracker/summary.json` is the safer of the two.
