# Currency Exchange arbitrage

Ange's dialogue in the hideout has a **Currency Exchange** row next to
**Manage Shop** (`docs/HANDOFF-shop-listings.md`, "Opening it"). The shop
flow already OCRs that dialogue to click *Manage Shop*; the exchange panel
itself has **never been recorded**, so no OCR reader exists for it yet.

What exists today is the maths and a CLI over a hand-captured quotes file:

| Piece | Path |
| --- | --- |
| Pure arbitrage maths | `src/core/exchangeArbitrage.ts` |
| CLI | `scripts/exchange-arb.ts` |
| Sample quotes file | `fixtures/exchange/sample-quotes.json` |
| Tests | `tests/exchange-arbitrage.test.ts` |

Nothing here sends game input or touches the network. Trades are never
automated by this feature; it reports opportunities for the user to act on.

## What it computes

Market prices come from the price table (exalted per unit, the same
`lookupPrice` / `orbCosts` numbers crafting and the shop use), overridden
by a quotes file's own `prices` when present.

- **Direct edges** — `findDirectEdges(quotes, prices, minGainPercent)`:
  pairs whose exchange ratio beats the ratio the market prices imply by
  more than the threshold. `gainExPerHave` is the exalted gained per unit
  of the *have* currency, before gold fees.
- **Cycles** — `findCycles(quotes, { maxLength: 3, minGainPercent, … })`:
  chains of 2–3 trades that return to the start currency with more of it.
  Simple cycles are enumerated once per direction (the walk starts at the
  cycle's lowest-indexed currency, so rotations never repeat) and scored
  by the sum of log-ratios. Each cycle reports the multiplier, gross and
  net gain, the gold fees along the way, and — when quotes carry
  `quantity` — the most of the start currency the stock can absorb and
  which hop caps it.
- **Gold fees** are flat per trade, so whether a cycle survives them
  depends on trade size. Pass `startAmount` (units of the start currency)
  and `goldPerExalted` (how much gold an exalted is worth to you) and the
  fee is converted and netted; without both, `feeGold` is reported and
  `feeApplied` is `false` — the gain shown is gross.

## Quotes file

```json
{
  "league": "Runes of Aldur",
  "capturedAt": "2026-09-07T12:00:00Z",
  "goldPerExalted": 5000,
  "prices": { "Divine Orb": 649, "Chaos Orb": 44.8 },
  "quotes": [
    { "have": "Divine Orb", "want": "Chaos Orb", "ratio": 15.2, "quantity": 400, "feeGoldPerTrade": 900 }
  ]
}
```

- `ratio` is **want per 1 have**, exactly as the panel shows it. If the
  panel shows "1 : 15.2" for Divine → Chaos, the ratio is `15.2`; for the
  reverse direction record the reverse quote separately (they differ —
  that spread is the house edge).
- `quantity` is the *want* stock available at that ratio (optional).
- `feeGoldPerTrade` is the gold charged for one trade on that pair
  (optional).
- `prices` overrides the price table for the named currencies (optional).
- A bare array of quotes is also accepted.

## Running the CLI

```
npx tsx scripts/exchange-arb.ts --from=fixtures/exchange/sample-quotes.json
npx tsx scripts/exchange-arb.ts --from=artifacts/exchange/quotes-2026-09-07.json --min-gain=3 --amount=50
npx tsx scripts/exchange-arb.ts --from=... --json > report.json
```

| Flag | Meaning |
| --- | --- |
| `--from=<file>` | quotes file (required) |
| `--min-gain=N` | report only gains above N % (default 2) |
| `--amount=N` | units of the start currency per cycle, sizes the flat gold fee (default 1) |
| `--gold-per-ex=N` | gold per exalted for netting fees (default: the file's `goldPerExalted`) |
| `--max-length=N` | 2 or 3 trades per cycle (default 3) |
| `--json` | machine-readable output |

Prices come from the file's `prices`, then `artifacts/tab-admin/triage.json`
(the app's exported price table), then the crafting orb defaults. Currencies
with no price are listed as *unpriced* and skipped for direct edges; cycles
still work for them (only the fee netting needs a price).

## Recording the exchange panel (next step)

The OCR reader cannot be designed from memory; it needs a teach session of
the real panel. Record it with the existing recorder — it sends **no input
of its own**:

```
npx tsx scripts/record-teach.ts --secs=240 --narrate
```

Press Numpad 0 to stop early. Output lands in
`artifacts/teach/<session>/` (`events.jsonl`, one `f<ms>.png` frame per
second and per click, `narration.jsonl` when `--narrate` is on). Record at
the same 3840×2160 layout as the shop session so the geometry lines up
with `docs/HANDOFF-shop-listings.md`.

Demonstrate, slowly, and **say the numbers out loud** as you read them —
the narration is timestamped against the frames and turns a blurry
screenshot into ground truth:

1. Click **Ange**, then the **Currency Exchange** row (the dialogue rows
   are world-anchored; the shop flow already OCRs them — capture where
   this row sits relative to *Manage Shop*).
2. The panel: its **title band** text (the Merchant panel uses the stash's
   title band — check whether the exchange does too), and whether the
   inventory opens alongside it.
3. The **have** and **want** selectors: click each, show the pick list
   (its columns, scroll, any search box), pick a currency, and read the
   selected names aloud. Pick at least three pairs, including one where
   *have* is the expensive side (Divine → Chaos) and its reverse.
4. The **ratio text** for each pair, verbatim — "1 : 15.2", "15.2 per 1",
   or a market-order ladder — plus where it sits on screen. If the panel
   shows several price levels, read the top two.
5. The **stock / available quantity** for the *want* side, if shown.
6. The **gold fee**: its text, where it appears, and whether it changes
   with the amount entered (type a small and a large amount and read both
   fees aloud).
7. Any **confirm / trade** button position — for the record only. **Do not
   complete a trade** during the recording.
8. Close the panel and say "done".

With that session the reader is a small adapter: OCR the title band to
know the panel is open, OCR the selector labels and the ratio/stock/fee
regions, and emit `ExchangeQuote[]` in the file format above. The maths
and the CLI then run unchanged; the Market tool can grow an "Exchange"
section fed by the same quotes.

## Safety

- The exchange reader, when built, must be **read-only** by default; any
  trade execution goes behind the same dry-run switch and Numpad-8 step
  gate the shop flow uses, with the emergency stop honoured.
- Reported gains are estimates against a price feed that can be hours old
  (the feed's note carries its stamp). Never treat them as guaranteed.
