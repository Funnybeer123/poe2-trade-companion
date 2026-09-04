<script setup lang="ts">
import { onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import GameActionRail from "./components/GameActionRail.vue";
import { useGameActions } from "./composables/useGameActions";
import { useIntelligenceStore } from "./composables/useIntelligenceStore";
import { useRuntimeState } from "./composables/useRuntimeState";

const route = useRoute();
const router = useRouter();
const runtime = useRuntimeState();
const intelligence = useIntelligenceStore();
const gameActions = useGameActions();

const navigation = [
  { to: "/sort", label: "Sort", short: "SO", detail: "Run & triage" },
  { to: "/shop", label: "Shop", short: "SH", detail: "Listings & sales" },
  { to: "/items", label: "Item log", short: "IT", detail: "Parse & review" },
  { to: "/search", label: "Search", short: "SR", detail: "Queries & rules" },
  { to: "/builds", label: "Builds", short: "BL", detail: "Target coverage" },
] as const;

onMounted(() => {
  void runtime.initializeRuntime();
  void intelligence.initializeIntelligence();
  void gameActions.initializeGameActions();
});

watch(intelligence.externalEvaluationVersion, () => {
  void router.push("/items");
});
</script>

<template>
  <a class="skip-link" href="#workspace">Skip to workspace</a>
  <div class="app-shell">
    <aside class="side-rail" aria-label="Primary">
      <RouterLink class="brand" to="/sort" aria-label="PoE2 Intelligence home">
        <span class="brand-mark" aria-hidden="true">II</span>
        <span class="brand-copy">
          <strong>Item Intelligence</strong>
          <small>Path of Exile 2</small>
        </span>
      </RouterLink>

      <nav class="primary-nav">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="nav-link"
        >
          <span class="nav-glyph" aria-hidden="true">{{ item.short }}</span>
          <span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.detail }}</small>
          </span>
        </RouterLink>
      </nav>

      <div class="rail-spacer" />

      <RouterLink
        to="/tools"
        class="nav-link tools-link"
        :class="{ 'section-active': route.path.startsWith('/tools') }"
      >
        <span class="nav-glyph" aria-hidden="true">QA</span>
        <span>
          <strong>Tools &amp; QA</strong>
          <small>Operate &amp; diagnose</small>
        </span>
      </RouterLink>

      <div class="rail-status">
        <span
          class="presence-dot"
          :class="{ online: runtime.targetDetected.value }"
          aria-hidden="true"
        />
        <span>
          <strong>{{
            runtime.isNative.value
              ? runtime.targetDetected.value
                ? "Client detected"
                : "Client not detected"
              : "Browser preview"
          }}</strong>
          <small>{{
            runtime.isNative.value ? runtime.mode.value : "Zero-input fallback"
          }}</small>
        </span>
      </div>

      <GameActionRail />
    </aside>

    <section class="app-stage">
      <header class="top-bar">
        <div class="page-heading">
          <span class="eyebrow">{{ route.meta.eyebrow }}</span>
          <h1>{{ route.meta.title }}</h1>
          <p>{{ route.meta.description }}</p>
        </div>

        <div class="safety-cluster" aria-label="Runtime safety status">
          <label
            class="dry-run-switch"
            title="One switch for every game action: on means plan, overlay, and trace only — no input is ever sent."
          >
            <input v-model="gameActions.dryRun.value" type="checkbox" role="switch" />
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb" /></span>
            <span class="switch-copy">Dry-run</span>
          </label>
          <span
            v-if="!runtime.isNative.value"
            class="status-chip neutral"
            title="Browser preview uses local fixture evaluation and never generates game input."
          >
            Preview · no input
          </span>
          <span
            v-else-if="!runtime.killLatched.value"
            class="status-chip warning"
          >
            E-stop ready · Ctrl+Shift+Esc
          </span>
          <span v-else class="status-chip danger">Emergency stop latched</span>
          <button
            v-if="runtime.killLatched.value"
            type="button"
            class="button compact danger"
            @click="runtime.rearm"
          >
            Re-arm input
          </button>
        </div>
      </header>

      <p v-if="runtime.error.value" class="shell-alert" role="alert">
        {{ runtime.error.value }}
      </p>

      <main id="workspace" class="workspace" tabindex="-1">
        <!-- No Vue Transition here: out-in mode strands the outgoing view when
             a second navigation interrupts an in-flight fade (leave never
             completes). The route-enter CSS animation on the keyed child gives
             the same polish with no JS-managed phases to get stuck. -->
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="route.path" class="route-enter" />
        </RouterView>
      </main>
    </section>
  </div>
</template>
