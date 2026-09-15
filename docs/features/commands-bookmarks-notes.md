# Commands & notes

Written as the USER_GUIDE section for this feature: paste it under the
"Tools & QA" chapter as `## Commands & notes` and keep the headings below.

**Tools → Commands & notes** keeps four small lists. Every entry can be bound
to a global hotkey, and every hotkey press does exactly one thing:

| List | One key press does |
|---|---|
| Commands | types **one** chat line (Enter, the text, Enter) |
| Stash searches | fills the game's stash search box **once** |
| Bookmarks | opens a page in your browser, or in one always-on-top window |
| Notes | shows a cheat sheet in the overlay |

**What it never does.** It never repeats a line, never chains two gestures,
never retries a blocked attempt, never clicks anything in the game, and never
touches the network. Chat lines go through the same audited path as every
other in-game keystroke in this app: the emergency stop (`Ctrl+Shift+Esc`)
blocks them, the global **Dry-run** switch turns them into previews, Path of
Exile must be the foreground window, and every attempt — sent, previewed or
blocked — is written to the QA action trace. Those gates apply in every build
mode; there is no public-only lock.

### Commands

A command is a name plus one chat line. The line may contain placeholders,
which are filled in from your Client.txt and from the price feed's resolved
league:

| Placeholder | Where the value comes from |
|---|---|
| `{player}` | the last incoming whisper's sender |
| `{latestWhisper}` | that whisper's text |
| `{char}` | your character name (last level-up line) |
| `{area}` | the area you are in |
| `{item}` `{price}` `{tab}` `{left}` `{top}` `{league}` | the last incoming **trade** whisper |

The editor shows a live **Would send:** line with the values as they are right
now, so `/invite {player}` reads `/invite Bob` before you ever bind a key.

Two things stop a line from being sent, and both are visible in the editor
before they can bite:

- **an unresolved placeholder** — no whisper has arrived yet, so `{player}`
  has no value. The line is refused rather than sent with a hole in it.
- **a character the input host cannot type** — anything outside printable
  ASCII (`é`, `→`, CJK). The line is refused rather than typed approximately,
  because a whisper that lost its `@` would become public chat.

A line that starts with neither `/` nor `@` goes to whatever chat channel the
game currently has selected — usually local chat. The editor says so.

Starter examples (`/hideout`, `/invite {player}`, `/tradewith {player}`,
`/kick {player}`, `@{player} thanks, enjoy!`) are shown on a fresh install and
are only written to disk once you press **Save** — the first save keeps the
examples of the other tab too, so saving the searches does not throw the
example commands away. Until that save they have no hotkey action yet, so the
rows say "Save to bind" instead of offering a key.

### Stash searches

A name plus the text to type. It is typed into the search box exactly as
written, so the game's regex forms work: `"^Waystone"`, `"tier: 1[5-6]"`,
`rarity: unique`. A search containing a character the host cannot type is kept
but switched off, with the reason shown.

`Alt+F` opens the **Stash search** overlay panel: a focused field plus your
saved searches as chips. Press Enter (or click a chip) and the panel hands
keyboard focus back to the game, the app brings Path of Exile to the front,
verifies it, and fills the box once. If the game was not there, you get
"Blocked: not-foreground" and nothing is typed or retried.

### Bookmarks

A name plus an `http`/`https` address. Anything else — `javascript:`,
`file:`, `data:`, an address carrying a user name and password — is refused
when you save it and again when it is opened.

Two modes:

- **External browser** (default) — your normal browser, outside the game.
- **Overlay window (always on top)** — one plain browser window that floats
  above the game. It is sandboxed, has its own cookie jar (it never sees the
  app's trade session), refuses pop-ups (they go to your browser) and cannot
  ask for your camera, microphone or location. It **does** take keyboard focus,
  and an exclusive-fullscreen client will cover it: use it only if you play
  borderless windowed.

### Notes & images

A title, an icon, a markdown body and one optional image (PNG/JPEG/WebP/GIF,
at most 2 MB). `Alt+N` shows the last note in the overlay without stealing
focus from the game; a per-note hotkey opens that note directly, and pressing
it again while another note is shown switches to it. `Escape` closes the
panel.

The markdown subset is small on purpose: `#`/`##`/`###` headings, paragraphs,
`-`/`*` bullets, `1.` numbered lists, ``` fences, `>` quotes, `---` rules,
`**bold**`, `*em*`, `` `code` `` and `[text](https://…)` links. Tables,
images-by-URL and raw HTML are not rendered — HTML in a note is shown as
text, never executed, and a link only opens after the address has been
validated again. Images live beside your settings as ordinary files; deleting
the note deletes the file, and an image can only be attached to a note that
has been saved (the file is named after the note). A file you dropped into
that folder yourself is never touched.

### Hotkeys

Bind a key inline on each row, or in **Tools → Hotkeys**, where the actions
appear in the groups **Overlay** (Notes `Alt+N`, Stash search `Alt+F`),
**Commands**, **Stash searches**, **Bookmarks** and **Notes**. Per-item keys
have no default: nothing is bound until you choose a key. Switching an item
off removes its hotkey and keeps the row.

### Troubleshooting

| Symptom | What to try |
|---|---|
| "Blocked: another input host" | A sorting run, the numpad daemon or the flask guard owns the input host. Stop it and press again. |
| "Blocked: empty — unresolved placeholder(s): {player}" | No whisper has arrived yet. Wait for one, or use a line without placeholders. |
| "the input host cannot type …" | The line has a non-ASCII character. Rewrite it in plain ASCII. |
| "Blocked: not-foreground" | Click the game first (hotkeys pressed while playing already satisfy this). |
| Hotkey row shows **Not active** | Another application holds that combination. Pick a different one. |
| Nothing is typed at all | The **Dry-run** switch is on (the buttons say "Preview"), or chat commands are switched off in Settings. |
| The bookmark window is invisible | Path of Exile is in exclusive fullscreen. Switch the bookmark to "External browser". |
| The chip says **Window hidden** | Pressing that bookmark's key again hid the window; the page is still loaded. "Close window" stops it for good. |
| The bookmark window came up blank | The page cancelled its own load (a redirect). Press the bookmark again — the address is loaded from scratch. |

### Where data lives

| What | Where |
|---|---|
| Commands and stash searches | `%APPDATA%\poe2-trade-companion\companion-settings.json` → `namespaces.commands` |
| Bookmarks and the window size | same file → `namespaces.bookmarks` |
| Notes (text + image record) | same file → `namespaces.notes` |
| Note images | `%APPDATA%\poe2-trade-companion\notes-images\` |
| Hotkey bindings | `%APPDATA%\poe2-trade-companion\overlay-hotkeys.json` |
| Every chat/search attempt | `%APPDATA%\poe2-trade-companion\assistive-artifacts\qa-action-trace.jsonl` |

Nothing here is written under `artifacts\`, and no account credential is ever
stored or sent.
