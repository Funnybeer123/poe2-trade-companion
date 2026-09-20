# Combat-while-following: plan and continuation prompt

The follower follows, loots, crosses areas and recovers from panels. It contributes nothing to a
fight. The user's words: **"It is too much dead weight just running around. It should also cast an
attack."** This document is the plan for that and the prompt for whoever builds it.

Branch: `feat/combat-while-following`, cut from `master` at `bdbb0a7`. All combat work happens here;
`master` stays the working follow bot the user levels with. Commit locally, push only when asked.

State at handoff: 169 test files, 2197 passed, 1 expected fail, 5 skipped; `npm run typecheck` and
`npm run lint` clean.

Read first, in this order: `AGENTS.md`; the "Shared" sections of `docs/FOLLOW_AND_COMBAT_HANDOFF.md`
(setup, the eight hard rules, how to work — all still in force, not repeated here);
`docs/COMBAT_ASSIST.md`; then this. The "Agent C brief" in that older handoff is **superseded** by
this document: two of its premises turned out to be wrong (below).

---

## What was learned that changes the old brief

1. **The follower PC has no combat calibration.** `%APPDATA%\poe2-trade-companion\` on the machine
   the follower runs on contains only `follower-cli\`. There is no `combat\combat-assist.json`. The
   old brief's "Unleash on `R` and Powered by Verisium on `T` are already configured" is true of the
   *other* PC. Packaged builds are blocked here by Windows Application Control (do not bypass it), so
   the calibration UI cannot simply be opened on this machine. **Anything that needs a calibrated
   skill icon, globe or HUD anchor cannot be step one.**
2. **Nothing needs to be added to the follower's tick.** The old brief framed the choice as
   (a) a second service plus an arbitration call inside the tick, or (b) a combat step inside the
   tick, and worried rightly about the 120 ms freshness budget. There is a third shape that costs the
   click path nothing: the follower already publishes everything an arbiter needs through
   `status()`, so a gate can *read* it from outside. See the design below.
3. **The tap primitive already exists and is already guarded.** `scripts/win-combat-host.ps1`
   serves `{ op: "tap", key, expectedHwnd }`: down and up in **one** `SendInput` batch (no held key
   if the worker dies), refused while a modifier or the binding itself is physically held, process
   allowlist, foreground-window match. Bindings are allowlisted in `COMBAT_BINDINGS`
   (`MOUSE5`, `0-9`, `A-Z`). `CombatInputSink` is the only path to it. It needs no calibration to
   tap. Hard rule 5 ("Escape is the only key the input worker will tap") is about the *follower
   input worker* and stays literally true: casting goes through the combat worker, whose whole job
   is tapping allowlisted bindings.

## Numbers measured on this build (live runs, this machine)

| What | Measured |
| --- | --- |
| Follower within 60 map px of the leader | 12–74 % of status samples, by run |
| Within 120 map px | 19–97 % |
| `Within following distance` (decision `near`: **no movement clicks are being sent**) | 29 % of a clean 300 s run |
| Movement clicks refused as stale | 10.9 % and 15.1 % over two full runs; freshness is 96 % of all failures |
| obs/s, cycle p95, capture→click p50/p95 | ~17, 55–59 ms, 51–60 / 120–125 ms |
| `Space held - manual control` on sprint start | 31 of 94 failures in one run (open item, below) |

The third row is the opening. While the decision is `near` the follower is standing still and
sending nothing: that is precisely the dead-weight time. Checked against the logs rather than
assumed: across 428 consecutive `near` half-second intervals in three runs, 6 movement clicks went
out, all from the decision flipping to `move` and back between two samples. So a cast gated on
`near` does not compete with movement clicks at the level of decisions. **The residual race is one
tick:** the gate reads status at ~10 Hz and the follower decides at ~30 Hz, so a cast can still land
within milliseconds of the first click of a walk. That is a key beside a mouse click, which no guard
objects to, but whether the game lets the cast finish is unmeasured — Phase 2 looks for it.

---

## The design

```
FollowerDriveService ──status()──▶ CombatGate (pure) ──open?──▶ FollowerCombatService
   (unchanged tick)                                                │ cadence due?
                                                                   ▼
                                              GameInputController (module "combat")
                                                                   ▼
                                              CombatInputSink ─▶ win-combat-host.ps1  { op: "tap" }
```

- **`src/core/combatGate.ts` — new, pure.** `(snapshot, config, now) → { open: boolean; reason }`.
  No I/O, fully unit-tested. Every refusal has a reason string, traced.
- **`src/main/followerCombatService.ts` — new.** Polls the follower's status at ~10 Hz, asks the
  gate, and when open and the cadence is due executes one key decision through its **own**
  `GameInputController` (same `KillSwitch` instance as the follower, so Ctrl+Shift+Esc stops both;
  its own actions-per-minute cap; dry-run; a trace per cast carrying the gate's evidence).
- **The sink guard** returns the window handle of the frame the follower last verified, so the
  combat worker's own foreground check binds a cast to the same window the follower is looking at.
- **Nothing is awaited inside the follower tick and no capture is added anywhere.** Phase 1 needs
  no combat capture at all: the evidence for "in the world, beside the leader, not in a panel" is
  the follower's own (leader trusted, map centre verified), which is stronger than a HUD anchor.

Gate v1 — all must hold, each refusal traced with its reason:

| Condition | Why |
| --- | --- |
| follower running, kill switch not latched | obvious |
| not in manual control (hold **or** the 1.5 s reactive pause) | the human always wins |
| decision is `near` | standing still: a cast cannot fight a movement click or interrupt a walk |
| leader trusted **and** map centre verified on the latest observation, observation fresh | no panel, no modal, same area; never cast blind |
| not sprinting, not walking to loot, no teleport-confirm window open | each is the follower mid-action |
| cadence due (`everyMs`), casts-per-minute under cap | pacing |

The status type does not expose all of that today (`manual`, the loot-collect window, the confirm
window and the frame's `hwnd` are private to the tick). **Expose them as one explicit snapshot field
on `FollowerDriveStatus`** — do not parse `reason` strings. That is a shared-type change
(`src/shared/follower.ts`) plus a few assignments in `followerDriveService.ts` where those values
already exist; it adds no work to the click path.

Config, saved beside the follower's settings (`drive.json` directory), **off by default**:
`{ enabled: false, dryRun: true, key: "R", everyMs: 1500, maxPerMinute: 30 }`, key validated against
`COMBAT_BINDINGS`. CLI: `--combat --cast-key R --cast-every 1500` (live only with `--live`, as now).

## Phases — each ends with the named measurement, not with "it compiles"

**Phase 0 — prerequisites, no behaviour change.**
Write `docs/COMBAT_WHILE_FOLLOWING.md` (the design record, kept current like `FOLLOWER.md`). Expose
the status snapshot. Extend the synthetic rig so a test can assert the snapshot through a teleport,
a loot walk, a manual pause and a hold. *Measure:* full suite green; follower obs/s and refusal rate
on a live run unchanged from the table above (the lead runs it, user present).

**Phase 1 — gate + cast on cadence while `near`, dry-run only.**
`combatGate.ts`, `followerCombatService.ts`, CLI flags, a `cast=<n>/<gate reason>` field on the
status line. Tests mirror the follower's: a synthetic rig with injected hosts, and a static assertion
that the combat path can only ever send `op: "tap"` with an allowlisted binding. *Measure, live in
dry-run:* how many casts *would* have been sent per minute, and the distribution of gate-closed
reasons. If the gate is open under 10 % of the time the window is too narrow — widen on evidence
(next phase), do not guess.

**Phase 2 — live casting, measured against itself.**
Same run conditions with `--combat` on and off. *Accept only if:* obs/s stays above 15; the stale
refusal rate does not rise; time-within-120-px does not fall (casting roots the character for the
cast time — if the follower starts falling behind, that shows here); zero casts traced outside an
open gate. *Then* consider widening the window from `near` to "moving but within N map px" — that
is where a cast can land between two movement clicks ~110 ms apart, so it needs its own measurement
of whether a cast cancels the walk or the walk cancels the cast. Unknown today; find out live.

**Phase 3 — know there is something to fight.**
v1 casts whether or not anything is there. Make that cost visible first: trace every cast, then
measure candidates **offline on recorded fight frames before building any** (the item-label detector
that measured 1 correct in 7 and was reverted is the precedent):
- *Leader stationary while we are near, outside town* — free, from data already in hand.
- *Enemy life bars* — flat red horizontal runs; the native `runs` scan already finds flat-colour runs
  for loot labels, so this may be a filter, not a detector. Measure precision and recall on frames.
- Damage numbers and spell effects are noisy; the leader "casting" is not observable. Skip unless
  the first two fail.
The lead captures the fight frames with the user present; analysis scripts live in
`C:\Users\evanb\code\follower-live\` and run the real detectors over PNGs.

**Phase 4 — flasks and mana, only if wanted.** Needs HUD calibration on this PC, which needs a
calibration path that does not depend on the packaged app (a CLI capture-and-pick, as the follower's
`--calibrate` does). Until then the follower cannot drink. Note `--distance 2` parks it ~12 map px
from a leader who is in melee; a caster follower wants a larger `--distance` (up to 10 ≈ 60 px). Say
this to the user rather than discovering it as a death.

**Phase 5 — aim.** Casts go toward the cursor, which rests where the last movement click landed —
roughly toward the leader, which is roughly toward the fight. Good enough to start. Aiming at a
target needs a *cursor move without a click*: a new input capability with its own human-wins
checks. **Do not build it without the user's explicit go-ahead.**

**Phase 6 — UI.** A "Fight while following" switch and the cast key beside the dashboard's new
Follow button (`src/renderer/composables/useFollowControls.ts`, `DashboardView.vue`). Last, because
the CLI is how this is actually run on this machine.

## Must respect

- Every cast goes through `GameInputController`. Tap only, never a hold. No new key reaches the
  *follower* input worker.
- A cast is decided from evidence no older than the follower's own freshness budget; a stale
  snapshot closes the gate.
- The human always wins: hold, reactive pause, kill switch and process allowlist apply unchanged.
- Off by default, dry-runnable, traced before trusted.
- Do not weaken a guard to make a cast land. If the combat worker refuses (`Modifier or action
  binding held`, focus lost), that is a refusal, not a retry loop — and "a refusal is not an action":
  do not charge it against the cadence as if it had been cast.
- Subagents never run a live host, capture the screen or send input. Only the lead, user present.

---

## Open follower items inherited from the last session

These are on `master` and will be hit while testing combat. Do not fix them on this branch unless
they block it; do know them.

1. **Map centre lost ⇒ no teleport for 30 s.** In every long leader-absence of one run the
   follower's own marker was verified **0 %** of the time, and travel-to-leader is gated on
   `originVerified`, so it could not even try. The stretches were 30 s, 30 s, 30 s — exactly
   `PANEL_ESCAPE_RESET_MS`. Likely the overlay map closed on an area change; Escape cannot reopen it
   and the follower has no Tab. **Unconfirmed: the user was asked to press Tab and had not yet
   reported back.** A fix means a second allowlisted tap on the follower worker (rule 5): the
   user's call.
2. **`Space held - manual control`** — 31 of 94 failures in one run: a sprint *start* finding Space
   already down while the worker believes it holds nothing, charged as a manual takeover (1.5 s
   pause). Looks like the worker's `spaceHeld` and the key state disagreeing after the dead-man's
   switch fires. Unreproduced.
3. **Stale refusals (10–15 %)** — Agent F's latency-injection harness is committed unfinished
   (`7ccefd6`): it reproduces refusals offline; the `MEASURE:` tests only log. Note
   `captureToInputMsP95` read **125 ms** in one run, above the 120 ms guard, so the service's figure
   and the native `ageMs` do not span the same interval — size any fix against the guard's number.
4. **Terrain fix is proven half-way.** Walls per scan fell 27,761–43,139 → 3,265–6,887 live, so the
   cap no longer binds. That it *routes round walls better* is not shown: only 4 samples had the
   follower far enough to want a plan. Watch `plan=` on a run with real chasing.
5. **Loot backoff fix is unproven live.** With a full bag, `Loot clicks are not picking anything
   up` should now appear within a few attempts. It had never once appeared before.
6. **Blocked-vs-behind.** Distance to the leader cannot separate them (stalls while clicking: 25.4 s
   jammed on a door, 32.4 s in a clean run). `moved=<px/s>/<tracked>` was added to find out whether
   own displacement can; a clean sample of "clicking, leader visible, `moved≈0`" has not been
   caught yet. Nothing decides on it.
7. **Dashboard Follow button** is covered by component tests but has never been seen in the app on
   this machine.

## Running it, and the thing that wasted the most time last session

```powershell
npm.cmd run follower:live -- --target HarrisonBot --seconds 7200 --live --loot --leash 25 --sprint --wait 900 --dir C:\Users\evanb\code\follower-live\cli
```

`Ctrl+Shift+Esc` stops everything. `Ctrl+Shift+H` holds the PC for the human; `Ctrl+Shift+M` or
`Ctrl+Shift+F` resumes. Touching the mouse pauses for 1.5 s.

**The user cannot see the status line when the lead runs this as a background task, and most
"it's stuck" reports last session were the follower parked in manual control** — not walls, not
doors, not green terrain. It began as a one-key toggle and every press was a coin flip; M now only
ever resumes, because that is what it was pressed for four times running. So: **when the user says
it is stuck, read the last status line before forming any theory**, and prefer running the follower
in a terminal tab the user can watch.

## Lessons from the last session, each of which cost something

- **A censored sample looks like a healthy one.** Wall counts "fit" under the 50,000 cap because
  everything over it was thrown away; the tell was a maximum of 49,805. Likewise the capture→click
  p95 sitting exactly on the 120 ms guard. When a distribution presses against a limit, the limit is
  in the data.
- **Scope traces to the run.** The JSONL is per *day*, not per run, and twice an analysis crossed a
  run boundary and blamed the wrong run (once by `tail -400`, once by a ten-minute bucket). Filter
  by the run's own timestamps, then count.
- **Measure the proposed trigger before building it.** "Clicking but not closing the distance" was
  the obvious stuck-detector and would have fired more in a healthy run than a jammed one.
- **A feature that exists is not a feature that works.** The full-bag backoff was written, tested
  and named — and had never fired, because its pickup test (label *count* dropping) is something a
  moving follower causes constantly. Three tests encoded the bug; one was named after it.
- **Design for the operator you have.** An invisible toggle, correct to the last event, was
  reported broken four times. The binding now follows the habit, not the mnemonic.
- **An existing test is a reviewer.** The dashboard button shipped enabled with no input path until
  the no-desktop-bridge test failed.
