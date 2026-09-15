<script setup lang="ts">
import { computed } from "vue";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "@core/types";
import type { TierVerdict } from "@core/valueTiers";
import { formatAmount, formatDate } from "../utils/intelligence";

const props = defineProps<{
  item: NormalizedItem;
  valuation?: ValuationResult;
  desirability?: DesirabilityResult;
  tier?: TierVerdict;
  compact?: boolean;
}>();

/** Bundled fixture quotes (tests/replay, browser preview) — never market data. */
const demoPrices = computed(() => props.valuation?.providerName === "fixture");

const PROVIDER_CHIPS: Record<string, { label: string; title: string; tone: string }> = {
  "price-table": {
    label: "price table",
    title: "Exact match in your price table (poe2scout feed or a manual row).",
    tone: "safe",
  },
  "trade2-comps": {
    label: "trade listings",
    title: "Real trade2 listings for this item, filtered to comparable mods.",
    tone: "safe",
  },
  appraisal: {
    label: "appraisal",
    title: "Mod-tier heuristic only — no price entry or listings were available.",
    tone: "warning",
  },
  none: {
    label: "no data",
    title: "Nothing priced this item: no table entry, listings, or appraisal evidence.",
    tone: "neutral",
  },
};

const providerChip = computed(() => {
  const provider = props.valuation?.providerName;
  if (!provider || provider === "fixture") return undefined;
  if (provider === "price-training") return {
    label: "saved price examples", title: "Your recorded examples, with their original evidence quality.", tone: "neutral",
  };
  return PROVIDER_CHIPS[provider] ?? { label: provider, title: `Valued by ${provider}.`, tone: "neutral" };
});

/**
 * The non-demo sentence is asserted verbatim by the packaged e2e run, so
 * provider-specific caveats travel in the chip title and lowConfidenceReason.
 */
const valuationDisclaimer = computed(() =>
  demoPrices.value
    ? "These are bundled demo numbers, not market data. Use the Sort screen's price table for real values."
    : "This is an estimate, not a guaranteed sale price. Confirm current listings before acting.",
);

const appraisal = computed(() => props.tier?.appraisal);
const decision = computed(() => props.tier?.decision);
const OUTCOME_LABELS: Record<string, string> = {
  keep: "Keep",
  list: "List / sell candidate",
  review: "Review",
  "discard-eligible": "Discard eligible (proposal)",
};
const outcomeLabel = computed(() => (decision.value ? OUTCOME_LABELS[decision.value.outcome] ?? decision.value.outcome : ""));
const decisionEvidence = computed(() => decision.value?.evidence.filter((entry) => entry.kind !== "demand") ?? []);
const failedChecks = computed(() => decision.value?.discard?.checks.filter((check) => !check.ok) ?? []);
const notableMods = computed(
  () => appraisal.value?.mods.filter((mod) => mod.familyId !== undefined) ?? [],
);
const bandLabel = computed(() =>
  (appraisal.value?.band ?? "").replace("-", " "),
);

const orderedMods = computed(() =>
  [...props.item.mods].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) -
        (right.order ?? Number.MAX_SAFE_INTEGER) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.line ?? Number.MAX_SAFE_INTEGER),
  ),
);

const orderedProperties = computed(() =>
  [...(props.item.properties ?? [])].sort(
    (left, right) => left.order - right.order,
  ),
);
</script>

<template>
  <article class="item-detail" :class="{ compact }">
    <header class="item-identity">
      <div>
        <span class="eyebrow">{{ item.itemClass }}</span>
        <h2 :class="`rarity-${item.rarity.toLowerCase()}`">{{ item.name }}</h2>
        <p>{{ item.baseType }}</p>
      </div>
      <div class="identity-chips" aria-label="Item identity">
        <span class="pill">{{ item.rarity }}</span>
        <span v-if="item.itemLevel !== undefined" class="pill">
          iLvl {{ item.itemLevel }}
        </span>
        <span v-if="item.quality !== undefined" class="pill">
          {{ item.quality }}% quality
        </span>
        <span v-if="item.corrupted" class="pill danger">Corrupted</span>
        <span v-if="!item.identified" class="pill warning">Unidentified</span>
        <span
          v-if="tier"
          class="pill tier-pill"
          :class="`tier-${tier.tier}`"
          :title="tier.reasons.join(' ')"
        >
          tier: {{ tier.tier }}
        </span>
      </div>
    </header>

    <p v-if="tier && tier.tier !== 'unknown'" class="tier-line" :class="`tier-${tier.tier}`">
      Triage would route this item as <strong>{{ tier.tier }}</strong>
      ({{ tier.source }}<template v-if="tier.price !== undefined">, {{ tier.price }} {{ tier.currency }}</template>):
      {{ tier.reasons[0] }}
    </p>

    <section v-if="decision" class="decision-panel" :class="`outcome-${decision.outcome}`" aria-labelledby="decision-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Decision</span>
          <h3 id="decision-title">{{ outcomeLabel }}</h3>
        </div>
        <span v-if="decision.review" class="pill warning" :title="decision.review.reason">review priority P{{ decision.review.priority }}</span>
      </div>
      <p class="decision-headline">{{ decision.headline }}</p>
      <p v-if="decision.demand" class="decision-demand">
        <strong>General demand ({{ decision.demand.strength }}):</strong> {{ decision.demand.label }}
        <template v-if="decision.demand.builds.length"> — wanted by {{ decision.demand.builds.join(", ") }}</template>.
        <span class="muted">Demand is not a price: no listing or sale for this item was observed.</span>
      </p>
      <ul v-if="decision.demand?.sources.length" class="decision-sources">
        <li v-for="source in decision.demand.sources" :key="source.url">
          <a :href="source.url" target="_blank" rel="noreferrer">{{ source.label }}</a>
          · {{ source.kind }} · {{ source.date }} · {{ source.strength }} evidence
        </li>
      </ul>
      <p v-if="decision.nearMiss" class="muted">
        Close to <strong>{{ decision.nearMiss.label }}</strong>; missing {{ decision.nearMiss.missing.join(", ") }}.
      </p>
      <p v-if="decision.craft" class="muted">
        Crafting: {{ decision.craft.action }} (+{{ decision.craft.expectedProfit }} ex expected, {{ decision.craft.confidence }}% confidence) — {{ decision.craft.reason }}
      </p>
      <ul v-if="decisionEvidence.length" class="reason-list">
        <li v-for="entry in decisionEvidence" :key="`${entry.kind}:${entry.label}`">
          {{ entry.label }}<template v-if="entry.detail"> — {{ entry.detail }}</template>
        </li>
      </ul>
      <p v-if="decision.coverage.unsupported.length" class="inline-notice warning" role="note">
        Lines the knowledge base cannot judge: {{ decision.coverage.unsupported.join("; ") }}
      </p>
      <p v-if="!decision.coverage.covered" class="inline-notice warning" role="note">
        {{ decision.coverage.itemClass }} is outside the demand knowledge; this item is never discarded automatically.
      </p>
      <details v-if="decision.discard" class="discard-audit">
        <summary>
          Discard audit — {{ decision.discard.eligible ? "every check passed" : `${failedChecks.length} check(s) blocked it` }}
        </summary>
        <ul>
          <li v-for="check in decision.discard.checks" :key="check.id" :class="check.ok ? 'check-ok' : 'check-fail'">
            <span class="check-mark">{{ check.ok ? "✓" : "✗" }}</span> {{ check.detail }}
          </li>
        </ul>
      </details>
      <p class="muted policy-line">{{ decision.policy }}</p>
      <p class="muted">
        Demand knowledge v{{ decision.coverage.knowledgeVersion }} ({{ decision.coverage.league }}), review by {{ decision.coverage.reviewBy }}<template v-if="decision.coverage.expired"> — past its review date</template>.
      </p>
    </section>

    <section v-if="appraisal" class="appraisal-panel" aria-labelledby="appraisal-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Appraisal</span>
          <h3 id="appraisal-title">Value &amp; confidence</h3>
        </div>
        <span class="confidence-chip" :class="appraisal.band">{{ bandLabel }} confidence</span>
      </div>

      <div class="appraisal-meters">
        <div class="appraisal-meter">
          <span class="meter-label">
            Value score <strong>{{ appraisal.valueScore }}</strong>/100
          </span>
          <div
            class="score-meter"
            role="meter"
            aria-label="Appraised value score"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="appraisal.valueScore"
          >
            <span :style="{ width: `${appraisal.valueScore}%` }" />
          </div>
        </div>
        <div class="appraisal-meter">
          <span class="meter-label">
            Confidence <strong>{{ appraisal.confidence }}</strong>%
            <small>via {{ appraisal.evidence }}</small>
          </span>
          <div
            class="score-meter confidence"
            role="meter"
            aria-label="Appraisal confidence"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="appraisal.confidence"
          >
            <span :style="{ width: `${appraisal.confidence}%` }" />
          </div>
        </div>
      </div>

      <p v-if="appraisal.estimatedValue" class="estimate-callout">
        Estimated worth
        <strong>
          ≈ {{ appraisal.estimatedValue.amount }} {{ appraisal.estimatedValue.currency }}
        </strong>
        <small v-if="appraisal.estimatedValue.stackCount">
          (stack of {{ appraisal.estimatedValue.stackCount }} ×
          {{ appraisal.estimatedValue.unitValue }})
        </small>
      </p>

      <ul v-if="appraisal.reasons.length" class="reason-list">
        <li v-for="reason in appraisal.reasons" :key="reason">{{ reason }}</li>
      </ul>

      <div v-if="notableMods.length" class="mod-breakdown">
        <h4>Mod breakdown</h4>
        <ul>
          <li v-for="mod in notableMods" :key="mod.text">
            <span class="mod-tier" :class="`t${mod.tier ?? 0}`">
              {{ mod.tier ? `T${mod.tier}` : "low" }}
            </span>
            <span class="mod-copy">
              <strong>{{ mod.text }}</strong>
              <small>{{ mod.familyLabel }} · {{ mod.points }} pts</small>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <div v-if="valuation || desirability" class="result-grid">
      <section v-if="valuation" class="valuation-panel" aria-labelledby="valuation-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Market signal</span>
            <h3 id="valuation-title">Estimated value</h3>
          </div>
          <span class="confidence-badge" :class="valuation.confidence">
            {{ valuation.confidence }} confidence
          </span>
          <span v-if="demoPrices" class="pill warning" title="Bundled fixture data for tests and the browser preview — not market prices.">
            demo prices
          </span>
          <span
            v-else-if="providerChip"
            class="pill provider-chip"
            :class="providerChip.tone"
            :title="providerChip.title"
          >
            {{ providerChip.label }}
          </span>
        </div>

        <div class="range-track" aria-label="Estimated low, fair, and high values">
          <div>
            <span>Low estimate</span>
            <strong>{{ formatAmount(valuation.low) }}</strong>
          </div>
          <div class="fair">
            <span>Fair estimate</span>
            <strong>{{ formatAmount(valuation.fair) }}</strong>
          </div>
          <div>
            <span>High estimate</span>
            <strong>{{ formatAmount(valuation.high) }}</strong>
          </div>
        </div>
        <p class="currency-line">{{ valuation.currency }}</p>
        <p class="estimate-callout">
          Suggested listing estimate
          <strong>{{ formatAmount(valuation.recommendedListing) }} {{ valuation.currency }}</strong>
        </p>
        <p v-if="valuation.providerName === 'price-training'" class="muted">
          Based on {{ valuation.normalizedKeyStats.trainedExampleCount }} saved price examples ·
          {{ formatDate(valuation.marketTimestamp) }}
        </p>
        <p v-else class="muted">
          Based on {{ valuation.comparablesUsed }} usable comparables from
          {{ valuation.candidateCount }} candidates · {{ valuation.providerName }} ·
          {{ formatDate(valuation.marketTimestamp) }}
        </p>
        <p v-if="valuation.lowConfidenceReason" class="inline-notice warning" role="note">
          {{ valuation.lowConfidenceReason }}
        </p>
        <p class="disclaimer">{{ valuationDisclaimer }}</p>
      </section>

      <section v-if="desirability" class="desirability-panel" aria-labelledby="desirability-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Recommendation</span>
            <h3 id="desirability-title">{{ desirability.category }}</h3>
          </div>
          <span class="score-orb">{{ desirability.score }}</span>
        </div>
        <div
          class="score-meter"
          role="meter"
          aria-label="Desirability score"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="desirability.score"
        >
          <span :style="{ width: `${desirability.score}%` }" />
        </div>
        <ul v-if="desirability.reasons.length" class="reason-list">
          <li v-for="reason in desirability.reasons" :key="reason">{{ reason }}</li>
        </ul>
        <p v-else class="muted">No positive desirability factors were recorded.</p>
      </section>
    </div>

    <div class="detail-grid">
      <section class="detail-section">
        <div class="section-heading">
          <h3>Properties</h3>
          <span>{{ orderedProperties.length }}</span>
        </div>
        <dl v-if="orderedProperties.length" class="property-list">
          <div v-for="property in orderedProperties" :key="`${property.block}-${property.order}`">
            <dt>{{ property.name }}</dt>
            <dd>{{ property.value || "Present" }}</dd>
          </div>
        </dl>
        <p v-else class="empty-copy">No structured properties were parsed.</p>

        <template v-if="Object.keys(item.requirements).length">
          <h4>Requirements</h4>
          <dl class="property-list compact-list">
            <div v-for="(value, name) in item.requirements" :key="name">
              <dt>{{ name }}</dt>
              <dd>{{ value }}</dd>
            </div>
          </dl>
        </template>
      </section>

      <section class="detail-section">
        <div class="section-heading">
          <h3>Ordered affixes</h3>
          <span>{{ orderedMods.length }}</span>
        </div>
        <ol v-if="orderedMods.length" class="affix-list">
          <li v-for="(mod, index) in orderedMods" :key="`${mod.block}-${mod.order}-${mod.text}`">
            <span class="affix-order">{{ index + 1 }}</span>
            <span class="affix-copy">
              <strong>{{ mod.text }}</strong>
              <small>{{ mod.kind ?? (mod.implicit ? "implicit" : "explicit") }}</small>
            </span>
          </li>
        </ol>
        <p v-else class="empty-copy">No modifier lines were parsed.</p>
      </section>
    </div>
  </article>
</template>

<style scoped>
.tier-pill { text-transform: capitalize; }
.provider-chip.safe { border-color: #4fa84f; color: #7dd87d; }
.provider-chip.warning { border-color: #c9a227; color: #e0c46a; }
.provider-chip.neutral { opacity: 0.75; }
.tier-line { border-left: 3px solid rgba(140, 140, 160, 0.4); padding: 0.4rem 0.7rem; border-radius: 0.3rem; margin: 0; }
.tier-keep { border-left-color: #4fa84f; }
.tier-sell { border-left-color: #c9a227; }
.tier-dump { border-left-color: #b35050; }
.decision-panel { display: flex; flex-direction: column; gap: 0.45rem; border: 1px solid rgba(140, 140, 160, 0.25); border-left-width: 3px; border-radius: 0.6rem; padding: 0.85rem 1rem; }
.decision-panel.outcome-keep { border-left-color: #4fa84f; }
.decision-panel.outcome-list { border-left-color: #c9a227; }
.decision-panel.outcome-review { border-left-color: #6f8fd6; }
.decision-panel.outcome-discard-eligible { border-left-color: #b35050; }
.decision-headline { margin: 0; }
.decision-demand { margin: 0; }
.decision-sources { list-style: none; margin: 0; padding: 0; font-size: 0.8rem; opacity: 0.85; }
.discard-audit ul { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.82rem; }
.check-mark { display: inline-block; width: 1.1rem; font-weight: 700; }
.check-ok .check-mark { color: #7dd87d; }
.check-fail .check-mark { color: #dd8f8f; }
.policy-line { font-style: italic; }
.appraisal-panel { display: flex; flex-direction: column; gap: 0.7rem; border: 1px solid rgba(140, 140, 160, 0.25); border-radius: 0.6rem; padding: 0.85rem 1rem; }
.confidence-chip { font-size: 0.78rem; padding: 0.15rem 0.6rem; border-radius: 1rem; border: 1px solid rgba(140, 140, 160, 0.4); text-transform: capitalize; }
.confidence-chip.very-high { border-color: #4fa84f; color: #7dd87d; }
.confidence-chip.high { border-color: #9ac94f; color: #bfe07f; }
.confidence-chip.medium { border-color: #c9a227; color: #e0c46a; }
.confidence-chip.low { border-color: #b35050; color: #dd8f8f; }
.appraisal-meters { display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem; }
.appraisal-meter { display: flex; flex-direction: column; gap: 0.3rem; }
.meter-label small { opacity: 0.65; margin-left: 0.35rem; }
.score-meter.confidence span { background: linear-gradient(90deg, #b35050, #c9a227 45%, #4fa84f 80%); }
.mod-breakdown ul { list-style: none; margin: 0.35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.mod-breakdown li { display: flex; gap: 0.6rem; align-items: flex-start; }
.mod-tier { flex: none; font-size: 0.72rem; font-weight: 700; padding: 0.12rem 0.45rem; border-radius: 0.3rem; border: 1px solid rgba(140, 140, 160, 0.4); margin-top: 0.1rem; }
.mod-tier.t1 { border-color: #4fa84f; color: #7dd87d; }
.mod-tier.t2 { border-color: #9ac94f; color: #bfe07f; }
.mod-tier.t3 { border-color: #c9a227; color: #e0c46a; }
.mod-tier.t0 { opacity: 0.6; }
.mod-copy { display: flex; flex-direction: column; }
.mod-copy small { opacity: 0.65; }
@media (max-width: 900px) { .appraisal-meters { grid-template-columns: 1fr; } }
</style>
