# GGG Public Guidance and QA Authorization Boundary

This document separates ordinary public third-party use from the authorized QA automation target of this repository.

## Published public guidance
GGG's public third-party guidance restricts automated gameplay and multi-action macros for ordinary player use. The official developer reference also currently marks Account Stashes, Guild Stashes, and Public Stashes as PoE 1 only.

Official references:
- https://www.pathofexile.com/developer/docs
- https://www.pathofexile.com/developer/docs/reference

## Public Companion Mode
`public-companion` must follow current published rules and must not:
- automate movement/pathing/following;
- automatically pick up items;
- automatically click/move stash or inventory items;
- automatically complete trade sequences;
- trigger game input from background perception/events;
- perform multiple game interactions from a single normal-player macro invocation;
- reverse engineer undocumented endpoints.

## Authorized QA Automation Mode
`authorized-qa` intentionally exercises automation behavior that falls outside the published rules for normal players. It exists only for GGG-authorized testing.

Required QA automation includes:
- target following/navigation;
- auto-loot;
- stash/inventory sorting and transfers;
- automated listing/repricing workflows;
- automated trade-session scenarios;
- perception-driven input;
- multi-step end-to-end bot scenarios.

Do not remove these capabilities from the implementation plan on the basis of public-player guidance. Instead isolate them behind explicit QA gates and separate builds/runtime capabilities.

## API limitations still matter
QA authorization does not mean undocumented APIs automatically exist. Cursor must verify what the current official API actually provides.

If PoE 2 stash APIs remain unavailable, stash management should use observable UI state, clipboard data, screenshots/OCR/computer vision, or an explicit GGG-provided test interface if one is supplied later.

Do not invent an API.

## Required boundaries
- Separate `public-companion` and `authorized-qa` capabilities.
- Keep all generated game input behind one auditable controller.
- Add a persistent QA-mode banner.
- Add a global kill switch.
- Add dry-run/simulation support.
- Add target process/window allowlisting.
- Add action-rate limits.
- Add per-module feature flags.
- Add structured QA traces.

## Chat commands, stash search and the overlay (2026-09-11)

The ported overlay features send at most **one chat line per user gesture**
(`src/main/chatCommandService.ts`): a hotkey or a button press produces
Enter, the typed text, Enter — never a chain of commands, never a click on a
trade or vendor accept button. The stash-highlight path is one search-box
fill (Ctrl+F, text, Enter) per gesture. Every line honours the kill switch
before each key, the process allowlist, the foreground check, the global
Dry-run switch (nothing reaches the host), a 30-per-minute / 400 ms limiter,
and refuses while any other input host runs. Every attempt is appended to
the action trace. Trade offers, whispers and market listings are read from
the game's own Client.txt and the official trade API; nothing is sent
without the user's gesture.

### One chat line per click (2026-09-14)

The ported features that can reach the game all share that one path; none of
them opens an input host of its own.

- **Market**: one whisper (or one `/hideout`) per click, through the same
  chat-command path; secure listings are never whispered or bought; live-search
  results never trigger input.
- **Trade**: every button types exactly one line (`/invite`, `/tradewith`,
  `/hideout`, `/kick`, a quick whisper) or fills the stash search box once. The
  app never accepts, confirms or completes a trade — the trade window's Accept
  is always the player's. Webhooks are outbound-only, to endpoints the user
  created, ≤ 10/min per target, never retried, redirects refused.
- **Commands & notes** adds no new input path: one key press types one chat line
  or fills the stash search box once, through the chat command service, with no
  repeat and no retry. The same gates apply in every build mode.
- **Evaluate** sends exactly one `Ctrl+C` per hotkey press, through the audited
  chat-commands capture (allowlist, foreground, kill switch, one trace line).
  Dry-run sends nothing and reads the clipboard instead; price lookups still
  run. Repeat presses inside 500 ms are one gesture, and re-pressing on the same
  item inside the 60 s search cache re-shows the panel instead of spending a
  second lookup.
- **Inspect** sends no input and makes no request: it analyses the text the
  game's own `Ctrl+C` put on the clipboard. With `inspect.copyOnHotkey` enabled
  (off by default) it asks the chat-command service for exactly one `Ctrl+C`,
  through the same kill-switch, foreground, dry-run and rate-limit gates as
  every other line.
- **Stash tracker price overlay**
  (`src/main/features/stashTracker/hostProbe.ts`): one passive `{ op: "rect" }`
  window query per user gesture — no key, no click, no focus change. Refused
  while the emergency stop is latched, skipped while another input host is
  alive, and traced in `qa-action-trace.jsonl` as `stash-tracker-rect-probe`.
  Timers never probe; they re-draw from the last measured rectangle.

### Read-only features

Home / session, the Campaign guide, Pricing history and Settings send **no game
input at all** and make no trade2 request of their own, so the emergency stop
and the dry-run switch have nothing to stop in them.

- **Home / session** reads `Client.txt` and local files only. No game input, no
  network requests, no account data. Market movers come from the trends cache
  without fetching; death screenshots stay on this PC and are never uploaded.
- **Campaign guide** reads two `Client.txt` line shapes and the bundled route
  file. Its overlay panel is display-only and pinned; it never takes keyboard
  focus or captures the mouse from the game.
- **Pricing history** reads the paced poe2scout trends cache (one page per
  category, ≥ 5 min between refreshes, shared with Tools → Market) and writes
  only its own files under userData. It never spends the trade2 budget, so it
  can never trigger a rate-limit lockout.
- **Settings** sends no game input and makes no trade2 request of its own; its
  *Check leagues* / *Refresh prices* buttons call the existing throttled price
  feed.

### Administrator rights and elevated relaunch

Pressing *Check administrator rights* in **Settings → Game client** runs one
fixed PowerShell script that enumerates `PathOfExile*` processes and attempts a
single handle open per process to see whether the handle is denied. It reads no
process memory, writes nothing, and injects nothing. It runs **only** on that
button press — never on page load, never on a timer — and the `app:elevation`
channel is refused outright in the `public-companion` build. The verdict is a
heuristic ("likely" / "no" / "unknown"), the checklist step it feeds is
optional, and nothing is ever blocked by it.

*Relaunch as administrator* raises Windows' own UAC prompt: it is never silent,
it is refused in the `public-companion` build and when the app is already
elevated, and it sits behind a disclosure plus a confirming second click. The
point of the feature is UIPI, not a bypass — Windows silently drops keyboard,
mouse and global-hotkey input sent from a lower-privilege process to an elevated
window, so an elevated game and a normal companion fail with unexplained focus
errors. An elevated companion drives an elevated game through exactly the same
audited chain, with the same kill switch, allowlist, foreground check, dry-run
switch, rate limiter and action trace.

### Verification status

Everything in this section is implemented and unit-tested offline. As of
2026-09-14 **none of the ported features has been exercised against the live
game**; `docs/HANDOFF-overlay-port.md` holds the open live checks.

## Auto-flask and auto-cast (action daemon, 2026-09-14)

`npm run actions:daemon` (and the standalone `npm run flask:guard`) is the
one place in this repository where game input is **perception-driven and
timer-paced** rather than one line per user gesture: the guard watches the
life and mana globes and presses a flask key when a globe drops, and watches
calibrated skill-bar icons and presses that skill's key whenever the icon
reads ready (off cooldown). That is gameplay automation of the kind the
public guidance forbids, so it belongs to the `authorized-qa` scope only: the
daemon is a CLI, not an app feature, and the `public-companion` build ships
neither the daemon nor the input host — the app merely edits the guard's
config file and click-calibrates points. Rails: presses happen only while
Path of Exile 2 is the foreground window; one key per decision through
SendInput; per-probe cooldowns, a stale slowdown for flasks and edge-triggered
casting with a retry gap for skills (never a burst); **Numpad −** pauses;
`--flask-dry-run` logs without pressing; every press is written to
`artifacts/action-daemon.log`, and flask presses also save a screenshot of
what the guard saw.

## Public distribution
Do not package or describe the QA automation build as a normal player utility. If a public companion build is produced, automation-only modules must be disabled or excluded from that artifact.
