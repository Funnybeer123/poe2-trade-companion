# HANDOFF — Standard-league Remove-only drain + Guild stash sorting

**Mission, part 1 (build now):** drain every previous-league **(Remove-only)**
tab in Standard — withdraw everything and file it into the correct Standard
tabs using the existing ground-truth sort machinery. This is deliberately a
REHEARSAL HARNESS: when each future league ends and its tabs migrate to
Standard as Remove-only, the same script must run turnkey. Treat every
league-specific assumption as a bug.

**Mission, part 2 (design now, wire the routine later):** manage the GUILD
stash with the same sort functionality — sort items as members deposit them,
on a recurring routine. The routine/scheduling can come later; the sorting
core and the PACING layer must be designed in from the start, because guild
stash actions are rate-limited in practice (see the research section — there
is NO published number; the limit must be measured, and the sorter must sit
safely below it).

## Where the sorter stands (2026-08-30, all live-verified)

Read docs/HANDOFF-sort-performance.md — especially "Live findings" — before
touching anything. Short version of the primitives you inherit:

- Ground-truth identification: batched hover + Ctrl+C per cell
  (`identifyCells`), incremental per-visit read model, verified
  sprite-continuation skips, informed offset probes, phantom blacklists.
- Navigation: top-level tabs/folders by STRIP-HEADER clicks (the user's
  chosen design; no-overflow layouts have NO dropdown toggle);
  light-coloured tabs never OCR and are found by `brightHeaderRuns` pixel
  elimination; folder sub-tabs via the folder dropdown with cached rows;
  `pixwait` change-detection instead of fixed sleeps.
- Deposits: ctrl-click bursts verified by a TWO-READ bag capture ~1.4s apart
  (the bounce animation fakes landings — `deposit-bounce-detected`); full or
  missing destinations go dead for the visit and their items bail
  junk→source; a failed bail is non-fatal.
- Recovery: destructive stash-recovery clicks are gated on
  `hasConsistentCellGrid` pixel absence (toasts cover the title band and the
  hideout floor fools the loose detector — both watched live).
- End-to-end proof: the user's silver "Dump" quad (~150 items) sorted into
  the 18 Gear sub-tabs and verified clean by a final full sweep.

## Part 1 — Remove-only drain for Standard

### The rule change (user-authorized 2026-08-30)

The standing rule was "automation never touches Remove-only tabs." The user
has re-scoped it:

- Remove-only tabs are now legitimate **WITHDRAW-ONLY SOURCES**, but ONLY
  inside an explicit drain flow (new script, e.g.
  `scripts/drain-standard.ts`, or `--drain-remove-only`). Default sorting
  runs keep refusing them exactly as today.
- They remain PERMANENTLY forbidden as deposit targets and for
  rename/recolor — keep all three refusal layers (enumeration, navigation,
  dialog) for writes. Only the drain flow's SOURCE-selection refusal is
  lifted, and `isRemoveOnlyTabLabel` stays the single source of truth for
  detection.

### Design

1. **Enumeration**: Remove-only tabs live in the TOP list. With dozens of
   them the top strip OVERFLOWS again — which means the dropdown's top
   toggle RENDERS again and the legacy list machinery works there (both
   paths exist; `listTopSources`' strip/list split already keys on overflow
   evidence). Remove-only labels are long and OCR-readable.
2. **Drain semantics**: a Remove-only source means **everything leaves** —
   there is no "own class" and no "junk stays". Extend `cleanTab` with a
   `drain` source mode where `leaving = all identified items`:
   - Gear classes → the Gear sub-tabs (existing routing).
   - Non-gear (currency, essences, maps, gems…) → rely on the game's own
     AFFINITY routing: a plain ctrl-click deposits an affinity item into its
     affinity tab regardless of the open tab. Verify the user's affinities
     are configured first (the AFFINITIES folder exists); items that bounce
     everywhere fall back to the designated overflow tab (ask the user —
     probably "Dump" or "Extra").
   - The dead-dest/bail machinery already handles full destinations; for a
     drain the bail target is the overflow tab, never the Remove-only
     source (deposits there are impossible — the game refuses them, so a
     bail-to-source would silently fail; `bail` must special-case drain
     sources).
3. **Withdraw-only mechanics**: withdrawing from Remove-only works exactly
   like any tab (ctrl-click identified cells). The bag-growth ground-truth
   check stays the progress arbiter.
4. **Done condition**: the tab reads zero occupied cells (minus phantom
   blacklists). Report per-tab: items filed by class, unreadable cells left,
   and tabs that would not empty. A fully drained Remove-only tab disappears
   from the account on its own — enumeration must tolerate tabs vanishing
   between sessions.
5. **Future-league turnkey test**: keep a fixture/QA checklist
   (fixtures/perception + a dry-run recipe) so the flow is re-validated in
   minutes when a new league migrates. The 2026-08-30 lesson generalizes:
   every new layout broke ASSUMPTIONS (toggle position, OCR-ability, tab
   colors) but never the ground-truth core — so validate perception first
   (dry-run), then trust the Ctrl+C loop.

### Build state (2026-08-30)

**Target correction (user, 2026-08-30): the Remove-only tabs to drain live
in the GUILD stash** — league guild tabs migrated to Standard as
Remove-only. Destination decision (user): **sorted guild tabs** — gear
files into same-named TOP-LEVEL tabs inside the guild stash itself, never
out to the personal stash. So Part 1 runs THROUGH Part 2's chest handling,
and the pacing layer is now a prerequisite for the first LIVE drain.

**Guild-chest mode BUILT** (`sort-gear.ts --guild --drain-remove-only`):
`chest: "personal" | "guild"` on the sorter (the doc note above,
implemented). Guild mode: `ensureStash` clicks the nameplate READING
"Guild" (personal keeps excluding it); panel-title checks are two-way
specific ("Guild Stash" contains "stash", so personal now rejects /guild/
and guild requires it); no Gear folder exists so `ensureSession` skips the
folder row, `listContext` treats any stable list read as top-level, and
ALL navigation goes through the list (the overflowed guild strip shows ~2
headers; the strip path's guess fallbacks must never pick targets);
triage is disabled (Review/Dump are personal tabs).

**Verified-serial pacing layer BUILT** (`GUILD_PACE` + `guildWithdrawSerial`
/ `guildDepositSerial` in gearSorter): one action at a time; a withdrawal
commits only when the bag pixel-verifiably GREW, a deposit only when the
bag cell emptied in BOTH bounce-window reads; no commit = rollback = STOP
the batch + `paceDown` (never a retry hammer); floors ≥1000ms/item and
≥2500ms/tab switch (the harness pace multiplier can only slow it further).
Guild LIVE runs additionally demand an EMPTY bag (anything carried would
be filed into guild tabs — donated by accident) and never run --fast.

**Guild survey (probe, 2026-08-30, list read live)**: 7 Remove-only drain
sources — "31", "1", "2"×3, "3"×2 " (Remove-only)" — DUPLICATE labels, so
top-level navigation gained per-OCCURRENCE row matching (nth exact match +
per-source rowY; loose similarity matching is disabled for drains and for
drain --sources filters, because the numeric labels containment-match each
other: "1 (Remove-only)" sits inside "31 (Remove-only)"). Sorted guild
taxonomy found: Armor 1/2, Weapons 1/2, Jewels/Amulets/Charms, Rings,
HEAVY BELTS, Uniques, Currency, Materials, Essence, Gems, Flasks, Joes
Maps, Delirium, Duffel Bag. Routing (`guildDestForItem`, unit-tested):
armour classes → Armor 1→2 chain, weapons → Weapons 1→2 chain, belts →
HEAVY BELTS but charms → Jewels/Amulets/Charms, amulets/jewels → same,
rings → Rings, Rarity: Unique gear → Uniques (class fallback when full);
NON-GEAR STAYS PUT in v1 — extend one confirmed mapping at a time.

**Dry-run validated live (2026-08-30)**: enumeration found all 7 sources,
quad grids detected by lattice on the calibrated bounds, tab 31 read 15
items / 8 leaving → Armor 1, Uniques, Weapons 1, HEAVY BELTS. First live
drain (tab 31) launched same session.

**Gear-first increment BUILT** (`sort-gear.ts --drain-remove-only`): sources
become the Remove-only tabs (strip + top-list enumeration, list attempted
always since overflowed layouts hide exactly those rows from the strip);
gear files into the Gear folder by the normal Ctrl+C machinery; NON-GEAR
ITEMS STAY PUT — the affinity routing and overflow-tab fallback are the
next increment. Key decisions baked in:

- Symmetric navigation refusals: a drain goto may ONLY select a drainable
  Remove-only row (`isDrainableRemoveOnlyLabel` = Remove-only AND not
  priced — ~price protection outranks the drain flag); every other goto
  keeps refusing Remove-only exactly as before.
- No guessed navigation for drains: the bright-header elimination and the
  unmask hop are disabled on the drain path — Remove-only labels always
  OCR, so an unreadable label means skip, never guess. (Mis-selection
  would be non-destructive anyway — gear-first drain semantics equal
  top-level sort semantics — but drains stay exact.)
- `bail` never returns items to a drain source (the game refuses the
  deposit); they overflow to junk tabs or ride in the bag and are
  reported.
- Positional row-Y fallback is conflict-checked harder for drains: a
  readable non-Remove-only row at the cached Y, or no row at all, refuses
  the click — drained tabs VANISH and shift the list.

### Validation workflow (part 1)

1. `npx tsc --noEmit -p tsconfig.node.json` + `npx vitest run`.
2. Dry-run against ONE Remove-only tab (`--sources=<label> --dry-run`):
   verify enumeration, navigation, sweep read-rate, and the plan overlays.
3. Live-drain ONE small tab with `--step` gating first; then unattended
   with bench comparison. Numpad 0/5 stop/pause must stay ≤100ms.
4. Only then run the full drain (`--drain-remove-only`, all tabs).

## Part 2 — Guild stash sorting

### What is different about the guild stash

- **Separate chest — the guild flow MUST click the Guild Stash chest.**
  Two places currently hard-exclude it and both must be inverted for a
  guild session (target the nameplate containing "Guild", exclude the
  bare "Stash" plate of the personal chest):
  - `gearSorter.ensureStash` — the plate filter drops any "Stash" line
    within ±300px of a "guild" line;
  - `drainKit.clickStashChest` — same exclusion, same rules.
  Reusing either helper unmodified in a guild run silently opens the
  PERSONAL stash and the whole session sorts the wrong chest. Make the
  target chest an explicit mode (`chest: "personal" | "guild"`), never a
  copy-pasted variant. The minimap caveat carries over: its label is only
  safe as a walk-toward click, never as the open click. Panel title
  differs ("Guild Stash"); re-anchor the title-band checks — and note the
  personal-stash band regex `/stash/i` would also match "Guild Stash", so
  the guild check must be specific in BOTH directions.
- **No affinities**: affinity routing is a personal-stash feature. Every
  guild deposit lands in the OPEN tab, so navigation-before-deposit is
  mandatory and the affinity fallback from part 1 does not exist. (Verify
  in-game once; if guild affinities ever ship, simplify.)
- **Permissions**: per-rank view/add/remove toggles per tab, plus a stash
  history log. The automation account needs view+add+remove on every tab it
  manages; every action it takes is VISIBLE TO THE GUILD in the log — keep
  actions deliberate and bursts short; nothing here should ever look like
  spam.
- **Every action is a realm-master round trip.** Guild stash writes are
  saved synchronously to the realm's master server (community-confirmed;
  see sources), unlike personal-stash actions handled by the local
  instance. This is why guild stash feels slow and why hammering it is both
  throttle-prone and rude to the server.

### Rate limit research (2026-08-30) — and the pacing design it dictates

Searched: official forums, poewiki/fandom wiki, guildorder, Steam
discussions. **There is NO published numeric rate limit for in-client guild
stash actions** (the documented throttle limits are for the web stash API,
which is irrelevant to in-client automation). What IS established:

- Each guild-stash move is a synchronous server write; per-action latency
  is region-dependent and can be near a second on some realms (players
  cross-realm to a US server specifically because guild stash actions
  process faster there).
- Fast repeated actions manifest as lag/rollbacks (the item snaps back),
  not a clean error message. A rollback that goes unnoticed is an
  inventory-accounting bug — exactly what the double-read deposit
  verification exists to catch.

Since no official number exists, DO NOT HARDCODE A GUESS. The design:

1. **Verified-serial actions**: one item action at a time; the next action
   waits until the previous one is pixel-verified COMMITTED (item visibly
   left the bag / arrived, via the existing two-read verification). This
   self-paces to the server's actual speed and makes rollbacks impossible
   to miss. No ctrl-click BURSTS against the guild stash — `BURST_CHUNK`
   drops to 1 there.
2. **Conservative floor**: start at ≥1000ms between item actions and
   ≥2500ms between tab switches (`guildPace` config), i.e. well under one
   action per second — far below anything the community reports as
   problematic.
3. **Adaptive backoff**: any bounce/rollback/failed verification →
   `paceDown` (×1.5, existing harness machinery); long clean streaks →
   cautious `paceUp` but never below the calibrated floor.
4. **Calibration mode**: a supervised run that starts slow, speeds up in
   small steps while watching for rollbacks, and PERSISTS the measured safe
   rate per realm (artifacts/guild/pace.json). Re-run it after patches.
   This satisfies "look up the limit and stay below it" honestly: the limit
   is empirical, so measure it and stay under with margin.

### The routine (later, but design-compatible now)

- Pattern: an INTAKE tab ("Drop" tab) members deposit into; the routine
  sweeps intake → identifies by Ctrl+C → files into the guild's sorted
  tabs. Identical to the Dump-tab flow, just paced.
- Scheduling: the app daemon or a scheduled task launches the run when the
  game is at the hideout; the run must no-op gracefully when the game is
  not running or the guild chest is unreachable. Occupancy diff of the
  intake tab decides whether there is anything to do (cheap: one capture).
- Open questions for the user (ask before building):
  1. Which guild tabs are intake vs. sorted destinations? Create a "Drop"
     intake tab?
  2. What rank does the automation character hold; are view/add/remove
     granted on all managed tabs?
  3. Sort taxonomy for the guild (same per-class layout as personal Gear
     folder, or different)?
  4. Which realm/region — for the pace calibration.

## Invariants (inherited + new)

Everything in docs/HANDOFF-sort-performance.md's invariants section still
rules, plus:

- Remove-only: withdraw-only, drain-flag-only; never a deposit/rename
  target; `bail` must never target a Remove-only source.
- ~price tabs: untouchable, unchanged.
- Guild stash: a guild run clicks the GUILD Stash chest and verifies the
  "Guild Stash" panel title before any item action — the personal-stash
  helpers exclude that chest and their title checks match it, so both must
  be mode-switched, not reused. Verified-serial actions only, no bursts,
  adaptive pacing with a persisted floor; never act without
  view+add+remove confirmed; a rollback is a STOP signal (pace down,
  re-verify state), never a retry hammer.
- Every new-league / new-layout run starts with a dry-run perception pass —
  layouts change, the Ctrl+C core does not.

## Sources (guild stash rate limit research)

- No numeric in-client limit documented: [PoE forum — stash API throttle limits](https://www.pathofexile.com/forum/view-thread/1750403/page/1) (API-only),
  [poewiki — Guild Stash](https://www.poewiki.net/wiki/Guild_Stash),
  [fandom wiki — Guild Stash](https://pathofexile.fandom.com/wiki/Guild_Stash),
  [Guild Order — PoE2 guilds & guild stash](https://guildorder.com/games/poe2/wiki/guilds-and-the-guild-stash)
  ("confirm current details in-game").
- Guild stash actions are synchronous realm-master writes, region-dependent
  and slow: [PoE forum — Very slow guild stash interaction](https://www.pathofexile.com/forum/view-thread/3393562).
- Permission model (view/add/remove per rank + history):
  [Guild Order — permissions & theft prevention](https://guildorder.com/games/poe2/guides/guild-stash-permissions-and-theft-prevention),
  [vhpg — PoE guild permissions](https://www.vhpg.com/poe-guild-permissions/).
