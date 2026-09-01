<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { TierVerdict } from "@core/valueTiers";
import type { SaveValueTierConfigRequest, ValueTierConfigView } from "../../shared/ipc.js";
import { rendererApi } from "../services/rendererApi";

type BucketId = "keep" | "sell" | "dump";

interface EditableRule {
  name: string;
  regex: string;
}

const BUCKETS: Array<{ id: BucketId; label: string; hint: string; tone: string }> = [
  {
    id: "keep",
    label: "Keep — pull aside",
    hint: "High value: routes to the Review tab during sorting.",
    tone: "keep",
  },
  {
    id: "sell",
    label: "Sell — worth listing",
    hint: "Routes to the Sell tab (or Review when no Sell tab is set).",
    tone: "sell",
  },
  {
    id: "dump",
    label: "Dump — vendor trash",
    hint: "Routes to the Dump tab. Only explicit rules ever dump an item.",
    tone: "dump",
  },
];

const loading = ref(true);
const saving = ref(false);
const message = ref("");
const error = ref("");
const rules = ref<Record<BucketId, EditableRule[]>>({ keep: [], sell: [], dump: [] });
const keepAtOrAbove = ref(5);
const sellAtOrAbove = ref(0.5);
const reviewTab = ref("Review");
const dumpTab = ref("Dump");
const sellTab = ref("");
const minDetourConfidence = ref(55);

const testText = ref("");
const testVerdict = ref<TierVerdict | null>(null);

let unsubscribe: (() => void) | undefined;

function applyConfig(config: ValueTierConfigView): void {
  rules.value = {
    keep: config.rules.keep.map((rule) => ({ name: rule.name ?? "", regex: rule.regex })),
    sell: config.rules.sell.map((rule) => ({ name: rule.name ?? "", regex: rule.regex })),
    dump: config.rules.dump.map((rule) => ({ name: rule.name ?? "", regex: rule.regex })),
  };
  keepAtOrAbove.value = config.thresholds.keepAtOrAbove;
  sellAtOrAbove.value = config.thresholds.sellAtOrAbove;
  reviewTab.value = config.routing.reviewTab;
  dumpTab.value = config.routing.dumpTab;
  sellTab.value = config.routing.sellTab ?? "";
  minDetourConfidence.value = config.minDetourConfidence ?? 55;
}

onMounted(async () => {
  try {
    applyConfig(await rendererApi.intelligence.tiers.get());
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Value tiers could not be loaded.";
  } finally {
    loading.value = false;
  }
  unsubscribe = rendererApi.intelligence.tiers.onChanged(applyConfig);
});

onBeforeUnmount(() => unsubscribe?.());

function addRule(bucket: BucketId): void {
  rules.value[bucket] = [...rules.value[bucket], { name: "", regex: "" }];
}

function removeRule(bucket: BucketId, index: number): void {
  rules.value[bucket] = rules.value[bucket].filter((_, i) => i !== index);
}

function buildRequest(): SaveValueTierConfigRequest {
  const toRules = (bucket: BucketId) =>
    rules.value[bucket]
      .filter((rule) => rule.regex.trim())
      .map((rule) => ({
        regex: rule.regex.trim(),
        ...(rule.name.trim() ? { name: rule.name.trim() } : {}),
      }));
  return {
    rules: { keep: toRules("keep"), sell: toRules("sell"), dump: toRules("dump") },
    thresholds: {
      keepAtOrAbove: Number(keepAtOrAbove.value) || 0,
      sellAtOrAbove: Number(sellAtOrAbove.value) || 0,
    },
    routing: {
      reviewTab: reviewTab.value.trim() || "Review",
      dumpTab: dumpTab.value.trim() || "Dump",
      ...(sellTab.value.trim() ? { sellTab: sellTab.value.trim() } : {}),
    },
    minDetourConfidence: Math.max(0, Math.min(100, Number(minDetourConfidence.value) || 55)),
  };
}

async function save(): Promise<void> {
  saving.value = true;
  message.value = "";
  error.value = "";
  try {
    applyConfig(await rendererApi.intelligence.tiers.save(buildRequest()));
    message.value = "Tiers saved. Sorting picks them up on its next run.";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Saving the tiers failed.";
  } finally {
    saving.value = false;
  }
}

async function testItem(): Promise<void> {
  error.value = "";
  testVerdict.value = null;
  try {
    testVerdict.value = await rendererApi.intelligence.tiers.evaluate(testText.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Tier evaluation failed.";
  }
}
</script>

<template>
  <section class="card tier-editor" aria-labelledby="tier-editor-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Triage logic</span>
        <h2 id="tier-editor-title">Value tiers</h2>
      </div>
    </div>
    <p class="muted">
      During sorting, every bag item is read and matched against these buckets:
      keep and sell items detour to their tabs, dump items go to the Dump tab,
      and everything else files normally. Rules use the same syntax as scan
      rules — quoted terms AND, <code>|</code> for OR, plus
      <code>"ANY_RESIST &gt;= n"</code> and <code>"TOTAL_ELE_RES &gt;= n"</code>.
      Unidentified or unreadable items are never dumped.
    </p>

    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading value tiers…</p>
    </div>

    <template v-else>
      <div v-for="bucket in BUCKETS" :key="bucket.id" class="tier-bucket" :class="bucket.tone">
        <div class="bucket-heading">
          <strong>{{ bucket.label }}</strong>
          <small>{{ bucket.hint }}</small>
        </div>
        <div
          v-for="(rule, index) in rules[bucket.id]"
          :key="`${bucket.id}-${index}`"
          class="tier-rule"
        >
          <input
            v-model="rule.name"
            type="text"
            placeholder="Rule name"
            :aria-label="`${bucket.label} rule ${index + 1} name`"
          />
          <input
            v-model="rule.regex"
            type="text"
            spellcheck="false"
            placeholder='"maximum Life" "ANY_RESIST >= 2"'
            :aria-label="`${bucket.label} rule ${index + 1} expression`"
          />
          <button
            type="button"
            class="icon-button"
            :aria-label="`Remove ${bucket.label} rule ${index + 1}`"
            @click="removeRule(bucket.id, index)"
          >
            ×
          </button>
        </div>
        <button type="button" class="button compact secondary" @click="addRule(bucket.id)">
          + rule
        </button>
      </div>

      <div class="form-grid compact-grid">
        <label>
          Keep at ≥ (price table value)
          <input v-model.number="keepAtOrAbove" type="number" min="0" step="0.5" />
        </label>
        <label>
          Sell at ≥
          <input v-model.number="sellAtOrAbove" type="number" min="0" step="0.5" />
        </label>
        <label>
          Min. confidence to detour (%)
          <input v-model.number="minDetourConfidence" type="number" min="0" max="100" step="5" />
        </label>
      </div>
      <p class="muted">
        During sorting, an item only detours to a triage tab when its appraisal
        confidence meets the bar above — raise it and only near-certain finds
        get pulled aside; lower it and more maybes reach the Review tab.
      </p>
      <div class="form-grid compact-grid">
        <label>
          Review tab
          <input v-model="reviewTab" type="text" />
        </label>
        <label>
          Dump tab
          <input v-model="dumpTab" type="text" />
        </label>
        <label>
          Sell tab <span class="optional">(optional)</span>
          <input v-model="sellTab" type="text" placeholder="defaults to Review" />
        </label>
      </div>
      <p class="muted">
        The routing tabs must exist inside the Gear folder; an unreachable tab
        simply leaves those items in the normal flow.
      </p>

      <div class="button-row">
        <button type="button" class="button primary" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save tiers" }}
        </button>
        <span v-if="message" class="success-text" role="status">{{ message }}</span>
        <span v-if="error" class="danger-text" role="alert">{{ error }}</span>
      </div>

      <details class="tier-tester">
        <summary>Test an item against the tiers</summary>
        <textarea
          v-model="testText"
          rows="6"
          spellcheck="false"
          placeholder="Item Class: Rings&#10;Rarity: Rare&#10;…"
        />
        <div class="button-row">
          <button
            type="button"
            class="button secondary compact"
            :disabled="!testText.trim()"
            @click="testItem"
          >
            Evaluate tier
          </button>
        </div>
        <div v-if="testVerdict" class="tier-verdict" :class="testVerdict.tier">
          <strong>{{ testVerdict.tier }}</strong>
          <small>via {{ testVerdict.source }}</small>
          <span v-if="testVerdict.appraisal" class="verdict-metrics">
            score <strong>{{ testVerdict.appraisal.valueScore }}</strong>/100 ·
            confidence <strong>{{ testVerdict.appraisal.confidence }}</strong>%
            ({{ testVerdict.appraisal.band.replace("-", " ") }})
            <template v-if="testVerdict.appraisal.estimatedValue">
              · ≈ {{ testVerdict.appraisal.estimatedValue.amount }}
              {{ testVerdict.appraisal.estimatedValue.currency }}
            </template>
          </span>
          <ul>
            <li v-for="reason in testVerdict.reasons" :key="reason">{{ reason }}</li>
          </ul>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.tier-editor { display: flex; flex-direction: column; gap: 0.9rem; }
.tier-bucket { border: 1px solid rgba(140, 140, 160, 0.25); border-left-width: 4px; border-radius: 0.5rem; padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.5rem; }
.tier-bucket.keep { border-left-color: #4fa84f; }
.tier-bucket.sell { border-left-color: #c9a227; }
.tier-bucket.dump { border-left-color: #b35050; }
.bucket-heading { display: flex; flex-direction: column; gap: 0.15rem; }
.bucket-heading small { opacity: 0.7; }
.tier-rule { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(12rem, 2fr) auto; gap: 0.4rem; align-items: center; }
.tier-tester { display: flex; flex-direction: column; gap: 0.5rem; }
.tier-tester textarea { width: 100%; margin-top: 0.5rem; }
.tier-verdict { border-radius: 0.5rem; padding: 0.6rem 0.8rem; border: 1px solid rgba(140, 140, 160, 0.3); }
.tier-verdict.keep { border-color: #4fa84f; }
.tier-verdict.sell { border-color: #c9a227; }
.tier-verdict.dump { border-color: #b35050; }
.tier-verdict small { margin-left: 0.5rem; opacity: 0.7; }
.verdict-metrics { display: block; margin-top: 0.25rem; font-size: 0.85em; opacity: 0.85; }
.tier-verdict ul { margin: 0.35rem 0 0; padding-left: 1.1rem; }
</style>
