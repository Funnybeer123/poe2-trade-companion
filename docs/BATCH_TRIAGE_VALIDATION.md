# Batch triage delivery and offline assessment

Date: **2026-09-14**. Implementation checkout: `Documents/Codex/poe2-trade-companion`, based on `43256ab`. Model: `batch-triage-v1`. Knowledge: `forbidden-rites-0.5.5b-2026-09-14.1`, **Forbidden Rites normal trade**. See [usage](DUMP_VALUATION.md), [research and limitations](FORBIDDEN_RITES_KNOWLEDGE.md), and [versioned data](../src/core/knowledge/forbidden-rites.json).

## Implemented behavior

The desktop and packaged worker now separate complete stash/inventory/both capture, offline assessment, optional bounded pricing, and verified saved-batch sorting. Capture checkpoints raw rows before scoring; reassessment preserves physical identities, original text, historical receipts, profiles and knowledge versions. Immutable content-addressed report archives preserve earlier revisions. Imported research is data-only, validated and immutable by ID.

The local model distinguishes real affix-tier evidence from heuristic points, counts hybrid groups, separates attack/spell/minion requirements, applies class-specific life tables, evaluates elemental coverage separately from chaos, and models ordinary magic/rare/jewel capacity. It recognizes useful normal/magic Unset bases and named build uniques, while keeping unknown effects and exceptional capacity mechanics in Review. Full useful items can qualify without crafting room. User weights, thresholds and Keep/Review feedback recompute locally.

Optional pricing persists a selected queue with a default ten-search budget, bounded listing fetches, exact-item deduplication, league/patch cache keys, request counters and throttle/cancellation resume. It never automatically queues the remainder of the batch. The fresh, adequately sampled, strictly-above-one-chaos gate remains separate from local Keep/Craft selection. Sorting revalidates current identity and position and verifies transfer receipts; it neither reprices nor retries historical moved/failed rows.

## Actual saved-batch results

The repository's working report and the installed app's report were **byte-identical by SHA-256**, so the repository copy was used. The original `stash-valuation-report.json`, `dump-scan-2026-09-14.json`, and installed-app report were hashed before and after the run: **all unchanged**. Item text and prior quote objects were compared for every physical ID; every historical moved/failed status, destination and receipt note was preserved.

| Measure | Before | Final offline result |
| --- | --- | --- |
| Physical items retained | 276 | 276 |
| Unread cells | 0 | 0 |
| Local Keep | Legacy model had no separate outcome | **8** |
| Craft candidates | 2 | **6** |
| Review | 274 | **255** |
| Low-priority, retained in ledger | 0 | **7** |
| Keep + craft shortlist | 2 legacy craft decisions | **14** |
| Existing verified moved receipts | 2 | 2 preserved |
| New planned candidates | — | 12; no transfers executed |

The 14-item shortlist contains seven amulets, three rings, three jewels and one pair of boots. It includes the two previously moved amulets; they are historical records, not repeat movement instructions. Their new local scores were computed from modifiers rather than fixed to the former 85/100. The two recognized magic Unset bases qualify from base utility, not an invented market value.

Historical market results remain 12 priced, 69 no-comparables, 6 unsupported and 189 unavailable. Expired historical prices did not authorize new transfers. **Actual new requests: 0 trade searches, 0 listing fetches, 0 stat-catalog requests, 0 economy requests. New game inputs: 0. New physical transfers: 0.** Separate public-web research is documented in the research artifact; no private item text was sent for research or pricing.

## Review coverage and remaining limits

Of 255 Review items, **173 carry explicit knowledge/parse uncertainty** and **82 have known coverage but do not establish a supported useful combination or a defensible low-priority decision**. Uncertainty categories overlap:

| Gap | Affected items |
| --- | --- |
| At least one unrecognized modifier | 170 |
| Missing affix grouping/capacity | 4 |
| Unknown explicit tiers | 4 |
| Copied value outside its annotated range | 6 |
| Incomplete/unidentified text | 1 |
| Unsupported special class/base | 6 |
| Unknown item level | 5 |

The research sample is intentionally small: four build-author guides, three profiles, no verified ladder shares or fresh market samples. Many jewel, special-effect and implicit families still need research. Tier inference beyond copied annotations is limited to supported standalone flat-life tables; hybrid life groups use their own copied tier. Absent Amulet's unusual capacity remains Review. These limitations are visible in the app and saved results rather than counted as zero-value evidence. No scores were adjusted to target a shortlist size.

## Verification evidence

- `npm run lint` and `npm run typecheck`: passed.
- `npm run test:all`: **128 files, 1,388 tests passed**, including unit, component, integration, performance and simulation/replay suites.
- `npm run pack:smoke`: both public-companion and authorized-qa desktop packages built successfully.
- `npx playwright test --grep 'dump values persist'`: **2 packaged desktop smoke tests passed** with isolated app data. They exercise settings/IPC persistence, report display, local reassessment, filtering, pricing dispatch, and the shipped standalone worker on empty and 276-item synthetic captures.
- The packaged worker's nonempty offline fixture forbids network and child-process input attempts. The real 276-item verification additionally forbids fetch, HTTP/HTTPS request/get, socket connect and child-process entry points, and checks originals, raw text, quotes and receipt preservation.
- Targeted regressions cover multiple T2 combinations, weak triple resistance, mixed/chaos resistance, irrelevant T1s, hybrid grouping/ranges, magic base parsing, normal/magic bases, jewels and capacity exceptions, full good items, restrictions, uniques, unknowns, incompatible subjects, duplicate physical copies, all 60 inventory cells, changed positions, transfer receipts, immutable imports/history, budget/deduplication/throttle/cancellation, actual request counts, and malformed offline input failing before game adapters.

These checks verify implementation and replay behavior; they do not constitute a new live game scan or movement trial. The installed application and its report were left unchanged. Fresh test packages are recorded in `artifacts/playwright/electron-builds.json`.

Private generated outputs (intentionally ignored by Git):

- `artifacts/tab-admin/batch-triage-assessment-2026-09-14.json`: complete 276-row ledger, assessment explanations and embedded knowledge.
- `artifacts/tab-admin/batch-triage-before-after-2026-09-14.json`: source hashes, counters, shortlist, review list and low-priority reasons.
- `artifacts/tab-admin/batch-triage-shortlist-2026-09-14.md`: readable item-by-item shortlist with historical positions and proposed destinations.
- `artifacts/batch-real-verification.log`, `batch-all-tests.log`, `batch-typecheck.log`, `batch-lint.log`, `batch-package.log`, `batch-desktop-smoke.log`: verification logs.
- `artifacts/playwright/test-results/`: isolated packaged screenshots and worker evidence.
