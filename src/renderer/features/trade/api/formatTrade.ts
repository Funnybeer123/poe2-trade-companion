/**
 * Presentation helpers for the trade surfaces. Every number they render is an
 * ESTIMATE at the price table's current divine rate — the "≈" and the source
 * in the tooltip are part of the contract, not decoration.
 */
import { describeAge } from "@core/inventoryLedger";
import type { ChatCommandOutcome } from "../../../../shared/chatCommands";
import type { TradeOffer, TradeOfferPrice, TradeOfferState, TradeSecure } from "../../../../shared/trade";

export function formatExalted(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ex`;
}

/** "1.5 divine ≈ 1 div + 250 ex" — the split when there is one, else the ex figure. */
export function formatOfferPrice(price: TradeOfferPrice): string {
  const estimate = price.split?.text ?? (price.exalted !== undefined ? formatExalted(price.exalted) : undefined);
  return estimate ? `${price.text} ≈ ${estimate}` : price.text;
}

export function priceTitle(
  price: TradeOfferPrice,
  divineRate: number,
  source: "price-table" | "fallback",
  feedAgeHours?: number,
): string {
  if (price.exalted === undefined && !price.split) return "No rate for this currency — estimate unavailable.";
  const age = feedAgeHours === undefined ? "" : ` (feed ${feedAgeHours.toFixed(1)} h old)`;
  return source === "price-table"
    ? `at ${divineRate} ex/div from the price table${age} — estimate`
    : `fallback rate ${divineRate} ex/div — refresh market prices — estimate`;
}

export function offerAge(at: string, now: number): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "just now";
  return describeAge(Math.max(0, now - parsed));
}

export function stateChip(state: TradeOfferState): { label: string; tone: "safe" | "warning" | "danger" | "neutral" } {
  switch (state) {
    case "new":
      return { label: "New", tone: "warning" };
    case "invited":
      return { label: "Invited", tone: "neutral" };
    case "joined":
      return { label: "Joined", tone: "safe" };
    case "trading":
      return { label: "Trading", tone: "safe" };
    case "completed":
      return { label: "Completed", tone: "safe" };
    case "cancelled":
      return { label: "Cancelled", tone: "danger" };
    default:
      return { label: "Dismissed", tone: "neutral" };
  }
}

export function directionChip(direction: TradeOffer["direction"]): {
  label: string;
  tone: "safe" | "warning";
} {
  return direction === "incoming" ? { label: "Buyer", tone: "safe" } : { label: "Seller", tone: "warning" };
}

export function secureChip(secure: TradeSecure): { label: string; tone: "warning" | "neutral" } | undefined {
  if (secure === "yes") return { label: "Secure item", tone: "warning" };
  if (secure === "maybe") return { label: "Secure?", tone: "neutral" };
  return undefined;
}

/** What actually happened to the chat line, in the user's words. */
export function describeChatOutcome(outcome: ChatCommandOutcome | undefined): string {
  if (!outcome) return "";
  if (outcome.dryRun) return `Dry-run: would type ${outcome.sent ?? "the line"}`;
  if (outcome.ok) return `Typed ${outcome.sent ?? "the line"}`;
  switch (outcome.blockedBy) {
    case "not-foreground":
      return "Blocked: Path of Exile is not the foreground window — click the game first";
    case "kill-switch":
      return "Blocked: kill switch is latched — Re-arm input in the top bar";
    case "disabled":
      return "Blocked: chat commands are disabled in Tools → Settings";
    case "rate-limit":
      return "Blocked: too many chat lines this minute — wait a moment";
    case "another-host":
      return "Blocked: another input host is running (numpad daemon or a CLI)";
    case "process-not-allowed":
      return "Blocked: the foreground process is not on the allowlist";
    case "empty":
    case "too-long":
      return `Blocked: ${outcome.error ?? "the line was refused"} — use Copy whisper line instead`;
    default:
      return `Blocked: ${outcome.error ?? "the chat service refused the line"}`;
  }
}
