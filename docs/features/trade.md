# Trade

Draft of the `## Trade` section for `docs/USER_GUIDE.md`.

**Where:** **Trade** in the left rail, or **Alt+T** for the in-game panel.

Trade reads the whispers Path of Exile already writes to your `Client.txt` and turns them into offer
cards: who wants what, for how much, and where the item sits in your stash. Every button types
**exactly one chat line** into the game — the same line you would type yourself. The trade window's
**Accept is always yours**; nothing here accepts, confirms or moves anything, and nothing is priced
through the trade site on this screen (the exalted figures come from your local price table).

## The flow

1. A buyer whispers you. The card appears within a second, the in-game panel opens (if the game is
   running) and you get a Windows notification, an in-game toast, or a beep.
2. **Invite** types `/invite <buyer>`.
3. The buyer joins your area — the card moves to **Joined**.
4. **Trade** types `/tradewith <buyer>`.
5. You accept the trade window yourself. The game writes `Trade accepted.` and the card becomes a
   history row.

A **purchase** (a whisper *you* sent) is quieter by design: with *Notify on my own purchases* off
(the default) it makes a card and a history row, but no notification, no beep and no panel of its
own — open the panel with **Alt+T** or from the Trade view if you want to drive it from in-game.

## Offer cards and states

| Chip | Meaning |
|---|---|
| **Buyer** / **Seller** | Someone is buying from you (a sale), or you whispered someone (a purchase). |
| **New** | The whisper arrived; nothing typed yet. |
| **Invited** | You typed `/invite` (or `/hideout` for a purchase). |
| **Joined** | The game logged them joining your area (or you joining their party). |
| **Trading** | You typed `/tradewith`. |
| **Completed** | `Trade accepted.` was matched to this card. |
| **Cancelled** / **Dismissed** | The trade was cancelled, you dismissed the card, or it timed out. |
| **×N** | The same whisper arrived N times (one card, not N). |
| **wrong league** | The whisper's league is not your pinned pricing league. |
| **Secure item** / **Secure?** | The whisper looks like a merchant (Secure) listing, or it carries no stash tab and position. A guess, never a fact. |
| **untested template** | The whisper matched a non-English trade-site template. Those were transcribed, not observed — tell us if a field looks wrong. |

## Actions

| Button | What is typed | Notes |
|---|---|---|
| Invite | `/invite <player>` | Buyers only. |
| Trade | `/tradewith <player>` | |
| Hideout | `/hideout <player>` | Purchases only. |
| Highlight | the item name into the stash search box | Open your stash first. Clearing the box again is your Escape — the app never types a second time for you. |
| Whisper ▾ | your quick whisper, or a custom line | `Ctrl+Enter` sends. |
| Copy whisper line | nothing — the clipboard only | Use it when the chat service refuses a non-ASCII name. |
| Kick | `/kick <player>` | |
| Leave | `/kick <your character>` | Needs your character name (seen from a level-up line). |
| Dismiss / Reopen | nothing | Card bookkeeping only. |

With **Dry-run** on (top bar) the buttons show the line they *would* type and nothing is sent.

## In-game panel

The panel opens by itself on a new offer while Path of Exile is running (setting: *In-game panel
opens* — Always / Only in town or hideout / Never) and hides again when no offer is left, unless you
opened it yourself or pinned it. **Alt+T** toggles it. Escape or the × closes it.

**Custom… takes keyboard focus.** While the input is open the overlay is the foreground window, so
press Escape or send the line before clicking the game — otherwise the click-outside rule closes the
unpinned panel. Pinning the panel keeps it open either way.

## Quick whispers

Up to eight, edited in **Trade → Trade settings**. A template must start with `@{player}` (a
whisper) or `/` (a command) so it can never land in local chat, and it can only use characters the
input host can type. Placeholders: `{player} {item} {price} {tab} {left} {top} {league} {char}
{area} {latestWhisper}`.

## Notifications and webhooks

Windows notification, in-game toast and a built-in beep are toggled in **Trade → Trade settings**.

Discord and Telegram go to endpoints **you** create, in **Tools → Settings → Trade webhooks**
(next to the market-data cookie):

- Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
- Telegram: talk to `@BotFather`, create a bot, copy the token, then get your chat id.

**Privacy.** Each message contains the item, the price, the league and the stash position from the
whisper — and the other player's character name unless you untick *Include the other player's
name*. That is the same text the game wrote to your own `Client.txt`; nothing else is sent, ever.
Messages are capped at ten a minute per target, are never retried, time out after ten seconds, and
redirects are refused. The URL, token and chat id live only in
`%APPDATA%\poe2-trade-companion\trade-webhooks.secret.json`, are never shown again, and are never
written into `companion-settings.json`.

## Trade history

The **History** tab keeps 14 days by default (1–90). Rows come from matched trades, from your own
verified shop sales (the Earnings tab the shop flow re-reads), or from **Add trade**. Edit any row
inline; Delete asks twice.

Earnings, Spendings and Profit are **estimates in exalted** at the price table's current divine
rate — the rate and its source are printed under the totals, and a row whose currency has no rate is
counted as "unpriced" rather than guessed. **Export CSV (includes player names)…** writes
`at,kind,player,item,base_type,quantity,amount,currency,exalted_estimate,league,secure,matched,note`
(UTF-8 with a BOM, so Excel opens it directly). **Copy CSV** puts the same text on the clipboard.
The counter under the table ("n from the shop ledger") counts the ledger rows the table holds, not
the rows of the last import. A text value that starts with `=`, `+`, `-` or `@` — an item name or
note written by the other player — is exported with a leading apostrophe so a spreadsheet shows it
as text instead of running it as a formula.

## Troubleshooting

| Symptom | What to try |
|---|---|
| No cards at all | Tools → Settings: is the Client.txt path found? The readiness row on the Trade view says so. |
| Buttons disabled | Chat commands are off in Tools → Settings, the kill switch is latched (re-arm in the top bar), or an action is already running. |
| "Blocked: Path of Exile is not the foreground window" | Click the game first, or use the in-game panel / a hotkey instead of the desktop button. |
| "the input host cannot type …" | A non-ASCII name or item. Use **Copy whisper line** and paste it into the game. |
| "wrong league" on every card | Pin your league in Tools → Settings → Market data. |
| Panel never appears | The game was not detected; the panel only opens while Path of Exile runs. |
| Panel closed while I was typing | The Custom… input holds focus; press Escape or send first, or pin the panel. |
| Totals look wrong | The divine rate is a fallback — refresh market prices. Every figure is an estimate. |

## What this will not do

It never accepts or completes a trade, never invites or whispers without a click, never clears the
stash search for you, and never asks the trade site for a price on this screen.
