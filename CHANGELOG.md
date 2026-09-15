# Changelog

All notable changes to this app. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Build-aware item decisions** — every evaluated item now gets one of four
  outcomes (keep, list, review, discard-eligible) from a curated, dated
  build-demand table (`src/data/demand/buildDemand.ts`, researched
  2026-09-14 for Forbidden Rites 0.5.5b) plus an auditable discard check.
  The Item log shows the decision with its build/use case, source dates and
  the audit; the map runner prints it; the review queue is priority-tagged.
  Demand is never shown as a price. See `docs/features/build-demand.md`.
- `scripts/demand-shadow.ts` — offline replay of saved bag snapshots through
  the live evaluator (no input, no network) with a written report.

- **Auto-cast** — the auto-flask guard also watches skill-bar icons and presses
  a skill's key whenever its icon reads ready (off cooldown). Ships with
  Powered by Verisium on T; more skills can be added, calibrated by clicking
  the lit icon, under Tools → Hotkeys → Auto-flask & auto-cast.
- **Overlay** — a transparent in-game window with panels for Evaluate, Inspect,
  Trade, Notes, Stash search, Stash prices, the session recap and the campaign
  guide, plus rebindable global hotkeys under Tools → Hotkeys.
- **Evaluate** (`Alt+E`) — price-check an item from one audited Ctrl+C: a trade2
  query built from the item, editable filters, profiles, pseudo totals, and a
  listing table with age, seller and DPS.
- **Market** — an in-app trade browser: query builder, result tabs, favourites
  in folders, trade-site URL import, bulk exchange and live searches.
- **Trade** — offer cards from your own whispers, one chat line per click,
  Windows/Discord/Telegram notifications and a 14-day trade history with CSV.
- **Inspect** (`Alt+I`) — mod tiers and rolls, weapon DPS, defences at 20 %
  quality, wiki links and waystone danger warnings.
- **Commands, bookmarks, notes and stash searches** — hotkeys that send one chat
  line, open a site, or fill the stash search box.
- **Stash tracker** — named snapshots of the stash ledger, comparisons, session
  gains and an in-game price overlay.
- **Home, session and mapping** — character, area and map tracking from
  Client.txt, a post-session recap and death screenshots.
- **Campaign guide** (`Alt+G`) — a community-maintained levelling route with the
  current area, an experience helper and a schematic world map.
- **Pricing history** — poe2scout daily price history per item with favourites.
- **Settings** — overlay placement and scale, a first-run checklist, the
  changelog, window options and the Client.txt override.

### Changed

- Rarity- or class-wide price-table rows (the starter "any unique = 1 ex")
  are floors, not prices: they no longer set an estimated value, they yield
  to your keep/sell/dump rules, and uniques are no longer auto-listed at 1 ex
  by the shop screen (they go to a lookup).
- `--drop-unknown` on the map runner now drops only items whose discard
  audit passed; the default still retains every unknown-tier item.
- Weapon DPS now folds PoE2's per-element damage lines (`Cold Damage:
  55-102 (cold)`) into the total; bows, crossbows and spears read 40-60 %
  higher than before. A Gemini Bow's "Surpassing chance to fire an
  additional Arrow" implicit no longer reads as fifty extra arrows.
- New mod families the current guides ask for (elemental attack damage,
  weapon crit, leech, ailment magnitude, mana, spirit %, energy shield
  recharge, cooldown recovery, minion damage/life, extra damage …); energy
  shield is weighted for demand again (Chaos Inoculation is on 18 % of the
  ladder). Thresholds are curated estimates until the learned-tier store
  covers them.

## [0.1.0] - 2026-09-01

- Initial companion: item parsing, valuation, stash sorting, shop listings,
  wealth, market trends and the deals watchlist.
