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

const demoPrices = computed(() => props.valuation?.providerName === "fixture");

const appraisal = computed(() => props.tier?.appraisal);
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
          <span v-if="demoPrices" class="pill warning" title="The live trade provider is disabled; these numbers come from bundled fixture data and are not market prices.">
            demo prices
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
        <p class="muted">
          Based on {{ valuation.comparablesUsed }} usable comparables from
          {{ valuation.candidateCount }} candidates · {{ valuation.providerName }} ·
          {{ formatDate(valuation.marketTimestamp) }}
        </p>
        <p v-if="valuation.lowConfidenceReason" class="inline-notice warning" role="note">
          {{ valuation.lowConfidenceReason }}
        </p>
        <p class="disclaimer">
          {{
            demoPrices
              ? "These are bundled demo numbers, not market data. Use the Sort screen's price table for real values."
              : "This is an estimate, not a guaranteed sale price. Confirm current listings before acting."
          }}
        </p>
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
.tier-line { border-left: 3px solid rgba(140, 140, 160, 0.4); padding: 0.4rem 0.7rem; border-radius: 0.3rem; margin: 0; }
.tier-keep { border-left-color: #4fa84f; }
.tier-sell { border-left-color: #c9a227; }
.tier-dump { border-left-color: #b35050; }
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
