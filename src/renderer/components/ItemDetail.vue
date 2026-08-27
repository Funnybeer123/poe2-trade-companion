<script setup lang="ts">
import { computed } from "vue";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "@core/types";
import { formatAmount, formatDate } from "../utils/intelligence";

const props = defineProps<{
  item: NormalizedItem;
  valuation?: ValuationResult;
  desirability?: DesirabilityResult;
  compact?: boolean;
}>();

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
      </div>
    </header>

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
          This is an estimate, not a guaranteed sale price. Confirm current listings before acting.
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
