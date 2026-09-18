# Handoff prompt: Fragment-tab tablet review and extraction

Build this feature in my PoE2 Trade Companion app. Complete the implementation, testing, and local setup; do not stop at a plan.

## Repository and starting point

Use `C:\Users\evanb\OneDrive\Documents\Codex\poe2-trade-companion`, not the similarly named directory under Documents\ChatGPT. Fetch current `origin/master`, inspect local changes, and preserve other contributors' work. Follow AGENTS.md and the architecture documents. Create a new feature branch from current master. Do not assume an old Stream Deck build is current or cherry-pick the previously excluded `d98d879`.

## Intended behavior

Review every tablet in my Fragment stash tab, identify the top rolls, retain good tablets there, and move tablets with bad rolls into my inventory. Moving rejects into the bag is the final action: do not vendor, destroy, drop, craft, use, or price them.

First establish what **top roll** means for each tablet type. Ask me for desired modifiers, minimum values or percentiles, and whether useful combinations count. Distinguish modifier tier, numeric roll within a tier, and combinations. Do not equate highest tier with a maximum numeric roll or invent universal thresholds. Show representative copied item text and proposed keep/reject decisions for my review before enabling extraction. Verify any required current game modifier ranges using authoritative data and record its version/source. Unknown types, unparsed modifiers, missing ranges, or ambiguous values must remain in the stash as needs-review.

## Guided calibration — I can demonstrate

I have offered to show you the click locations. Coordinate a short walkthrough using available screen/computer-use tools and the app's existing calibration support. Observe me opening the Fragment tab, selecting tablet categories or sub-tabs, exposing tooltips, and moving one example tablet into the bag. Do not treat this prompt as evidence of any actual coordinates or of an already completed demonstration.

Record positions relative to the PoE client, its resolution, display and scaling. Capture anchors for the Fragment tab, category selectors, each relevant tablet area and the inventory. Confirm whether slots contain individual tablets or stacks and whether Ctrl-click moves one or multiple items. Check how repeated items in a slot are exposed. Do not assume this specialized tab is a normal rectangular stash grid. Stop and recalibrate when the client geometry or layout changes. Tell me when you are ready to watch; do not send input to another game or application.

## Implementation

Audit and reuse existing scanner, clipboard item parsing, calibration, stash transfer, GameInputController, workflow exclusion, emergency-stop and action-log services. Useful entry points include `src/main/scanRuntimeService.ts`, `src/main/scanRunService.ts`, `src/main/bagTriageService.ts`, `src/main/assistiveRunService.ts`, and the native worker scripts. Preserve ring quality policy and existing workflows.

Separate observation and classification from extraction. Provide:

1. A no-input fixture/replay preview and an explicitly labeled live read/scan mode. Existing global dry-run emits no game input and cannot hover/copy real items; do not present it as a completed real scan.
2. Configurable, saved rules per tablet type. Display item identity, observed modifier values, relevant ranges, keep/reject/review decision and a concrete reason.
3. A bounded extraction operation for confirmed rejects, using the same reviewed rule set and fresh item observations. Check bag capacity before moving anything. Re-read or otherwise verify the item immediately before moving it, then verify source and destination afterward. Re-scan when removing an item changes visible content. Handle stacks explicitly. Never retry an ambiguous transfer blindly.
4. Real progress and a completion summary: examined, kept, moved, needs-review, failed, and remaining. Cancellation, full inventory, clipboard failure, focus loss and emergency stop must leave an accurate resumable report. Resuming requires fresh observations and an explicit user action; never replay transfers automatically.
5. A desktop tool and native Stream Deck actions to open the tool, scan/review, and extract rejects. Keep scanning distinct from moving. Reuse `src/shared/deckActions.ts`, `src/main/deckRuntime.ts`, `src/main/deckServer.ts`, and `stream-deck/`; add original icons and mapping documentation. Fit all actions without overwriting navigation or emergency-stop keys.

Use explicit typed parameters and acknowledgements. Distinguish received, running, completed, dry-run-only and failed states. Show useful failure reasons in the desktop UI and Stream Deck Property Inspector; a transient green checkmark alone is insufficient. Preserve allowlisting, calibration, workflow exclusion, cancellation, emergency stop, explicit rearm and structured traces. Do not add a separate public/QA opt-in restriction.

## Tests and delivery

Use copied-text fixtures and replay for every discovered tablet type, minimum/maximum values, threshold boundaries, useful combinations, unknown modifiers, malformed clipboard data, duplicate fingerprints, stacks, shifting slots, full inventory, failed/ambiguous transfers and interrupted runs. Test no-input dry-run, calibration mismatch, non-PoE foreground, exclusion with other workflows, duplicate presses, emergency stop, disconnects and no automatic replay. Run repository-required checks and focused packaged-app and plugin checks. Report real hardware validation separately from simulation. Do not execute bulk extraction until I have reviewed the rules and explicitly chosen live extraction.

Deliver working code, updated local app/plugin packages, configuration and calibration instructions, rule examples, test results, limitations and concise commits. Preserve existing Stream Deck profiles and unrelated keys. Do not push the new feature to master unless I authorize that separately.

## Current Stream Deck handoff context

The integration has 75 actions and a three-page XL profile. Actual key presses have reached the app. A yellow alert was correctly caused by a latched emergency stop; after Rearm, Bag Scan completed a dry-run with no game input. The app was intentionally left in dry-run; inspect current state rather than assuming it remains so.

Profile generation was corrected to use Previous/Next page navigation, reserve the entire bottom row, include the first page in the page list, and assert that every action survives layout. The latest profile import was canceled by the user, so the locally selected profile may still need replacement/verification. Stream Deck has run elevated and blocked automated clicks/restart; do not claim physical validation based solely on SDK simulation.

Earlier checks: 1,803 repository tests and four focused packaged checks passed; the broader packaged smoke suite had six unresolved failures. See `docs/STREAM_DECK_TESTS.md`. Artifacts are generated locally and are not tracked in Git. Regenerate packages using the documented build commands. Do not claim all checks pass until current results support that statement.
