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

This increment does **not** capture live character positions, recognize ground
loot, register maps across PCs, move a character, or pick up an item. The app says
this explicitly. A connected peer is not evidence of working game perception.
Network latency is not capture-to-input latency. No API model is required at runtime.

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

1. Follower-side game capture and calibration, plus recorded-frame datasets for
   character/nameplate detection. Measure correct identity and false acquisitions.
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
Packaged Electron smoke tests exercise the screen and replay with game input and
network startup disabled.
