<script setup lang="ts">
/**
 * The Inspect body: identity, affix budget, per-modifier tier/roll/max
 * tier, weapon DPS, defences, map warnings, links and the knowledge line.
 *
 * Presentational on purpose — it takes a finished report and emits link
 * clicks upward, so the same card renders inside the overlay panel (where
 * main computed the report) and inside the Item log (where the desktop
 * view did). Every number here is an estimate; the disclaimer says so and
 * each tier badge carries where it came from.
 */
import { computed } from "vue";
import type { InspectMod, InspectReport } from "../../../shared/inspect.js";
import { formatAmount } from "../../utils/intelligence";

const props = defineProps<{
  report: InspectReport;
  /** Overlay mode: drop the parser notes and the requirements list. */
  compact?: boolean;
}>();

const emit = defineEmits<{ "open-link": [url: string] }>();

const item = computed(() => props.report.item);
const affixes = computed(() => props.report.affixes);

const rarityClass = computed(() => `rarity-${(item.value.rarity || "normal").toLowerCase()}`);

const KIND_BADGES: Record<string, { letter: string; title: string }> = {
  implicit: { letter: "I", title: "Implicit modifier" },
  rune: { letter: "R", title: "Socketed rune effect" },
  enchant: { letter: "E", title: "Enchantment" },
  desecrated: { letter: "D", title: "Desecrated modifier" },
  crafted: { letter: "C", title: "Crafted modifier" },
  fractured: { letter: "F", title: "Fractured modifier" },
  unique: { letter: "U", title: "Unique item modifier" },
};

function sideBadge(mod: InspectMod): { letter: string; title: string } {
  if (mod.side === "prefix") return { letter: "P", title: "Prefix" };
  if (mod.side === "suffix") return { letter: "S", title: "Suffix" };
  const known = KIND_BADGES[mod.kind];
  if (known) return known;
  return { letter: "?", title: "Side unknown — the plain copy does not say" };
}

function tierClass(mod: InspectMod): string {
  const rank = mod.tier?.rank;
  if (rank === 1) return "t1";
  if (rank === 2) return "t2";
  if (rank === 3) return "t3";
  return "t0";
}

function tierTitle(mod: InspectMod): string {
  const tier = mod.tier;
  if (!tier) return "No tier information for this modifier";
  const parts: string[] = [];
  // `tier.label` already reads "T3", so "Tier T3 of 3" said it twice.
  parts.push(tier.of !== undefined ? `${tier.label} of ${tier.of}` : `Tier ${tier.label}`);
  if (tier.requiredLevel !== undefined) parts.push(`needs item level ${tier.requiredLevel}`);
  if (tier.observations !== undefined) parts.push(`learned from ${tier.observations} listing(s)`);
  if (tier.source === "annotation") {
    parts.push("from the game's own advanced description");
    // The game's own number is matched to the learned ladder by value, so
    // the level and the observation count are only right if both number
    // tiers the same way round — which is still unverified.
    if (tier.requiredLevel !== undefined && !props.report.knowledge.tierDirection) {
      parts.push("matched to the learned ladder by number — the numbering direction is unverified");
    }
  }
  if (tier.source === "family") parts.push("hand thresholds");
  if (tier.note) parts.push(tier.note);
  return parts.join(" · ");
}

function rangeText(mod: InspectMod): string {
  if (!mod.range) return "";
  const source =
    mod.range.source === "advanced-text"
      ? "item text"
      : mod.range.source === "learned"
        ? "learned"
        : "printed range";
  return `(${formatAmount(mod.range.min)}–${formatAmount(mod.range.max)}, ${source})`;
}

function maxTierText(mod: InspectMod): string {
  const max = mod.maxTier;
  if (!max) return "";
  const level = item.value.itemLevel;
  const atLevel = level !== undefined ? `item level ${level}` : "this item level";
  // The point of the row: a better tier a higher-level base could hold.
  const next = max.next ? ` — ${max.next.label} from item level ${max.next.requiredLevel}` : "";
  if (max.reached) return `top tier for ${atLevel}${next}`;
  if (mod.tier?.rank === undefined) {
    // This roll has no rank of its own, so "you could do better" would be a
    // claim we cannot make; state what the level allows and stop there.
    const needs = max.requiredLevel !== undefined ? ` (needs item level ${max.requiredLevel})` : "";
    return `best tier at ${atLevel}: ${max.label}${needs}${next}`;
  }
  return max.requiredLevel !== undefined
    ? `${max.label} possible here (needs item level ${max.requiredLevel})${next}`
    : `${max.label} possible at this item level${next}`;
}

const affixLine = computed(() => {
  const summary = affixes.value;
  if (!item.value.identified) return "Unidentified — modifiers and tiers are hidden until it is identified.";
  // A unique has no affix budget at all (`affixLimitsFor` answers 0/0), so
  // printing "0/0 · 0 open" without saying why reads like a broken parse.
  if (/^unique$/i.test(item.value.rarity)) {
    return "Unique — its modifiers are fixed by the item, not rolled affixes.";
  }
  const head = `Prefixes ${summary.prefixes}/${summary.maxPrefixes} · Suffixes ${summary.suffixes}/${summary.maxSuffixes}`;
  if (summary.sealedReason) return `${head} · sealed: ${summary.sealedReason} — no open affixes`;
  const open = summary.open < 0 ? "open affixes unknown" : `${summary.open} open`;
  const unknown = summary.unknownSide > 0 ? ` · ${summary.unknownSide} of unknown side` : "";
  return `${head} · ${open}${unknown}`;
});

const SEVERITY_TONE: Record<string, string> = {
  deadly: "danger",
  dangerous: "danger",
  caution: "warning",
  info: "neutral",
  none: "safe",
};

function severityTone(severity: string): string {
  return SEVERITY_TONE[severity] ?? "neutral";
}

const overallMapLabel = computed(() => {
  const warnings = props.report.mapWarnings;
  if (!warnings) return "";
  if (warnings.overall === "none") return "No rated dangers";
  return `${warnings.overall[0]!.toUpperCase()}${warnings.overall.slice(1)}`;
});

const knowledgeLine = computed(() => {
  const knowledge = props.report.knowledge;
  const parts: string[] = [];
  if (knowledge.learnedTiers && knowledge.observations > 0) {
    parts.push(`Tiers: learned from ${formatAmount(knowledge.observations)} observations`);
  } else {
    parts.push("Tiers: hand thresholds — run a price check to learn real ranges");
  }
  parts.push(
    knowledge.statCatalogue
      ? `stat catalogue ${formatAmount(knowledge.catalogueEntries)} entries`
      : "stat catalogue unavailable",
  );
  parts.push(
    knowledge.tierDirection
      ? `tier numbering ${knowledge.tierDirection === "desc" ? "1 = best" : "highest = best"}`
      : "tier direction unknown",
  );
  return parts.join(" · ");
});

/**
 * Main strips the "at 20 % quality" fields when the user turns that
 * display off, so the column and its caption have to go with them —
 * otherwise the setting looks ignored and a third of the table is dashes.
 */
const showDefenceQuality20 = computed(
  () => props.report.defences?.entries.some((entry) => entry.atQuality20 !== undefined) ?? false,
);

/** A tablet's modifiers apply to the maps it covers, not to one waystone. */
const mapScopeNote = computed(() =>
  props.report.mapWarnings?.itemKind === "tablet"
    ? "These apply to every map in this tablet's range, not to one waystone."
    : "",
);

const requirementRows = computed(() => Object.entries(item.value.requirements ?? {}));
</script>

<template>
  <div class="inspect-card" :class="{ compact }">
    <header class="item-identity">
      <span class="eyebrow">{{ item.itemClass }}</span>
      <h2 :class="rarityClass">{{ item.name }}</h2>
      <p v-if="item.baseType && item.baseType !== item.name" class="muted">{{ item.baseType }}</p>
      <div class="identity-chips">
        <span class="pill">{{ item.rarity }}</span>
        <span v-if="item.itemLevel !== undefined" class="pill">iLvl {{ item.itemLevel }}</span>
        <span v-if="item.quality !== undefined" class="pill">Q {{ item.quality }}%</span>
        <span v-if="item.corrupted" class="pill danger">Corrupted</span>
        <span v-if="item.mirrored" class="pill danger">Mirrored</span>
        <span v-if="item.sanctified" class="pill warning">Sanctified</span>
        <span v-if="!item.identified" class="pill warning">Unidentified</span>
        <span class="pill">{{ report.textKind === "advanced" ? "advanced text" : "plain text" }}</span>
      </div>
    </header>

    <section class="inspect-affixes" aria-label="Affix budget">
      <p class="affix-summary">{{ affixLine }}</p>
      <p v-if="affixes.countedFrom === 'estimate' && item.identified" class="muted">
        Estimate — a plain copy carries no prefix/suffix information.
      </p>
    </section>

    <section class="inspect-mods" aria-label="Modifiers">
      <p v-if="!report.mods.length" class="empty-copy">No modifiers to show.</p>
      <ul v-else class="inspect-mod-list">
        <li v-for="mod in report.mods" :key="`${mod.index}-${mod.text}`" class="inspect-mod">
          <span class="side-badge" :title="sideBadge(mod).title">{{ sideBadge(mod).letter }}</span>
          <div class="mod-body">
            <div class="mod-head">
              <span v-if="mod.tier" class="mod-tier" :class="tierClass(mod)" :title="tierTitle(mod)">
                {{ mod.tier.label }}
              </span>
              <strong class="mod-text">{{ mod.text }}</strong>
            </div>
            <small v-if="mod.name || mod.tags.length" class="muted">
              {{ mod.name ? mod.name : "" }}
              <template v-if="mod.name && mod.tags.length"> · </template>
              {{ mod.tags.join(", ") }}
            </small>
            <div v-if="mod.rollPct !== undefined" class="roll-row">
              <div
                class="roll-track"
                role="meter"
                :aria-valuemin="0"
                :aria-valuemax="100"
                :aria-valuenow="mod.rollPct"
                :aria-label="`Roll quality for ${mod.text}`"
              >
                <span class="roll-fill" :class="{ reversed: mod.lowerIsBetter }" :style="{ width: `${mod.rollPct}%` }" />
              </div>
              <small class="muted">{{ rangeText(mod) }} · {{ mod.rollPct }} %</small>
            </div>
            <small v-else-if="mod.range" class="muted">{{ rangeText(mod) }}</small>
            <small v-if="mod.maxTier" class="muted max-tier">{{ maxTierText(mod) }}</small>
            <small v-if="mod.lowerIsBetter" class="muted">Lower is better for this modifier.</small>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="report.weapon" class="inspect-damage" aria-label="Damage">
      <h3>Damage</h3>
      <div class="table-scroll">
        <table class="inspect-table">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col" class="num">Per hit</th>
              <th scope="col" class="num">DPS</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(component, index) in report.weapon.components" :key="`${component.kind}-${index}`">
              <td>{{ component.kind }}</td>
              <td class="num">{{ formatAmount(component.average) }}</td>
              <td class="num">{{ formatAmount(component.dps) }}</td>
            </tr>
            <tr class="total-row">
              <td>total</td>
              <td class="num">—</td>
              <td class="num">{{ formatAmount(report.weapon.totalDps) }}</td>
            </tr>
            <tr v-if="report.weapon.atQuality20">
              <td>at 20 % quality (estimate)</td>
              <td class="num">—</td>
              <td class="num">{{ formatAmount(report.weapon.atQuality20.totalDps) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <dl class="property-list compact-list">
        <div>
          <dt>Attacks per second</dt>
          <dd>{{ formatAmount(report.weapon.aps) }}</dd>
        </div>
        <div v-if="report.weapon.critChance !== undefined">
          <dt>Critical hit chance</dt>
          <dd>{{ formatAmount(report.weapon.critChance) }} %</dd>
        </div>
        <div v-if="report.weapon.reloadTime !== undefined">
          <dt>Reload time</dt>
          <dd>{{ formatAmount(report.weapon.reloadTime) }} s</dd>
        </div>
      </dl>
      <ul v-if="report.weapon.notes.length" class="note-list">
        <li v-for="note in report.weapon.notes" :key="note" class="muted">{{ note }}</li>
      </ul>
    </section>

    <section v-if="report.defences && report.defences.entries.length" class="inspect-defences" aria-label="Defences">
      <h3>Defences</h3>
      <div class="table-scroll">
        <table class="inspect-table">
          <thead>
            <tr>
              <th scope="col">Defence</th>
              <th scope="col" class="num">Current</th>
              <th v-if="showDefenceQuality20" scope="col" class="num">At 20 % quality</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in report.defences.entries" :key="entry.name">
              <td>{{ entry.name }}</td>
              <td class="num">{{ formatAmount(entry.value) }}</td>
              <td v-if="showDefenceQuality20" class="num">
                {{ entry.atQuality20 !== undefined ? formatAmount(entry.atQuality20) : "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="report.defences.blockChance !== undefined" class="muted">
        Block chance {{ formatAmount(report.defences.blockChance) }} %
      </p>
      <p v-if="showDefenceQuality20" class="muted">
        Quality normalisation ignores local defence modifiers — an estimate.
      </p>
    </section>

    <section v-if="report.mapWarnings" class="inspect-map" aria-label="Map warnings">
      <h3>
        Map warnings
        <span class="status-chip" :class="severityTone(report.mapWarnings.overall)">{{ overallMapLabel }}</span>
      </h3>
      <p v-if="report.mapWarnings.tier !== undefined" class="muted">Waystone tier {{ report.mapWarnings.tier }}</p>
      <p v-if="mapScopeNote" class="muted">{{ mapScopeNote }}</p>
      <p v-if="!report.mapWarnings.warnings.length" class="empty-copy">Nothing on this map is rated dangerous.</p>
      <ul v-else class="map-warning-list">
        <li v-for="warning in report.mapWarnings.warnings" :key="warning.id">
          <span class="status-chip" :class="severityTone(warning.severity)">{{ warning.severity }}</span>
          <div>
            <strong>{{ warning.label }}</strong>
            <small class="muted">{{ warning.text }}</small>
            <small class="muted">{{ warning.reason }}</small>
            <small v-if="warning.overridden" class="muted">Rated by you in settings.</small>
          </div>
        </li>
      </ul>
      <dl v-if="report.mapWarnings.bonuses.length" class="property-list compact-list">
        <div v-for="bonus in report.mapWarnings.bonuses" :key="bonus.name">
          <dt>{{ bonus.name }}</dt>
          <dd>{{ bonus.value }}</dd>
        </div>
      </dl>
      <p v-if="report.mapWarnings.ignored" class="muted">
        {{ report.mapWarnings.ignored }} modifier(s) hidden by your overrides.
      </p>
      <details v-if="report.mapWarnings.unmatched.length" class="advanced-options">
        <summary>Not rated ({{ report.mapWarnings.unmatched.length }})</summary>
        <ul class="note-list">
          <li v-for="line in report.mapWarnings.unmatched" :key="line" class="muted">{{ line }}</li>
        </ul>
      </details>
      <p v-if="report.context?.atlasHint" class="inline-notice">{{ report.context.atlasHint }}</p>
      <p class="muted">Community-maintained ratings — verify the wording in game.</p>
    </section>

    <section v-if="report.appraisal" class="inspect-appraisal" aria-label="Local appraisal">
      <p class="muted">
        Local appraisal: value {{ report.appraisal.valueScore }} / 100 · confidence
        {{ report.appraisal.confidence }} ({{ report.appraisal.band }}, {{ report.appraisal.evidence }})
      </p>
      <p v-if="report.appraisal.craftHint" class="muted">{{ report.appraisal.craftHint }}</p>
    </section>

    <div v-if="report.links.length" class="button-row inspect-links">
      <button
        v-for="link in report.links"
        :key="link.id"
        type="button"
        class="button secondary compact"
        :title="link.url"
        @click="emit('open-link', link.url)"
      >
        {{ link.label }}
      </button>
      <span class="muted">opens in your browser</span>
    </div>

    <dl v-if="!compact && requirementRows.length" class="property-list compact-list">
      <div v-for="[name, value] in requirementRows" :key="name">
        <dt>{{ name }}</dt>
        <dd>{{ value }}</dd>
      </div>
    </dl>

    <p class="muted knowledge-line">{{ knowledgeLine }}</p>

    <details v-if="!compact && report.notes.length" class="advanced-options">
      <summary>Parser notes ({{ report.notes.length }})</summary>
      <ul class="note-list">
        <li v-for="note in report.notes" :key="note" class="muted">{{ note }}</li>
      </ul>
    </details>

    <p class="disclaimer">
      Tiers, ranges, DPS and map ratings are estimates from the item text and learned listings — never guarantees.
    </p>
  </div>
</template>

<style scoped>
.inspect-card {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.inspect-card h3 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}
.affix-summary {
  margin: 0;
  font-size: 0.82rem;
}
.inspect-mod-list,
.map-warning-list,
.note-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.note-list {
  gap: 0.25rem;
}
.inspect-mod {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.5rem;
  align-items: start;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.18);
}
.mod-body {
  display: flex;
  flex-direction: column;
  gap: 0.18rem;
  min-width: 0;
}
.mod-head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}
.mod-text {
  font-size: 0.84rem;
  line-height: 1.35;
}
.side-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 4px;
  border: 1px solid var(--line-strong, #3b424d);
  color: var(--text-soft, #b9b4aa);
  font-size: 0.7rem;
  font-weight: 700;
}
.mod-tier {
  display: inline-flex;
  align-items: center;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  border: 1px solid var(--line-strong, #3b424d);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.mod-tier.t1 {
  color: var(--gold-bright, #e4c587);
  border-color: var(--gold, #c8a66a);
}
.mod-tier.t2 {
  color: var(--blue, #79afc7);
}
.mod-tier.t3 {
  color: var(--text-soft, #b9b4aa);
}
.mod-tier.t0 {
  color: var(--text-muted, #888b8e);
}
.roll-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}
.roll-track {
  position: relative;
  flex: 1 1 120px;
  min-width: 90px;
  height: 5px;
  border-radius: 3px;
  background: rgba(140, 140, 160, 0.22);
  overflow: hidden;
}
.roll-fill {
  display: block;
  height: 100%;
  background: var(--gold, #c8a66a);
}
.roll-fill.reversed {
  background: var(--blue, #79afc7);
}
.max-tier {
  color: var(--text-soft, #b9b4aa);
}
.table-scroll {
  overflow-x: auto;
}
.inspect-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.inspect-table th,
.inspect-table td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.inspect-table th {
  text-transform: uppercase;
  font-size: 0.7rem;
  opacity: 0.7;
}
.inspect-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.total-row td {
  font-weight: 700;
}
.map-warning-list li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.5rem;
  align-items: start;
}
.map-warning-list li div {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.inspect-links {
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.knowledge-line {
  margin: 0;
}
</style>
