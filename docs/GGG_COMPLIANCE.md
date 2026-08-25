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

## Public distribution
Do not package or describe the QA automation build as a normal player utility. If a public companion build is produced, automation-only modules must be disabled or excluded from that artifact.
