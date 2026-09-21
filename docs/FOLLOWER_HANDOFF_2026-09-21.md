# Follower continuation prompt — 21 Sep 2026

You are picking up a Path of Exile 2 **follower bot**: a second PC's character (`JasonWIlsonBot`) follows the user's
main (`HarrisonBot`) using screen capture only and guarded synthetic input. The user levels with it live, watches it
closely, and reports problems in a sentence. Branch `master` is the working bot; `feat/combat-while-following` holds a
separate combat plan and is one merge behind.

**Read first:** `AGENTS.md`; the "Shared" sections of `docs/FOLLOW_AND_COMBAT_HANDOFF.md` (setup, the eight hard rules,
how to work — all in force); `docs/FOLLOWER.md`; then this. `docs/FOLLOWER_SPEED_PLAN.md` is an 829-line, evidence-labelled
redesign plan produced by a 23-agent workflow today — read §1 (diagnosis), §6 (user decisions), §7 (what not to do), §10.

State: 170 test files, 2229 passed, 1 expected fail, 5 skipped; typecheck and lint clean; native synthetic checks pass.

---

## The one problem that matters most: the planner cannot tell floor from void

The user's standard, in their words: *"It should not be guessing around, it should read the map walls and draw a path
to my char… dynamic enough for any map… super fast around corners, rooms and edges."* They drew the correct route by hand
twice on the Kingsmarch dock: `C:\Users\evanb\code\follower-live\ground-truth-2-highzoom.webp`, and the polyline in
`…\workflows\scripts\inside-outside-routing-*.js` (frame pixels for `dz-1.png`/`dz-2.png`):
`(1261,723)→(1357,698)→(1459,755)→(1472,717)→(1344,602)→(1267,525)→(1216,493)→(1152,512)→(1050,563)→(973,525)→(954,506)→(889,462)`.

What is true, measured on recorded frames:

- The game draws a thin **lavender outline** at the edge of walkable ground (red≈green, blue 10–30 % above). That is the
  wall. Non-walkable landscape is a translucent grey/white fill. **Walkable ground and water/unexplored void both have no
  fill.** The bright-blue arc is the edge of the explored map, not a wall.
- `TerrainPlanner` knows wall / not-wall only, so void is as walkable as deck. **The outline does not seal it off:** the
  region reachable from the follower without crossing a wall is **92–97 % of the view** at every colour threshold and
  every gap-closing radius up to 24 px. NPC map labels, icons, the follower's own marker sprite and the explored-map
  frontier all open the line. The planner also clears a 3×3 hole at its own feet and at the leader.
- Result on the dock: a route across the water between pier and town instead of along the gangway. A cave frame
  (`stuck-cave-1.png`) routes correctly round a pillar.

**In flight when this was written:** workflow `wf_59317d5a-d6c` — four competing offline prototypes (sealed-flood,
parity/winding, which-side-is-floor evidence, fill-as-obstacle), each attacked by an adversary, judged on rendered
images against the ground truth. Their scratch output is in `C:\Users\evanb\code\follower-live\agents\{sealed-flood,
parity,side-evidence,fill-obstacles}\`; the journal is under
`~\.claude\projects\C--Users-evanb-code-poe2-trade-companion\ec27a7db-…\subagents\workflows\wf_59317d5a-d6c\`.
**If no result reached you, look at those images yourself before anything else.** Whatever model wins: render its route
on `dz-1.png` beside the user's red line and show the user **before** it drives their character.

`npx tsx C:\Users\evanb\code\follower-live\route-shot.ts <out.png>` captures the screen (no input), calibrates on that
frame, runs the real tracker and planner, and paints walls / route / next aim / both markers. The user asked for exactly
this ("show me where it is trying to run"). Use it, and send them the picture.

## What changed today (all on `master`)

| Commit | What | Live evidence |
| --- | --- | --- |
| `cbc442e` | Travel to the leader even when the map centre cannot be verified (after Escape's two turns, or 15 s), on the evidence of the travel button being found | not yet seen live |
| `0ec718e`, `18c73e5` | `--flask 1 [--flask-below 55]`: life flask from a calibration-free globe column; an empty column is "unreadable", not 0 % | reads 97 % live; **a genuine press has never been observed**; suspected of raising stale refusals 11.6 → 22–31 % (short runs, unproven) — it is OFF in the current run |
| `d44e7fa` | No Escape into the loading screen after our own teleport | median first click after a teleport was 3.2 s without an Escape, 14.0 s with one (19 of 31) |
| `bbb9272` | New native channel `walls` (outline only); `wallBetween`/`reachesLeader`; a route with both outranks the trail; calibration and matcher work at any Map Zoom; `findTemplateSparse` 224 → 22 ms, identical results | d 1129 → 19 map px at high zoom |
| `0678dc0` | Walls **closed** (grow 1, shrink 1) instead of fattened; sprint held through stale refusals and 400 ms of unsure frames; NPC nameplate lettering refused by colour; `openShare` — a route >25 % across blank expanse loses its priority | 22 obs/s, 2 of 314 clicks refused, 5 sprint starts in 49 s (was one per 0.8 s), d 864 → 77 |

## Things I got wrong today — so you do not repeat them

- **Declared a route correct from its length.** "REACHES THE LEADER, 1,576 px" went straight across the harbour. Look at
  the picture. Always.
- **"The orange marker problem"** — a cause invented from a correlation. Fourteen frames captured at the failing moments
  showed a vendor window, a checkpoint panel, an NPC dialog and a death screen. The detector was right every time.
- **Crossed run boundaries in trace analysis twice** (the JSONL is per day). Filter by the run's own timestamps.
- **Let a failed flask calibration kill the whole run.** Optional features must fail soft.
- **Shipped a blind toggle** for manual control; the user cannot see the status line. M now only ever resumes.

## Open items, most valuable first

1. **Inside/outside routing** (above).
2. **The follower cannot resurrect itself.** It sits on the death screen and presses Escape at it every 30 s (opening the
   game menu). Needs a new native click area for "Resurrect at checkpoint" — **the user's decision**, asked, not yet answered.
3. **NPC map labels / portal icons covering the follower's own marker** freeze it (origin unverified ⇒ pause). 17–22 % of
   cave time was unverified. A rule I designed but did not build: treat the centre as covered-not-gone when the leader is
   tracked confidently, the own marker is found nowhere (score 0), and outline cells exist within ~72 px of the anchor in
   a fresh terrain scan. Mind panels: a vendor window over the centre must still read as "gone".
4. **Map Zoom.** At a high zoom odometry dies (the `blue` plane finds 0–8 points, `MIN_POINTS` is 60), so no trail, no
   bump memory, no `moved=`; a match costs ~20 ms more per tick; nothing in the distance constants scales. The user has
   moved the zoom three times today. Recalibrate (`--calibrate`) after every change. See plan §1 cause 0a, decision D0.
5. **Orphaned Space** between killed runs (plan §1 0b): 108 "Space held" refusals in 4 streaks, each after a run killed
   within 1 s of a sprint start. Unreproduced; a start-up `spaceDown` probe would settle it.
6. **The plan's D-S note on my sprint edit:** it says the native release still fires on two thirds of stale refusals.
   Live showed 1 sprint start in 30 s afterwards, so it helps; read that section before building on it.
7. Agent F's latency-injection harness (`7ccefd6`) is still unfinished; the plan's Phase 1 refits it.

## Running it

```powershell
npm.cmd run follower:live -- --target HarrisonBot --seconds 7200 --live --loot --leash 25 --sprint --wait 900 --dir C:\Users\evanb\code\follower-live\cli
```

Add `--calibrate` after any Map Zoom change (leader on the map, overlay map open, nothing over the centre). Status line:
`plan=<px>/<walls>w/<bumps>b[!]` then `=ROUTE` (trusted route to the leader), `=VOIDnn%` (route not believed), `=wall`
(wall between, no route to the leader). `Ctrl+Shift+M`/`F` resume, `Ctrl+Shift+H` hold, `Ctrl+Shift+Esc` stop.

**When the user says "it's stuck", read the last status line and the hold/resume counts before forming any theory.**
Never run the full test suite or heavy analysis during a live run you intend to measure. Commit locally; push when asked.
