# Price helper

Open **Tools & QA → Price helper**. This is an independent implementation of the useful read-only features in [PoeAncientsPriceHelper v3.8.0](https://github.com/pedro-quiterio/PoeAncientsPriceHelper/releases/tag/v3.8.0).

1. Choose your league. The list includes Forbidden Rites, HC Forbidden Rites, Runes of Aldur and its Hardcore variant. You can also enter another league name supported by poe.ninja.
2. Click **Refresh prices**. Currency, Runes, Expedition, Verisium and Uncut Gems each show their own item count, timestamp and errors. Automatic refresh every 30 minutes is optional and off initially.
3. Open a currency/reward list in the game. Click **Calibrate list region** and drag around the item names and quantities. Leave at least one overlay-width of room on either side. Esc cancels; selection times out after a minute. Prices and rumours have separate saved regions.
4. Click **Start scanning**, then return to PoE2. The overlay is click-through and does not activate itself. It pauses on focus loss, refuses unverifiable targets, and requires recalibration if the client size changes.
5. Use **Stop / hide**, **Ctrl+Shift+F5**, or the app's emergency stop. Closing and reopening the app never starts capture automatically.

You can also paste a list into **Check an item list** without capturing the screen. Supported examples:

```text
2x Divine Orb
Exalted Orb (10)
Uncut Skill Gem (Level 19)
```

Prices are shown in divines for totals of at least one divine, otherwise exalteds when that conversion is available. Totals retain full feed precision until display. The primary currency from poe.ninja is respected, including Hardcore leagues whose primary unit differs. A missing rate is never invented. Unknown names, ambiguous quantities, duplicate matches and unreadable gem types/levels display `?`; unavailable market values display `No market data`. These are market estimates, not guaranteed sale prices. Exact matching trades some OCR recall for fewer misleading prices.

Select **Island Rumours**, then **Refresh rumour sheet**, to load the [community spreadsheet](https://docs.google.com/spreadsheets/d/16YU8mSS7TdLPdmOunVjiPn_NrKVGfcnMkuMQDy8jgZA/edit). Each matched name shows a map, modifiers and community rating. A truncated name is accepted only with an explicit ellipsis and a unique match. Cached rumour data is marked old after 24 hours. No sheet credentials are requested. Ratings are community opinions, not guarantees.

**Ctrl+Shift+F4** recalibrates; **Ctrl+Shift+F3** toggles recognized text. The modified shortcuts avoid taking the game's bare function keys. Conflicting hotkeys are reported in the tool. Esc or Ctrl+click held when a scan checks dismisses and stops the helper; use its dedicated stop shortcut for immediate cancellation. **Ctrl+Shift+Esc** also stops the helper through the existing emergency-stop path. Optional minimize-to-tray leaves scanning enabled only while the game remains foreground; the tray menu can open the app, stop the helper or quit.

Five overlay accent themes are available: Toxic, Midnight, Obsidian, Abyss and Ember.

## Security and privacy decisions

- No upstream installer, DLL, executable, auto-updater or source file was incorporated. The examined release tree did not include a project license, so this implementation is independent. Upstream third-party dependency licenses do not grant permission to copy the project's own code.
- The new native helper only supports `status`, `calibrate`, and `read`. It has no keyboard/mouse input synthesis, memory-injection, network, screenshot-file or clipboard functions. It uses local Windows OCR and bounded GDI capture, up to 2000 × 2000 pixels, every 750 ms after the previous read completes.
- Native script paths are resolved from the application package/check-out, never from the launch directory. Script names are allowlisted, preventing a same-named script in an unrelated working directory from being executed.
- Capture requires the exact known executable names and the **Path of Exile 2** window title, a visible non-minimized client, and foreground ownership by that process. Missing identity/focus fails closed. Focus is checked immediately before and after capture and after OCR. Normal OS scheduling leaves a small race between checking focus and capturing; results are discarded on a detected change.
- Only the calibrated game-relative region is captured. Images stay in process memory, are disposed after recognition, and are neither uploaded nor written to disk. The new helper sends only a league/category request to poe.ninja; rumour downloads are explicit.
- Data fetching requires HTTPS, an endpoint allowlist, normal certificate validation, no cookies, 15-second timeouts, bounded streamed bodies and validated structures. Only the known Google export hosts can receive sheet redirects. Failed categories retain their previous timestamp and receive a stale flag. League caches are separate; an old request cannot publish into a newly selected league.
- Helper settings and public data caches live under the existing Electron user-data folder in `price-helper/`. No account credentials are stored by this feature. It does not modify the existing price table or drive sorting/listing decisions.
- The overlay has no preload bridge, disables Node integration, uses context isolation and sandboxing, denies navigation/new windows, and renders remote/OCR strings as text. Its CSP prohibits scripts and remote content. Helper IPC validates the sending window, frame and document URL.
- Silent installer updates, blanket keyboard hooks, fail-open capture, full-screen WORLD-label detection and permissive fuzzy matching were not imported. This version uses calibrated regions and English Windows OCR; GPU/WGC capture and multilingual dictionaries are not included.
- Electron was updated to 44.3.0, electron-builder to 26.15.3, and Vitest to 4.1.11 to resolve the reported dependency advisories. better-sqlite3 13.0.3 supplies portable N-API binaries for the new Electron runtime. Development now requires Node ≥22.12 (Node 24 recommended). The package helper verifies SQLite before building and does not force a needless ABI rebuild of the N-API binary.

The upstream review found background update staging/application and capture that can continue on failed game detection. These are risk-relevant design differences, not evidence that the upstream program is malware. The downloaded upstream executable was not run or certified. Neither this review nor a clean dependency audit guarantees absence of vulnerabilities or GGG approval.

## Verification

The new core/service/UI tests cover exact gem matching, stack totals, currency conversion, malformed data, cache isolation, partial failures, rate limiting, unsafe redirects, response-size limits, focus loss, late OCR completion after stop, and escaped text. Packaged smoke tests cover the helper in both build modes without capturing the screen or generating game input. A separate read-only live-data probe fetched all five poe.ninja categories and the community rumour sheet successfully.

Full-suite baseline note: the existing `item-sprites` and `transfer-reconciler` recorded-wand tests also fail on the unchanged `32b3468` checkout. They depend on a recorded inventory image and calibration; they are outside this helper's changes. The final task report records the actual check results. In-game OCR accuracy, drag calibration, monitor/DPI behavior and overlay placement still need a user check with the real game list.

Validation snapshot, 2026-09-12:

| Check | Result |
| --- | --- |
| Lint and TypeScript | Passed |
| Helper/core/host/overlay/UI/preload checks | 37 passed |
| Full Vitest suite | 919 passed; 2 pre-existing recorded-inventory failures |
| Public and QA Windows packages | Built successfully |
| Selected packaged helper, dashboard, combat and activation checks | 8 passed; an earlier activation failure passed on isolated retry and on the complete rerun |
| Dependency audit | 0 reported vulnerabilities |
| Live public-data probes | Five categories loaded in Runes of Aldur and HC Forbidden Rites; 23 community rumours loaded |
