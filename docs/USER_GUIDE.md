# How to use PoE2 Trade Companion

Windows-first Electron app for Path of Exile 2 item intelligence. Two modes:

- **Public Companion** (default): parse items, value them locally, build stash queries, track builds, write rules, review scans. Never generates game input.
- **Authorized QA**: same intelligence plus gated automation for explicit GGG-authorized testing only.

This is not a live-trade bot for public play. Prices shown today come from bundled fixture quotes, not live listings.

## Install and launch

Requirements: Windows 10/11, [Node.js 20+](https://nodejs.org/) (see `.nvmrc`).

```powershell
git clone https://github.com/Funnybeer123/poe2-trade-companion.git
cd poe2-trade-companion
npm install
npm run dev
```

`npm run dev` starts Vite and opens the Electron window titled **Item Intelligence · PoE2 Intelligence**.

If `better-sqlite3` fails after a Node or Electron version change:

```powershell
npm run rebuild:native:host
```

Then restart `npm run dev`.

Optional public Windows package:

```powershell
npm run pack
```

That artifact is still public-companion. QA packaging is a separate command (`npm run pack:qa`) and still requires local opt-in before any live input.

## Copy an item from Path of Exile 2

1. Focus the game and hover the item.
2. Copy it with the usual PoE shortcut (`Ctrl+C`). The text must start with `Item Class:`.
3. In the companion, either:
   - press **Ctrl+D** (global hotkey while the Electron app is running), or
   - open **Items** and click **Read clipboard**, or
   - paste the text and click **Evaluate text** / **Ctrl+Enter**.

The bottom-left rail shows **Client detected** or **Client not detected**. Detection is informational in public mode. Input stays locked unless you start an authorized QA build.

## Status chips

| Chip | Meaning |
| --- | --- |
| **Public mode · input locked** | Normal companion. No clicks, keys, or movement are sent to the game. |
| **Preview · no input** | Browser-only Vite page, not the Electron app. Intelligence still works on pasted text. |
| **E-stop ready · Ctrl+Shift+Esc** | Authorized QA is armed and can be killed instantly. |
| **Emergency stop latched** | Generated input is frozen until you click **Re-arm input**. |

## Items

Workspace for parse, value, and keep a local catalog.

1. Paste or read clipboard item text.
2. Review identity (class, rarity, base, iLvl, quality, corrupted, identified).
3. Read **Estimated value**: low / fair / high, suggested listing estimate, confidence, and comparable count.
4. Read **Recommendation**: keep / sell-style category, score, and reasons. Active build profiles can boost exact or near matches.
5. The item is stored in the left **Catalog**. Search by name, class, location, recommendation, or modifier text.
6. Click a catalog row to reopen it. Click **×** then **✓** to delete.

Treat every number as an estimate. The bundled market provider is deterministic demo/test data. Confirm current listings in-game or on official trade before you buy or sell.

## Finder

Turns the current item into stash-search strings that PoE can accept.

1. Evaluate an item on **Items** first.
2. Open **Finder**.
3. Choose identity fields (name, base, class) and which affixes to include.
4. For numeric affixes, switch **Match** to **Numeric range** and set min/max.
5. Optionally add custom lines (one alternative per line).
6. Set **Maximum stash query length** (stash search is short; default is conservative).
7. Click **Generate validated queries**.
8. Copy a query into the in-game stash search box.

Over-length selections are split into labeled queries. Nothing is silently truncated. You can also save a generated expression into a rule set from this page.

## Builds

Local gear-target profiles. This is not a full character planner and it does not scrape third-party build sites.

1. Click **+ Create profile**, name it, set league/tags if you want, then **Save profile**.
2. Or paste official trade2 search URLs / exported query JSON into **Trade targets** and import. Opaque search IDs are stored as provenance only; the app never fetches them.
3. Add **Gear targets** (slot + item class) and optional **stat rules** (`exists`, `eq`, `gte`, `lte`, `between`, `contains`).
4. Set exact-match and near-match desirability boosts.
5. Click **Make active**. Evaluated items then get a build-aware score bump when they fit.
6. Use **Target coverage** to see how much of the local catalog already fills those slots (exact / near / missing).

Source URLs are reference-only and are never requested.

## Rules

OR-of-AND matchers used by Finder and QA scans.

- Space-separated quoted terms are AND.
- `|` separates OR alternatives.
- Example: `"maximum life" "fire resistance"| "cold resistance"`.
- Use **+ AND** / **+ OR** helpers, then **Save**.
- Invalid regex or over-broad patterns fail validation and cannot be saved.
- Mark a set **Active** so scanners and Finder quick-save use it.
- **Import** accepts legacy scan-history or regex-history JSON.

## Scans

Offline review of imported or QA-generated sessions.

- Import JSONL for review. That creates records only and sends no input.
- Open a session to inspect slot status (matched / missed / timeout) and any parsed item payload.
- **Authorized QA scanner** is collapsed at the top of the detail pane. In public mode it stays locked. In QA mode you pick a grid (normal stash 12×12, quad 24×24, inventory 12×5), keep **Dry run** on unless you intend live input, acknowledge QA, then start. **Stop** cancels the run. **Ctrl+Shift+Esc** latches the kill switch.

## Tools & QA

Open **Tools & QA** in the left rail.

### Deal analysis

Public, no input. Evaluate an item first, then enter the seller asking price and optional fee/slippage. You get estimated margin, return, confidence, and stale-data warnings. It never whispers, buys, or lists.

### Loot filter

Generates local filter text from a hide-below threshold and unique highlight option. Copy it yourself into your filter file. The app does not write game files or talk to an account API.

### Settings

- Default QA scenarios to dry-run (stored locally).
- Runtime: mode, e-stop, detected PoE windows.
- Reminder: **Ctrl+D** price-check, **Ctrl+Shift+Esc** e-stop, **Ctrl+Alt+V** voice transfer (QA only).

### Calibration, Transfers, Sort stash, QA dashboard, Replay

These are authorized-QA operational tools. In public mode they explain why they are locked. They do not silently fall back to live input.

## Authorized QA only

Do not start this mode on a normal player account. It exists for environments GGG has explicitly authorized.

```powershell
$env:POE2_BUILD_MODE = "authorized-qa"
$env:POE2_QA_OPT_IN = "1"
npm run dev
```

You should see a persistent **Authorized QA mode** banner.

Before live input can arm:

1. QA build mode is `authorized-qa`.
2. `POE2_QA_OPT_IN=1` was set at startup.
3. You check the on-screen **authorized QA acknowledgement**.
4. A process allowlist matches the live client (`PathOfExile.exe`, Steam variants, etc.).
5. The PoE window is the configured target.
6. Emergency stop is registered (**Ctrl+Shift+Esc**).
7. Leave **Dry run** on until you intentionally disable it.

Live tools:

- **Scans → Authorized QA scanner**: hover/copy cells on a chosen grid.
- **Tools → Calibration**: capture the PoE window and draw stash, bag, and search boxes. Transfers need stash-search calibration.
- **Tools → Transfers**: audited stash ↔ bag movement, optional class filter, voice trigger (**Ctrl+Alt+V**).
- **Tools → Sort stash**: preview a pack plan, then execute only when gated.
- **Tools → Replay & traces**: fixture replay with a fake input sink. Use this to inspect decisions without touching the live client.

Action traces append under the Electron user-data folder (`assistive-artifacts/qa-action-trace.jsonl`).

## Where data lives

Local-first. Typical Windows path:

`%APPDATA%\poe2-trade-companion\`

| File | Contents |
| --- | --- |
| `item-intelligence.sqlite` | Catalog, builds, rules, scan sessions |
| `scan-sessions.jsonl` | Scanner journal |
| `assistive-artifacts/` | QA traces and capture artifacts |

No account telemetry is sent by default. Do not commit this folder, cookies, or session files.

## What this build will not do

- Call undocumented GGG Trade2 APIs or scrape Mobalytics.
- Treat fixture quotes as live guaranteed sale prices.
- Arm automation from public-companion or from a browser preview.
- Silently switch from QA to public and keep sending input.

## If something looks wrong

| Symptom | What to try |
| --- | --- |
| Window never opens | Confirm `npm run dev` printed `Local: http://localhost:5173/` and no port conflict. |
| Native module / sqlite error | `npm run rebuild:native:host`, then restart. Electron and host Node use different ABIs. |
| Item will not parse | Clipboard must include `Item Class:`. Re-copy from the game tooltip. |
| Finder is empty | Evaluate or select a catalog item first. |
| Prices look fake or stale | They are fixture data. Confirm on official trade. |
| QA buttons disabled | You need `POE2_BUILD_MODE=authorized-qa`, `POE2_QA_OPT_IN=1`, acknowledgement, allowlist, and an unlocked e-stop. |
| Input will not stop | **Ctrl+Shift+Esc**, then confirm the chip says **Emergency stop latched**. |

## Related docs

- `README.md` — project overview
- `docs/GGG_COMPLIANCE.md` — public vs QA boundary
- `docs/QA_AUTOMATION_BOUNDARY.md` — interlocks
- `docs/PRODUCT_SPEC.md` — acceptance criteria
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — parser/source reuse
