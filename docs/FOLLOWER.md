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

The feature does **not** recognize ground loot, register maps across PCs, move a
character, or pick up an item. The app says this explicitly. A connected peer is
not evidence of working game perception. Network latency is not capture-to-input
latency. No API model is required at runtime.

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
`powershell.exe -NoProfile -File scripts/test-follower-host.ps1` checks the native
host without capturing the desktop and asserts it references no input API.
Packaged Electron smoke tests exercise the screen and replay with game input and
network startup disabled.
