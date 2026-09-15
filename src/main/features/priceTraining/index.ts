/** Local corrections and review; only check-market can ask the shared feed for listings. */
import { PriceTrainingStore } from "../../../adapters/priceTrainingStore.js";
import { estimateTrainingPrice, trainingIdentity, validatePriceLessonInput } from "../../../core/priceTraining.js";
import type {
  PriceTrainingBudget,
  PriceTrainingItemInput,
  PriceTrainingOverview,
  PriceTrainingPreview,
} from "../../../shared/priceTraining.js";
import type { FeatureContext, FeatureModule } from "../types.js";

export const PRICE_TRAINING_ROUTE = "/tools/price-training";
export interface PriceTrainingModuleDeps {
  store?: Pick<PriceTrainingStore, "list" | "save" | "remove" | "review" | "dismissReview">;
  now?: () => Date;
}

function itemInput(raw: unknown): PriceTrainingItemInput {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PriceTrainingItemInput>;
  const itemText = typeof source.itemText === "string" ? source.itemText.trim() : "";
  const league = typeof source.league === "string" ? source.league.trim() : "";
  if (!league || ["auto", "unknown", "unassigned"].includes(league.toLowerCase()) || league.length > 120) throw new Error("Enter the league for this item.");
  trainingIdentity(itemText);
  return { itemText, league };
}

function recordId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Select a saved example first.");
  return raw.trim();
}

export function createPriceTrainingModule(deps: PriceTrainingModuleDeps = {}): FeatureModule {
  return {
    id: "price-training",
    register(ctx: FeatureContext) {
      const store = deps.store ?? new PriceTrainingStore(ctx.configDir);
      const now = deps.now ?? (() => new Date());
      const feed = ctx.core.priceFeed;
      let checking = false;

      function budget(): PriceTrainingBudget {
        const status = feed.status();
        const trade = feed.tradeBudget();
        const blockedReason = checking ? "A market check is already running."
          : status.leagueAmbiguous ? "Pin the market league in Settings before checking listings."
          : !status.resolvedLeague ? "Pin the market league in Settings before checking listings."
          : trade.restrictedUntilIso ? `Market requests are paused until ${trade.restrictedUntilIso}.`
          : trade.lookups < 1 || trade.searchesSpare < 1 || trade.fetchesSpare < 1
            ? "No market lookup is available right now." : undefined;
        return {
          ...(status.resolvedLeague ? { league: status.resolvedLeague } : {}),
          leagueAmbiguous: status.leagueAmbiguous,
          lookups: trade.lookups,
          ...(trade.restrictedUntilIso ? { restrictedUntilIso: trade.restrictedUntilIso } : {}),
          ...(blockedReason ? { blockedReason } : {}),
          busy: checking,
        };
      }

      ctx.handle("price-training:overview", (rawLeague?: unknown): PriceTrainingOverview => {
        const currentBudget = budget();
        const league = typeof rawLeague === "string" && rawLeague.trim() ? rawLeague.trim() : undefined;
        const configured = feed.status().config?.league;
        const suggestedLeague = currentBudget.league ?? (configured && configured.toLowerCase() !== "auto" ? configured : undefined);
        return {
          lessons: store.list(league),
          review: store.review(league),
          ...(suggestedLeague ? { league: suggestedLeague } : {}),
          budget: currentBudget,
        };
      });
      ctx.handle("price-training:preview", (raw: unknown): PriceTrainingPreview => {
        const input = itemInput(raw);
        const currentBudget = budget();
        // peek uses the feed's league; never attach another league's evidence to this item.
        const cached = currentBudget.league === input.league && !currentBudget.leagueAmbiguous
          ? feed.peekCompsResult(input.itemText) : undefined;
        return {
          estimate: estimateTrainingPrice(input.itemText, input.league, store.list(input.league), now()),
          ...(cached && cached.league === input.league ? { cachedMarket: cached } : {}),
          budget: currentBudget,
        };
      });
      ctx.handle("price-training:save", (raw: unknown, rawId?: unknown) => {
        const validated = validatePriceLessonInput(raw);
        if (!validated.valid) throw new Error(validated.errors.join(" "));
        return store.save(validated.value, rawId === undefined ? undefined : recordId(rawId));
      });
      ctx.handle("price-training:remove", (id: unknown) => store.remove(recordId(id)));
      ctx.handle("price-training:dismiss-review", (id: unknown) => store.dismissReview(recordId(id)));
      ctx.handle("price-training:check-market", async (raw: unknown) => {
        const input = itemInput(raw);
        const before = budget();
        if (before.league !== input.league) {
          return { market: { ok: false, error: "This item's league must match the pinned market league." }, budget: before };
        }
        const cached = !before.leagueAmbiguous ? feed.peekCompsResult(input.itemText) : undefined;
        if (cached?.ok && cached.league === input.league) return { market: cached, budget: before };
        if (before.blockedReason) return { market: { ok: false, error: before.blockedReason }, budget: before };
        checking = true;
        try {
          const market = await feed.fetchTrainingComps(input.itemText);
          checking = false;
          // A settings change during a request must never relabel its result.
          if (market.league && market.league !== input.league) {
            return { market: { ok: false, error: "The market league changed; this result was not used." }, budget: budget() };
          }
          return { market, budget: budget() };
        } finally {
          checking = false;
        }
      });
    },
  };
}

export const priceTrainingModule = createPriceTrainingModule();
