import type { PriceFeedStatusView } from "../services/rendererApi";

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** Feed prices older than this are treated as stale for a run. */
export const FEED_STALE_AFTER_HOURS = 36;

function timeOf(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : iso;
}

function feedAgeLabel(age: number): string {
  return age < 1 ? "under an hour" : `${Math.round(age)} h`;
}

/**
 * The pricing half of the Sort screen's readiness list: the league every
 * price keys off, how fresh the poe2scout feed is, and whether trade2 has a
 * lookup to spare. Nothing here fetches — it reads the feed status the main
 * process already holds. Empty in the browser preview (no bridge).
 */
export function pricingReadiness(status: PriceFeedStatusView | undefined): ReadinessCheck[] {
  if (!status) return [];
  const league = status.resolvedLeague;
  let leagueCheck: ReadinessCheck;
  if (status.leagueAmbiguous) {
    leagueCheck = {
      label: "Pricing league",
      ok: false,
      detail: `${status.leagueCandidates.length} current leagues — pick one in Tools → Settings → Market data`,
    };
  } else if (league) {
    leagueCheck = {
      label: "Pricing league",
      ok: true,
      detail: status.config.league === "auto" ? `auto → ${league}` : league,
    };
  } else {
    leagueCheck = {
      label: "Pricing league",
      ok: false,
      detail: "Not resolved yet — Tools → Settings → Market data → Check leagues",
    };
  }

  const age = status.feedAgeHours;
  let feedCheck: ReadinessCheck;
  if (age === undefined || status.feedEntryCount === 0) {
    feedCheck = {
      label: "Price feed",
      ok: false,
      detail: "Never refreshed — Sort → Prices → Refresh market prices",
    };
  } else {
    const stale = age > FEED_STALE_AFTER_HOURS;
    feedCheck = {
      label: "Price feed",
      ok: !stale,
      detail: `${status.feedEntryCount} feed prices · ${feedAgeLabel(age)} old${stale ? " — refresh before pricing" : ""}`,
    };
  }

  const budget = status.tradeBudget;
  let budgetCheck: ReadinessCheck;
  if (!budget) {
    budgetCheck = { label: "trade2 budget", ok: false, detail: "Unknown (older main process)" };
  } else if (budget.restrictedUntilIso) {
    budgetCheck = {
      label: "trade2 budget",
      ok: false,
      detail: `Penalty window until ${timeOf(budget.restrictedUntilIso)} — no lookups until then`,
    };
  } else {
    budgetCheck = {
      label: "trade2 budget",
      ok: budget.lookups >= 1,
      detail:
        budget.lookups >= 1
          ? `${budget.lookups} lookup${budget.lookups === 1 ? "" : "s"} spare right now`
          : "No lookup spare — the pacer is waiting for a window to free",
    };
  }

  return [leagueCheck, feedCheck, budgetCheck];
}
