# Implementation State

**Updated:** 2026-08-27  
**Implementer:** Grok 4.6 xhigh Fast  
**Plan:** `plans/IMPLEMENTATION_PLAN.md` (Sol Max, 2026-08-27)

## Commits

| Ref | SHA | Notes |
| --- | --- | --- |
| Audited base (`main`) | `3bf2f91398a16a5250d351be818a41ca39e32762` | Docs-only repo; no toolchain |
| Phase 14 | `cursor/phase-14-operator-ui-b5b3` (PR #15) | Operator / debug / replay UI |
| Phase 15 | `cursor/phase-15-packaging-hardening-e10f` | Packaging / hardening / docs |

## Active phase

Phase 15 — Packaging / performance / hardening / documentation. Last planned phase.

## Completed phases

- Phase 01–14 as previously recorded.
- Phase 15 — Packaging / performance / hardening / documentation:
  - `electron-builder.public.yml` / `electron-builder.qa.yml` (QA `productName`: PoE2 QA Automation (Authorized)).
  - `scripts/verify-public-build-excludes-native.mjs` (directory pack or `--files-from` list).
  - `pack:public` / `pack:qa` produce directory packs only; they do not invent a Windows installer on Linux.
  - Compile-time `POE2TC_MODE` / `import.meta.env.POE2TC_MODE` gates `authorized-qa`. Public artifacts cannot enable QA via `POE2TC_RUNTIME_MODE`.
  - First-run wizard: mode select; QA requires typing `AUTHORIZED QA` + checkbox.
  - Redacting logger; crash-safe JSONL traces (`open`/`append`/`fsync`); emergency-stop registration is re-ensured on activate and not cleared by other shortcut changes.
  - `OfficialItemFilterSync` left blocked (`BLOCKED: oauth-registration`); local export unchanged.
  - Docs pointer, README commands, CPU/latency notes, ABI re-verify notes.

## Build / test status

Host Node: `v22.14.0`. `.nvmrc` pins `22`. No Node-version deviation.

Phase 15 gate on this host:

- `npm run lint` green (after env.d.ts / logger typing fixes)
- `npm run typecheck` green
- `npm test` 380 passed
- `npm run test:replay` 38 passed
- `npm run test:smoke` 7 passed
- `npm run pack:public` and `npm run pack:qa` produced Linux directory packs (`electron-builder --dir`). No NSIS/Windows installer.
- `node scripts/verify-public-build-excludes-native.mjs --files-from fixtures/packaging/public-file-list.txt` OK
- Public asar contains `poe2tcMode: public-companion` and no `packages/native-input`. QA asar contains `packages/native-input` and `poe2tcMode: authorized-qa`.

## Blockers

- **BLOCKED: windows-vm** — no Windows runner in this environment. Directory packs may be produced on Linux. NSIS/clean-VM install, live emergency-stop, and Electron ABI rebuild for `better-sqlite3`/`koffi` are not claimed green.
- **BLOCKED: oauth-registration** — GGG is not accepting new OAuth apps; no test client. Local filter export only.
- **BLOCKED: poe-client-access** / **windows-native** — no live PoE 2 client. Replay/full-loop remains the merge gate.

## Plan deviations

Phase 01–14 deviations unchanged.

Phase 15:

- `electron-builder` `--dir` only on Linux. `win.target` is empty so a Linux host cannot emit a fake `.exe`.
- Public overlay still contains the Automation dashboard Vue view; it cannot arm without the compile-time QA flag. The verify script rejects `packages/native-input` and native input libraries, not the disabled dashboard markup.
- `OfficialItemFilterSync` is a blocked stub (no network). Documented instead of implementing OAuth.
- CI stays on `ubuntu-latest` plus a public file-list verify. A `windows-latest` pack job is not added because it cannot be validated here.

## Replay fixtures added

None new. Existing replay suite is the Phase 15 replay gate.

## Next exact work item

None in the Sol Max plan. Remaining work is external unblock: Windows VM pack/ABI, OAuth registration or test client, live PoE 2 client.
