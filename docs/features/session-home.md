# Home, session, mapping and death screenshots (`session`)

Home is the first screen: who is playing, what this session did, what the stash
and the market look like, and what is still worth setting up.

Everything on it is derived from Path of Exile 2's own `Client.txt` and from
files other parts of this app already wrote. **The package sends no game input
and makes no network request.** The refresh links point at the paced tools that
do (Sort for the price feed, Tools → Market for trends).

- Channels: `session:*` (13) · Events: `session:changed`, `session:recap`, `session:death`
- Settings namespace: `session` · Overlay panel: `session-recap` · Hotkey group: `Session`
- Route: `/home` (the app's landing route)

---

## Character & campaign

The character comes from the game's own lines, in this order of trust:

1. a `… (<class>) is now level N` line seen while the app is running;
2. the same line found in the last 2 MB the client-log foundation backfills at
   start-up (so starting the app mid-session still shows the character);
3. the manual override in Tools → Settings → Session & recap;
4. a `<name> has been slain.` line — a name only, no class or level.

A real level-up always beats the override. Campaign progress tracks the furthest
area by act, part and area level, with towns ordered after the act's areas; the
campaign is marked complete the first time a map run starts or the endgame town
is entered.

The card shows the level difference against the current area as a tone ("On
pace", "N levels under the area — consider side areas", "Over-levelled by N —
move on"). It never prints a percentage and never says XP: experience maths
belongs to the campaign guide, and the numbers a percentage would need are not
in the log.

**Not available:** experience per hour, time to next level, experience and gold
per map. Those need an account link this app does not have, so they render as
`Needs account link (not available)` and are never estimated.

## Session & maps

A session starts with the first log line (or the first time Path of Exile is
seen running) and ends when

- the process is gone for four consecutive polls (about a minute) **and** the
  log has been silent for two minutes (`game-exit`) — and only if the process
  probe saw Path of Exile at least once during this session, because a probe
  that fails (a blocked execution policy, a busy `powershell.exe`) looks exactly
  like a closed game and must never archive a session the player is still in,
- the log has been silent for the configured idle window while the process is
  gone (`idle`),
- the app quits (`app-quit`),
- or you press "End session & start fresh" (`manual`).

Area lines are the only source of map runs — PoE2 has no "you have entered"
line. The rules:

| Situation | What happens |
|---|---|
| A map area at level 65+ that is not a claimable hideout | starts a run; tier = area level − 64, with 81/82 (irradiated, corrupted) shown as T16 |
| A Sanctum area | starts a `trial` run |
| A Breach / Delirium / Expedition / Ritual / Incursion / Abyss area | starts a `league` run, unless it was entered from inside a map — then it counts as part of that map |
| Hideout or town | suspends the run; time there is not counted as active |
| The same area id **and seed** again | resumes the same run and counts a portal |
| A different map, a campaign area, or thirty minutes without coming back | finalizes the run |

"Completion" is by hideout return: a map you left on purpose counts as complete;
one the session ended inside counts as abandoned. The card says so — there is no
in-game completion signal to read.

Maps per hour excludes AFK time and stays blank until ten active minutes have
passed, because a rate from three minutes is noise. Average and median map times
use active time only.

## AFK and post-game recap

`/afk` opens the `session-recap` overlay panel, centred, without keyboard focus,
with three pages (Session · Maps · Stash) you switch by clicking. `/afk off`
hides it again when "Close it again when AFK ends" is on. Closing the panel
yourself keeps it closed until the next AFK.

The post-game recap is a card on Home rather than an overlay panel: the overlay
hides itself once Path of Exile is gone. A Windows notification carries counts
only (maps, rate, deaths, duration) — never item or chat text.

Trade activity in the recap is read from the trade package's
`trade-history.json` when it exists (sales, purchases and their exalted totals);
without it the recap shows the `Trade accepted` / `Trade cancelled` and whisper
counts from the log.

The trade card always names the period it covers: "Since 21:00" while a session
is running, "All recorded trades" when none is — that file keeps two weeks, and
an unlabelled card would silently pass a fortnight of sales off as one evening.
Stash gains in divine are labelled "at an assumed 405 ex/div" whenever neither
the tracker summary nor any snapshot carried a real rate.

## Death screenshots (replay-lite)

A moment after each `has been slain.` line the app captures one frame of the
game window and writes it, plus a thumbnail, under
`%APPDATA%\poe2-trade-companion\deaths\`. The capture hotkey does the same on
demand.

- **Window only by default.** The whole-screen fallback is an expert switch
  (off): a screen grab can include Discord, a browser and other people's chat.
- **Exclusive fullscreen captures black.** The app detects that, retries once and
  then skips the shot with an explanation. Set the game to borderless windowed.
- Screenshots stay on this PC. They are never uploaded, never attached to a
  webhook and never included in a notification. They can show chat and player
  names — the Deaths tab says so.
- The newest `maxDeathScreenshots` (default 60) are kept; older files and their
  index rows are removed automatically. Deleting one by hand is a two-click
  action.

This is not a replay recorder: there is no video and no pre-death buffer.
`desktopCapturer` hands out one-shot frames, so nothing before the death line
can be recovered.

## What is set up

The setup checklist belongs to the app-settings package; Home calls
`app:setup-checklist` and renders the list with links. When that package is not
present, Home falls back to the one fact it has itself — whether `Client.txt` is
being read.

Recommended actions are Home's own: at most five rows, blocking ones first
(no Client.txt, an ambiguous pricing league, an empty or stale price feed, no
stash session, a stale trends cache, repeated deaths), each linking to the tool
that fixes it.

---

## Settings (`session`)

```json
{
  "afkRecap": true,
  "afkRecapAutoClose": true,
  "postGameRecap": true,
  "postGameNotification": true,
  "deathScreenshots": true,
  "allowScreenFallback": false,
  "maxDeathScreenshots": 60,
  "idleEndMinutes": 30
}
```

`characterOverride` (`{ name, className?, level? }`) is absent by default. Every
value is clamped by `normalizeSessionSettings` and changes apply live.

## Where data lives

| File | What | Retention |
|---|---|---|
| `%APPDATA%\poe2-trade-companion\session-current.json` | the session in progress | rewritten at most once a minute; removed when the session ends |
| `%APPDATA%\poe2-trade-companion\session-history.jsonl` | one line per finished session | newest 200, each line ≤ 256 KB of UTF-8 (areas dropped first, then the oldest runs) |
| `%APPDATA%\poe2-trade-companion\deaths\` | JPEG + thumbnail per capture, plus `deaths.jsonl` | `maxDeathScreenshots` |
| `%APPDATA%\poe2-trade-companion\stash-tracker\summary.json`, `…\snapshots.jsonl` | the stash tracker's files | **read-only** — written by the stash tracker |
| `%APPDATA%\poe2-trade-companion\trade-history.json` | the trade package's history | **read-only** |

Home reads the stash files from whichever of the tracker's known locations
exists and tolerates their absence; it never writes, renames or deletes them. A
tracker summary counts as gains only when it carries a session baseline — the
tracker rewrites the file on every launch, so its zero-gain field alone would
otherwise read as "nothing moved" instead of "no session started".

Only the newest 25 finished sessions stay parsed in memory; the History detail
card reads an older one back off disk when you open it.

## Safety

- **Game input:** none. This package imports no host, no input sink and no chat
  service, so the emergency stop and the dry-run switch have nothing to stop
  here (they still govern every package that does send input).
- **Network:** none. Market movers come from the trends cache
  (`getTrends({ cachedOnly: true })`, which never fetches); the price feed is
  read through its status only. trade2 and poe2scout are never called and the
  request budget is never spent.
- **Secrets:** only the "a session cookie is set" boolean is ever read; the
  cookie value never enters a payload, a file or a notification.
- **Resources:** the process probe is memoized by the scaffold and backs off to
  one poll a minute while nothing is happening; `session:changed` is coalesced to
  at most two a second; the stash files are re-parsed only when their size or
  mtime moved.
- **Never automated:** nothing in the game is opened, entered, sold or clicked.
  Deleting history or a screenshot is always a two-click user action; the only
  automatic deletion is the screenshot cap, which is documented above.

## Deliberately not done

- An account link (OAuth) and everything derived from account experience or gold.
- Replay video and in-game playback — screenshots only.
- League auto-select from the character, and localized area names (unverified
  catalogue names are shown with "(name unverified)").
- Charts: Home uses tables and meters. A maps-per-hour sparkline on the History
  tab would need the pure chart helpers other wave-2 packages own; it is left
  for a later pass.
