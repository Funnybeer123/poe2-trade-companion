# WIRING — package `trade` (P3)

Everything the integrator adds for the Trade feature. Every path below exists in the tree.
The feature itself touches no shared file.

---

## 1. Registry — `src/main/features/registry.ts`

```ts
import { tradeModule } from "./trade/index.js";
```

and, under `// Features:` (judge order `evaluateModule, inspectModule, marketModule, tradeModule, …`):

```ts
  tradeModule,
```

`trade` requires only the foundations (`clientLog`, `chatCommands`, `overlay`, `hotkeys`) and no other wave-2 module.

## 2. Router — `src/renderer/router/index.ts`, before the `/tools/:tool?` record

```ts
  {
    path: "/trade",
    name: "trade",
    component: () => import("../features/trade/views/TradeView.vue"),
    meta: {
      title: "Trade",
      eyebrow: "Operate",
      description: "Offer cards from your whispers, one chat line per click, and the trades the game confirmed.",
    },
  },
```

## 3. Primary nav — `src/renderer/App.vue` `navigation`, after Market

```ts
  { to: "/trade", label: "Trade", short: "TR", detail: "Offers & history" },
```

Order: Home, Sort, Shop, Market, **Trade**, Wealth, Item log, Search, Builds. "Trade" is not a
word-prefix of any other rail label.

## 4. Overlay panel — `src/renderer/overlay/panels.ts` `OVERLAY_PANELS`, after `NOTICE_PANEL`

```ts
  { id: "trade", title: "Trade", component: () => import("../features/trade/panels/TradePanel.vue"), defaultAnchor: "top-right", defaultSize: { width: 380, height: 260 }, resizable: true },
```

## 5. Hotkeys UI — nothing to add

`OverlayHotkeysSection.vue` groups contributed actions by `group`, so a **Trade** section appears on
its own with `trade.panel` (default `Alt+T`), `trade.invite-latest` (unbound) and
`trade.trade-latest` (unbound).

## 6. Tools → Settings — mount the webhook editor ONCE

No Tools entry (Trade is a primary workspace). In
`src/renderer/components/tools/FilterSettingsTool.vue` (`panel="settings"`), after the Market data
`</template>` and before P10's `<AppSettingsSections />`:

```ts
import TradeWebhooksCard from "../../features/trade/components/TradeWebhooksCard.vue";
import { getTradeApi } from "../../features/trade/api/tradeApi";

const tradeApi = getTradeApi();
```

```html
<TradeWebhooksCard v-if="tradeApi" />
```

This is the ONLY place the Discord webhook URL / Telegram bot token / chat id are entered (next to
the POESESSID field). Do not mount it anywhere else and do not build a second webhook editor
(conflicts §3 #4, compliance §0.1). The everyday trade toggles stay in the Trade view's
`<details>`; the chat-commands on/off switch stays with F3's `chat-commands.enabled`.

P10's Notifications cross-reference line should read:
"Trade offers and quick whispers: Trade → Trade settings. Discord/Telegram webhooks: Trade webhooks (below)."

## 7. Docs

**README** — "Item intelligence" workspace bullets:

```md
- **Trade** — offer cards from your Client.txt whispers (buyers and sellers), one chat line per click (invite, trade, hideout, stash highlight, quick whispers), Windows / Discord / Telegram notifications, and a 14-day trade history with CSV export. Never accepts a trade.
```

**USER_GUIDE** — new H2 `## Trade`, from `docs/features/trade.md` (sections in that order):
purpose + disclaimer → the flow → offer cards and states → actions (button → exact chat line) →
in-game panel → quick whispers → notifications and webhooks (with the privacy paragraph) →
trade history → troubleshooting table.

**USER_GUIDE "Where data lives"** rows:

```md
| `%APPDATA%\poe2-trade-companion\trade-offers.json` | Active offer cards: the other players' character names and whisper text. ≤ 100 cards, expire by timeout. |
| `%APPDATA%\poe2-trade-companion\trade-history.json` | 14-day trade history: names, items, prices. Also read by Home for the session recap. |
| `%APPDATA%\poe2-trade-companion\trade-webhooks.secret.json` | Discord webhook URL / Telegram bot token + chat id. Never synced, never under the repo, never in `companion-settings.json`. |
| `companion-settings.json` → namespace `trade` | Trade toggles and quick-whisper templates only — never a URL or token. |
```

**USER_GUIDE "What this build will not do"**: "never accepts or completes a trade, never invites or
whispers without a click, never clears the stash search for you".
**USER_GUIDE "Dry-run"**: it stops chat lines, not Client.txt reading and not webhooks.

**ARCHITECTURE** "Current layout":

```md
- `src/main/features/trade/*` — offer state machine over Client.txt events, history + shop-ledger merge, notifier; pure logic in `src/core/{tradeOffers,tradeHistory,tradeNotify}.ts`, shared types in `src/shared/trade.ts`.
```

**GGG_COMPLIANCE**: chat lines are user-initiated, one per gesture, through the audited chat command
service; the app never completes a trade; webhooks are outbound-only to endpoints the user created,
≤ 10/min per target, no retries, redirects refused.

**HANDOFF first live checks** (dry-run first, in this order):
1. Whisper yourself from a second account → a card within a second; Invite shows "would type /invite …".
2. Dry-run off, Invite from the DESKTOP view → the game comes forward and the invite lands (F3 `focus`).
3. Highlight with the stash open, from the desktop view and from the panel.
4. Panel "Custom…" → type → Ctrl+Enter: the panel stays open and the whisper lands (`setFocus` hand-off; UNVERIFIED).
5. A real 1-ex trade → history row + totals.
6. `Alt+T` with the game borderless-fullscreen.
7. `@Name text` quick whisper actually lands as a whisper (UNVERIFIED through the host).
8. Party / area-join lines for an outgoing trade (UNVERIFIED).
9. A Discord webhook Test.

## 8. e2e

`e2e/public-companion.spec.ts` `WORKSPACES`: add after Market

```ts
  ["Trade", "Trade", "/trade"],
```

per-workspace assert: `await expect(page.getByText(/No offers yet/)).toBeVisible();`
(the view renders "No offers yet. Trade whispers from Client.txt appear here within a second." on a
fresh user-data dir, with no network and no `pageerror`).

`e2e/authorized-qa.spec.ts` `routes`: add the same triple.
The Settings tool assertion may additionally check `getByRole("heading", { name: "Trade webhooks" })`.

## 9. Shared tests (integrator only)

- **Preload contract test** — no change: the feature uses only `window.poe2.features`.
- **`tests/input-boundary.test.ts`** — add `src/main/features/trade/**` to the directory scan that
  asserts no `startWinHost` import and no raw `host.send({ op: … })` call (conflicts §1,
  compliance §0.2). The package asserts the same thing about its own source in
  `tests/trade-module.test.ts`, but the shared scan is the one that catches a future regression.

## 10. electron-builder

Nothing to add: the feature ships no data file outside `src/`.

---

## Files this package owns

| Path | Role |
|---|---|
| `src/shared/trade.ts` | types, defaults, `normalizeTradeSettings`, `validateQuickWhisper` |
| `src/core/tradeOffers.ts` | offer state machine, pricing composition, action → one chat line |
| `src/core/tradeHistory.ts` | history sanitizing, retention, totals, CSV, shop-ledger merge |
| `src/core/tradeNotify.ts` | notification text, webhook bodies, validators, redaction, rate window |
| `src/main/features/trade/index.ts` | the module: channels, events, hotkeys, panel, tick |
| `src/main/features/trade/fs.ts` | read/write/stat/remove, real + in-memory |
| `src/main/features/trade/offerStore.ts` | `trade-offers.json` |
| `src/main/features/trade/historyStore.ts` | `trade-history.json` + ledger import |
| `src/main/features/trade/notifier.ts` | Windows notification, toast, Discord / Telegram |
| `src/renderer/features/trade/api/{tradeApi,useTradeStore,formatTrade,useTradeSound}.ts` | renderer client, store, formatting, beep |
| `src/renderer/features/trade/components/{TradeOfferCard,TradeOfferList,TradeHistoryTable,TradeSettingsCard,TradeWebhooksCard}.vue` | cards, table, settings, the one secret editor |
| `src/renderer/features/trade/views/TradeView.vue` | route `/trade` |
| `src/renderer/features/trade/panels/TradePanel.vue` | overlay panel `trade` |
| `fixtures/trade/{session-en.txt,whispers-multilang.txt,history-sample.json,listings-sold.jsonl}` | offline fixtures |
| `tests/trade-{offers,history,notify,stores,module}.test.ts`, `tests/component/trade-{offer-card,view,panel,webhooks-card}.test.ts` | the package's tests |
| `docs/features/trade.md` | the USER_GUIDE section draft |
