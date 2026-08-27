# How to use PoE2 Trade Companion

Windows-first Electron app for Path of Exile 2 item intelligence. The default app includes parsing, stash queries, builds, and stash automation. Prices shown today come from bundled fixture quotes, not live listings. Emergency stop is **Ctrl+Shift+Esc**.

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

`npm run pack` builds the same companion with transfers enabled.

## Copy an item from Path of Exile 2

1. Focus the game and hover the item.
2. Copy it with the usual PoE shortcut (`Ctrl+C`). The text must start with `Item Class:`.
3. In the companion, either:
   - press **Ctrl+D** (global hotkey while the Electron app is running), or
   - open **Items** and click **Read clipboard**, or
   - paste the text and click **Evaluate text** / **Ctrl+Enter**.

The bottom-left rail shows **Client detected** or **Client not detected**. Transfers only click when that window is Path of Exile.

## Status chips

| Chip | Meaning |
| --- | --- |
| **Automation on** | Transfers, sort, and scans can send input to Path of Exile. |
| **Preview · no input** | Browser-only Vite page, not the Electron app. Intelligence still works on pasted text. |
| **E-stop ready · Ctrl+Shift+Esc** | Generated input can be killed instantly. |
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
- **Stash scanner** is collapsed at the top of the detail pane. Pick a grid (normal stash 12×12, quad 24×24, inventory 12×5) and start. Check **Dry run** if you only want a journal. **Ctrl+Shift+Esc** latches the kill switch.

## Tools & QA

Open **Tools & QA** in the left rail.

### Deal analysis

Public, no input. Evaluate an item first, then enter the seller asking price and optional fee/slippage. You get estimated margin, return, confidence, and stale-data warnings. It never whispers, buys, or lists.

### Loot filter

Generates local filter text from a hide-below threshold and unique highlight option. Copy it yourself into your filter file. The app does not write game files or talk to an account API.

### Settings

- Default QA scenarios to dry-run (stored locally).
- Runtime: mode, e-stop, detected PoE windows.
- Reminder: **Ctrl+D** price-check, **Ctrl+Shift+Esc** e-stop, **Ctrl+Alt+V** voice transfer.

### Calibration, Transfers, Sort stash, dashboard, Replay

Calibrate the stash, bag, and search box before live transfers. Sort and replay stay in this Tools section.

## Move bag items into stash

1. Calibrate once under **Tools & QA → Calibration**: bag grid, stash grid, and stash search box.
2. In Path of Exile, open stash and inventory yourself. The app does not click the hideout chest.
3. Open **Tools & QA → Transfers**.
4. Click **Empty** for bag → stash. **Fill** is stash → bag.
5. Leave **Dry-run / preview** unchecked for live clicks. Check it if you only want a plan.

Voice fill uses **Ctrl+Alt+V** by default. **Ctrl+Shift+Esc** stops all generated input.

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
- Send input from a browser preview.
- Click windows that are not on the Path of Exile process allowlist.

## If something looks wrong

| Symptom | What to try |
| --- | --- |
| Window never opens | Confirm `npm run dev` printed `Local: http://localhost:5173/` and no port conflict. |
| Native module / sqlite error | `npm run rebuild:native:host`, then restart. Electron and host Node use different ABIs. |
| Item will not parse | Clipboard must include `Item Class:`. Re-copy from the game tooltip. |
| Finder is empty | Evaluate or select a catalog item first. |
| Prices look fake or stale | They are fixture data. Confirm on official trade. |
| Transfer buttons disabled | Calibrate stash + bag + search, unlock the e-stop, and keep Path of Exile in the allowlist. |
| Input will not stop | **Ctrl+Shift+Esc**, then confirm the chip says **Emergency stop latched**. |

## Related docs

- `README.md` — project overview
- `docs/GGG_COMPLIANCE.md` — public vs QA boundary
- `docs/QA_AUTOMATION_BOUNDARY.md` — interlocks
- `docs/PRODUCT_SPEC.md` — acceptance criteria
- `docs/ITEM_INTELLIGENCE_PROVENANCE.md` — parser/source reuse
