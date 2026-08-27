# ADR 0001 — Parsing, APIs, capture

## Status
Accepted for Phase 0.

## Exiled Exchange 2
Verified intent: reuse MIT parsing if the current upstream license remains MIT. This first implementation ships a local clipboard parser with the same `NormalizedItem` contract so we are not blocked on vendoring. Revisit EE2 import when packaging a release.

## PoE 2 stash API
Official developer docs still mark Account/Guild/Public Stashes as PoE 1 only. This project will not invent a PoE 2 stash REST API. Stash/inventory QA uses clipboard + recorded perception frames.

## Capture library
Live capture is behind `src/adapters/capture.ts`. Replay uses `RecordedFrameSource`. Native screen capture can be swapped in later without changing controllers.
