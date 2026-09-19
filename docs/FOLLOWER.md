# Follow & Loot — two-PC companion

Open **Dashboard → Open follower setup** or **Tools & QA → Follow & Loot**.

## Implemented in the first increment

- Persistent PC role, main-character name, LAN address/port, following distance,
  loot leash, loot toggle, score threshold, and confidence preferences.
- Authenticated main-PC listener and follower-PC connection with heartbeat,
  network round-trip measurement, disconnection detection, and reconnect.
- Deterministic planner for follow → loot → verify → follow; off-screen map
  routing; inventory-full behavior; target loss; stale frames; and stalled movement.
- Interactive synthetic route replay. It includes a wall detour and emits no input.
- Emergency stop and application shutdown close peer connections.

At that increment the feature did not recognize ground loot, register maps across
PCs, move a character, or pick up an item. Movement now exists (see "Following by
the overlay map"); loot, map registration between PCs, and area transitions still
do not. A connected peer is not evidence of working game perception. Network
latency is not capture-to-input latency. No API model is required at runtime.

## Live observation preview (second increment)

**Follow & Loot → Live observation preview** watches the follower PC's game view
for the selected character's nameplate. It is capture-only:

- `scripts/win-follower-host.ps1` contains no input, hook, or cursor API, and
  `FollowerPerceptionService` has no `GameInputController`, input sink, or peer
  transport. Screenshots and observations stay on this PC.
- It captures only while an allowlisted Path of Exile process owns the foreground
  window, and stops on emergency stop, app shutdown, and background smoke runs.

Calibrate: save the character to follow, put the leader on screen, **Capture game
view**, then click two opposite corners tightly around the name above their
character. Optionally select a search area that excludes the party panel if it
shows the same name. The main process builds a binary text template from its own
captured pixels (`min(R,G,B)` at an Otsu threshold clamped to 110–235); the
renderer supplies rectangles only. Calibration is saved to
`follower/calibration.json` under the app's user data and survives navigation and
restarts. It is invalidated when the game client size or the selected character
changes; recalibrate after changing resolution, window size, or UI scale.

Observation: each cycle captures either a ±160 px window around the last sighting
or, at least every 2 s and after a loss, the whole search area. Matches are scored
with the Dice coefficient over text pixels, so missing text and surplus bright
pixels both lower the score; 0.6 is the detection floor. Confidence is the score
scaled down when a second, non-overlapping candidate scores within 0.1 of the
best, reaching zero for identical nameplates. The screen shows identity and
method, position in client pixels, confidence against your configured minimum,
evidence (score, next-best score, matched/template pixels, candidates, search
mode), observation age, and capture/match/cycle timings.

Known limits, none yet measured on real gameplay:

- All automated tests use **synthetic** frames and a scripted capture host. No
  accuracy, false-acquisition rate, or frame rate has been measured in the game.
- A nameplate position is a screen position, not a map position. Nothing feeds
  `FollowerPlanner` yet.
- There is no gameplay-state detection: menus, loading screens, and cutscenes
  simply produce "not visible".
- Template matching assumes the name renders at a fixed pixel size. Bright or
  busy scenery behind the text, partial occlusion, and similar names lower or
  confuse scores. Borderless/windowed modes are required for screen capture.
- Full frames cross a PowerShell pipe as base64; expect well below the 30–60
  observations/second target during full searches until this is measured and,
  if needed, replaced.

## Following by the overlay map (third increment)

**Follow & Loot → Follow by overlay map** moves this PC's character toward the
leader. It was designed from live frames of the game at 2560 × 1440:

- With the **overlay map open** (Tab), the game draws the player's own marker as an
  orange X at the map centre (about 0.4998 × width, 0.4858 × height of the client)
  and each party member as a saturated-green X with a green name label above it.
  The vector between the two is the direction and distance to the leader, on
  screen or off. In one real frame only 321 of 3.7 million pixels were that green.
  In-world nameplates are not shown for party members, so the second increment's
  white-nameplate template does not see them; the map label does.
- `scripts/win-follower-host.ps1` gained a `key` op: one capture, then only the
  coordinates of pixels passing a colour-channel threshold cross the pipe
  (green = G − max(R,B), orange = min(R − G, G − B)). It remains capture-only.
- `src/core/followerMapMarker.ts` holds the pure logic. `findTemplateSparse` is the
  same Dice-scored template search as `findNameplate`, over sparse pixels.
  `buildMapCalibration` finds the label/marker pair automatically when exactly one
  party label is on the map (otherwise pass a rectangle around the label: the
  terminal runner takes `--label x,y,width,height`; the app has no selection UI
  yet, so calibrate while the leader is the only other member on the map), and requires
  the orange marker inside a small box at the overlay-map centre, so the corner
  minimap or orange scenery cannot calibrate. `MapMarkerTracker` searches a window
  around the last label and the whole view at least every second, and verifies on
  every capture that the orange marker is still where calibration put it: an open
  side panel shifts the map centre, and steering from a wrong centre would walk the
  wrong way. Our marker found somewhere else, or the leader's label jumping more
  than 30 px between captures, withdraws that trust at once; a marker that is
  merely hidden (effects, the leader standing on it) keeps it for 1.5 s (10 s when
  covered by the leader). A name that merely contains the leader's ("RangerTwo"
  for "Ranger") is rejected by checking for ink beside the match, and a rival seen
  by the once-a-second full search keeps confidence low during window searches
  too. Calibration cannot read names: it shows the captured label so the operator
  can check it. `FollowSteering` clicks only when the label confidence passes your
  minimum **and** the map centre is verified. It has stop/resume hysteresis, paces
  clicks, and aims at `centre + direction × clamp(distance × map scale, 0.06 h,
  0.26 h)`. When the label is not visible it sends nothing: the character finishes
  its last move and stands still. There is no blind pursuit.
- Input: `src/main/followerDriveService.ts` sends every click through
  `GameInputController` (kill switch, process allowlist, navigation module flag,
  confidence threshold, 600 actions/minute, dry-run, structured trace) into
  `FollowerInputSink`, then `scripts/win-follower-input-host.ps1`, a separate
  compiled worker that never captures. Natively, before each click, it re-checks:
  the capture the decision came from is at most 120 ms old (system-wide QPC time
  shared with the capture worker); the foreground window is an allowlisted Path of
  Exile process and the same window and client size that were captured; the target
  lies inside a central disc (0.30 × height) clear of the HUD; no modifier key or
  physical mouse button is held; mouse buttons are not swapped; and nobody moved
  the mouse since its last click. It then places the cursor, waits 12 ms (with a
  1 ms timer period), re-checks all of that plus that the window under the cursor
  is the game, and sends button down and up as one OS batch, so nothing can stay
  held. Holding a mouse button or moving the mouse takes control back, and it
  stays away until the cursor has rested for a second; Ctrl+Shift+Esc stops
  everything. A run started as a preview never sends input, even if a dry-run
  switch is turned off while it runs: it stops and must be started again.
- Preview is the default: `drive.json` starts with `dryRun: true`, and the app-wide
  Dry-run switch also forces preview. Traces are appended to
  `follower/follow-actions-YYYY-MM-DD.jsonl`.
- `npm run follower:live -- --target <Leader> [--seconds 20] [--calibrate] [--live]`
  runs the same service from a terminal so the game keeps focus. Without `--live`
  it sends nothing. With `--live` it refuses to start until the emergency-stop
  monitor is ready, and always ends after `--seconds`.

Requirements and limits:

- Mouse movement (`use_wasd_to_move=false`) with left-click bound to move; the
  overlay map open rather than the corner minimap; the leader in the same area.
- It cannot follow through doors, portals, waypoints, or area transitions, open the
  map itself, or avoid obstacles: it clicks toward the leader and relies on the
  game's own pathing. A click can land on an item label, NPC, or object and interact
  with it; if that opens a panel the map centre check pauses following.
- Map scale (screen pixels per map pixel) is an estimate from one frame (≈ 7).
- Status reports observations/second, cycle time, and native capture-to-click time
  at the 50th and 95th percentile, plus a worst-case reaction estimate (one full
  cycle plus capture-to-click). See "Measured results" below for what has actually
  been measured; anything not listed there has not been.

### Measured results

One PC (2560 × 1440 borderless, Windows 11), one short session on 2026-09-19,
follower character next to a stationary leader. Small samples; not a soak test.

| What | Result |
| --- | --- |
| Capture cost, 400 × 400 window / full view | 8–27 ms / ≈ 45 ms (GDI `CopyFromScreen`, incl. channel pass) |
| Native key-pixel scan, full 2560 × 1440 | 5.5 ms (synthetic bitmap) |
| Sparse label match on a real frame | ≈ 10 ms first call, 426 green pixels; score 1.0, no rival |
| Dry-run loop, overlay map open | 34 observations/s; cycle 19 / 28 ms (median / 95th) |
| Live walk-up: 89 → 9.4 map px | ≈ 2 s, 13 clicks, 1 refused at start-up, 0 manual takeovers; stopped inside the following distance and stayed there |
| Live capture-start → click-complete (13 clicks) | 47 / 64 ms (median / 95th), native QPC |
| Worst-case reaction estimate (95th) | 92 ms = one cycle (28) + capture→click (64) |
| Live idle, leader stationary, 45 s | 1,678 observations at 37/s, 0 clicks, 0 refusals |
| Live walk-up after the review fixes and 1 ms timer: 194 → 7.8 map px | 4.5 s, 29 clicks, 0 refused, 0 manual takeovers; 36 observations/s, cycle 17.6 / 26.9 ms |
| Capture-start → click-complete after the fixes (29 clicks) | 37 / 54 ms (median / 95th) |
| Worst-case reaction estimate after the fixes (95th) | 81 ms = one cycle (27) + capture→click (54) |

The one-batch down/up click (no hold) is accepted by the game as a move.

Not measured: reaction to a leader who *starts* moving while the loop is running
(in every live run the leader was already standing still when it started),
accuracy with several party members or look-alike names, behaviour in combat
effects, long sessions, and a second PC's hardware. Human visual reaction time is
commonly around 200–250 ms; the 81–92 ms figures are this loop's own worst case
for sending a click, not the character's movement speed.

## Recording and measuring on real gameplay

Synthetic tests cannot say how well perception works in the game. To measure it:

1. **Record.** On the follower PC, with both characters in the same area, press
   **Record 20 s for testing** and switch to the game. The capture-only host writes
   about four full-view PNG frames per second plus `manifest.json` to
   `follower/recordings/<timestamp>/` under the app's user data (the screen shows
   the path). Only moments when the game is focused are recorded; resizing the game
   ends the recording. Useful scenes: leader walking across the screen, leader
   behind scenery or effects, another player with a similar name nearby, leader
   leaving the screen, a menu or the map overlay open, a loading screen.
   Recordings are full screenshots: they show character names and chat. They stay
   on this PC and are not sent to the peer. Do not commit them without checking.
2. **Replay.** `npm run follower:replay -- "<recording directory>"` runs every frame
   through the same `LeaderTracker` as the live preview, using recorded offsets as
   the clock, and prints per-frame position, score, next-best score, confidence,
   and match time. It reads `calibration.json` from the app's follower directory
   unless `--calibration <file>` is given; `--gate 0.85` sets the confidence gate.
   Without labels this output is **not** an accuracy measurement.
3. **Label.** Add `labels.json` beside the manifest. Give the rectangle around the
   leader's name text, or `null` when the leader is not visible. Unlisted frames
   are ignored.

   ```json
   { "version": 1, "targetName": "ExactLeaderName", "frames": {
     "frame-0001.png": { "leader": { "x": 1210, "y": 540, "width": 96, "height": 14 } },
     "frame-0040.png": { "leader": null, "note": "loading screen" } } }
   ```
4. **Measure.** Replay again. It reports recall, recall at the gate, misses, and —
   most important before any input is connected — **accepted but wrong** sightings
   (false acquisitions or wrong locations whose confidence passed the gate). Figures
   describe that recording only; record several scenes before drawing conclusions.

A tracking window cannot see a look-alike elsewhere on screen; only the periodic
full search (every 2 s) can. Replay reproduces this, so look-alike errors can
persist for up to 2 s in the results just as they would live.

## Connect two PCs

1. Run this build on both PCs on the same local network.
2. On the main PC choose **Main PC**, enter its local IPv4 address (the app lists
   available addresses), choose a port, and generate a pairing key.
3. On the second PC choose **Second PC**, enter the main PC's address and the same
   port and key. Start the main listener, then connect the follower.
4. Both screens should report connected. The follower shows authenticated main
   character metadata and network round-trip time.
5. If Windows asks about network access, permit the companion on your private
   network only. This feature does not alter firewall rules or open router ports.

127.0.0.1 is for testing two instances on the same PC. It cannot connect two PCs.
The listener binds only to the selected local interface. Requests and responses
use HMAC-SHA256 with a random 256-bit shared key and a fresh request nonce. Keys
are never transmitted or persisted. Only connection metadata is exchanged; this
transport does not encrypt that metadata. No command or screenshot endpoint exists.
Start/stop is explicit; restart always begins disconnected. Saving preferences
closes the connection. Navigating away leaves an active connection running, but
clears the displayed key. Stopping/reconnecting after returning requires the key again.

## Planner contract

`FollowObservation` uses map-cell coordinates in an already aligned map, not
screen pixels. A live adapter must provide actual identity, map registration,
walkability, confidence, gameplay state, and pickup evidence before using it.
Unknown cells are blocked. Four-way BFS avoids diagonal corner cutting. These
cells are not automatically extracted from a screenshot in this increment.

Observations expire after 500 ms. Duplicate/out-of-order and future timestamps
are rejected. Timestamp comparisons use the receiver's monotonic clock domain;
a future live adapter must convert observation age without assuming synchronized
PC clocks. Peer RTT is measured separately with the local monotonic clock.

Pickup confirmation must be explicit: disappearing labels alone are not proof.
After two unconfirmed attempts, skip that item for the area. Leaving the screen
or exceeding the leash interrupts looting. Full inventory disables loot, not
following. Missing identities, different areas, unknown routes, or no movement
progress cause acquisition/pause decisions. There is no invented teleport or
blind recovery input.

## Next implementation milestones

1. Recorded-frame datasets for character/nameplate detection (occlusion, similar
   names, menus, loading screens, target disappearance). Measure correct identity,
   false acquisitions, and achieved observation rate; add gameplay-state detection.
2. Main-PC route observations and matching map landmarks on the follower PC.
   Extend the authenticated peer protocol with versioned, bounded observations,
   freshness checks, and map-registration evidence.
3. Connect verified decisions to `GameInputController`, preserving focus/process
   allowlisting, global dry-run, emergency cancellation, action limits, and traces.
4. Loot-label detection, inventory evidence, and verified pickup outcomes.
5. Door/zone transitions, bounded stuck recovery, soak tests, and intervention metrics.

Do not mark live following or unattended operation complete on the strength of
synthetic replay or a network heartbeat. Validate on recorded and real two-PC
sessions and record the limitations.

## Verification

Run `npm run typecheck`, `npm run lint`, and `npm run test:all`. Dedicated tests
cover navigation/loot replay, malformed observations, identity/freshness failures,
real socket pairing/reconnect, secret-free persistence, shutdown, and UI behavior.
`tests/follower-perception.test.ts` and `tests/follower-perception-service.test.ts`
cover template building, search, ambiguity, tracking, calibration invalidation,
focus loss, and the emergency latch on synthetic frames.
`tests/follower-fixture.test.ts` covers recorded-PNG decoding and the replay
metrics, again on synthetic recordings.
`powershell.exe -NoProfile -File scripts/test-follower-host.ps1` checks the native
host without capturing the desktop and asserts it references no input API.
Packaged Electron smoke tests exercise the screen and replay with game input and
network startup disabled.
