# WIRING — P4 `commandsBookmarksNotes`

Everything below touches files this package does not own. Lines are verbatim;
paths are relative to the repo root. Matches REVIEW-conflicts §6 (registry
order, Tools entries, panel registry, e2e, docs) and §7 P4 (notes anchor
`left`, `stashSearch(..., { focus: true })`, `overlay:set-focus` hand-back).

## 1. Feature registry — `src/main/features/registry.ts`

Import, next to the other feature imports:

```ts
import { commandsBookmarksNotesModule } from "./commandsBookmarksNotes/index.js";
```

Entry, under `// Features:` (after `tradeModule`, before `stashTrackerModule`,
per the §6 registry order; it needs `hotkeys`, `overlay` and `chatCommands`,
and optionally uses `clientLog` — all foundations, so any position after the
foundations works):

```ts
  commandsBookmarksNotesModule,
```

## 2. Tools entry — `src/renderer/views/ToolsView.vue`

Import:

```ts
import CommandsNotesTool from "../features/commandsBookmarksNotes/CommandsNotesTool.vue";
```

In `const tools = [ … ]`, immediately after the `hotkeys` entry:

```ts
  { id: "commands", label: "Commands & notes", detail: "Hotkeys, searches, bookmarks" },
```

In the template's `v-if`/`v-else-if` chain, after
`<HotkeyActionsTool v-else-if="selectedTool === 'hotkeys'" />`:

```html
      <CommandsNotesTool v-else-if="selectedTool === 'commands'" />
```

No new router record: the tool lives at `/tools/commands` through the existing
`/tools/:tool?` route. The tool reads `route.hash` one-way, so
`/tools/commands#searches`, `#bookmarks` and `#notes` deep-link to a tab.

## 3. Overlay panels — `src/renderer/overlay/panels.ts`

Inside `OVERLAY_PANELS`, after `NOTICE_PANEL`:

```ts
  {
    id: "notes",
    title: "Notes",
    component: () => import("../features/commandsBookmarksNotes/panels/NotesPanel.vue"),
    defaultAnchor: "left",
    defaultSize: { width: 440, height: 380 },
  },
  {
    id: "stash-search",
    title: "Stash search",
    component: () => import("../features/commandsBookmarksNotes/panels/StashSearchPanel.vue"),
    defaultAnchor: "cursor",
    defaultSize: { width: 380, height: 220 },
  },
```

Both ids are already reserved in that file's doc comment. Main shows them with
the same anchors and sizes (from the `notes` settings namespace and the fixed
380×220 for the search panel), so the registry entries only matter as a
fallback and for the title bar.

## 4. Hotkeys UI — `src/renderer/features/hotkeys/OverlayHotkeysSection.vue`

Nothing to add: the section groups by the contributed `group`, so **Overlay**
(Notes `Alt+N`, Stash search `Alt+F`), **Commands**, **Stash searches**,
**Bookmarks** and **Notes** appear on their own. Optional one-line addition to
the intro of `src/renderer/components/tools/HotkeyActionsTool.vue`:

> Commands, searches, bookmarks and notes get their rows from Tools →
> Commands & notes.

## 5. Settings — nothing

No section in Tools → Settings: feature config lives on the feature's own
panel (minimal-config rule 4). P10 may show the `commands`, `bookmarks` and
`notes` namespaces read-only from `settings:get`.

## 6. Input boundary — `tests/input-boundary.test.ts`

Include `src/main/features/commandsBookmarksNotes/**` in the directory scan
required by REVIEW-compliance §0.2. The package has no exception: no file in
it imports `startWinHost`/`winHostInputSink`/`gameInputController` or sends a
host op — every gesture goes through `ctx.require("chatCommands")`.

## 7. e2e — `e2e/public-companion.spec.ts`

In `const TOOLS = [ … ]`:

```ts
  ["Commands", "Commands & notes", "/tools/commands"],
```

The link regex `^Commands` is unique among the tool links, and
`Commands & notes` is the exact `h2` text. It renders against an empty
user-data dir (starter examples plus the "save to keep them" notice) and makes
no network request.

## 8. Docs

`README.md`, in the item-intelligence bullet list:

```md
- **Commands & notes** (Tools) — hotkey → one chat line with {player}/{area}/… placeholders, saved stash searches typed on a key press, bookmarks, and markdown/image cheat-sheet notes in the overlay (Alt+N; Alt+F opens the stash search panel).
```

`docs/USER_GUIDE.md`: paste `docs/features/commands-bookmarks-notes.md` as a
new `## Commands & notes` section under the "Tools & QA" chapter, and add its
"Where data lives" rows to the guide's own table:

```md
| Commands, stash searches, bookmarks, notes | `%APPDATA%\poe2-trade-companion\companion-settings.json` (namespaces `commands`, `bookmarks`, `notes`) |
| Note images | `%APPDATA%\poe2-trade-companion\notes-images\` |
```

`docs/GGG_COMPLIANCE.md`, in the chat-commands paragraph:

```md
Commands & notes adds no new input path: one key press types one chat line or
fills the stash search box once, through the chat command service, with no
repeat and no retry. The same gates apply in every build mode.
```

`docs/ARCHITECTURE.md` "Current layout":

```md
- `src/main/features/commandsBookmarksNotes/` — commands, stash searches, bookmarks and notes: one hotkey per item, one gesture per press.
- `src/core/commandsBookmarksNotes.ts`, `src/core/commandsBookmarksNotesMarkdown.ts` — sanitizers, placeholder context, note-image headers, the escape-first markdown subset.
- `src/renderer/features/commandsBookmarksNotes/` — the Tools editor and the `notes` / `stash-search` overlay panels.
```

and under "Data on disk": `notes-images/` (note image bytes, beside
`companion-settings.json`).

`docs/HANDOFF-overlay-port.md` "First live checks":

```md
- Commands & notes: (a) bind a command to Alt+1 and press it in the hideout — exactly one `/hideout` line and one trace entry; (b) Alt+F, type `"^Waystone"`, Enter — the stash box fills exactly once (the focus hand-back is UNVERIFIED live: it fails safe with "not-foreground"); (c) Alt+N shows the note without taking focus from the game.
```

## 9. electron-builder — nothing

No bundled data file: everything this package reads is written by the user at
runtime under `%APPDATA%`.

## Files this package owns

```
src/shared/commandsBookmarksNotes.ts
src/core/commandsBookmarksNotes.ts
src/core/commandsBookmarksNotesMarkdown.ts
src/main/features/commandsBookmarksNotes/{index,service,webWindow,noteImages}.ts
src/renderer/features/commandsBookmarksNotes/{api,editorRow}.ts
src/renderer/features/commandsBookmarksNotes/{CommandsNotesTool,CommandsTab,SearchesTab,BookmarksTab,NotesTab,ItemListEditor,HotkeyBindCell,PlaceholderChips,NoteMarkdown,NoteImageField}.vue
src/renderer/features/commandsBookmarksNotes/panels/{NotesPanel,StashSearchPanel}.vue
fixtures/commandsBookmarksNotes/{notes-sample.md,settings-junk.json,px.png}
tests/commands-bookmarks-notes{,-markdown,-images,-module}.test.ts
tests/component/commands-bookmarks-notes-{tool,panels}.test.ts
docs/features/commands-bookmarks-notes.md
```
