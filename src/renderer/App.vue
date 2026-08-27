<script setup lang="ts">
import { onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { useIntelligenceStore } from "./composables/useIntelligenceStore";
import { useRuntimeState } from "./composables/useRuntimeState";

const route = useRoute();
const router = useRouter();
const runtime = useRuntimeState();
const intelligence = useIntelligenceStore();

const navigation = [
  { to: "/items", label: "Items", short: "IT", detail: "Parse & value" },
  { to: "/finder", label: "Finder", short: "FD", detail: "Stash queries" },
  { to: "/builds", label: "Builds", short: "BL", detail: "Target coverage" },
  { to: "/rules", label: "Rules", short: "RL", detail: "Match logic" },
  { to: "/scans", label: "Scans", short: "SC", detail: "Session review" },
] as const;

onMounted(() => {
  void runtime.initializeRuntime();
  void intelligence.initializeIntelligence();
});

watch(intelligence.externalEvaluationVersion, () => {
  void router.push("/items");
});
</script>

<template>
  <a class="skip-link" href="#workspace">Skip to workspace</a>
  <div
    v-if="runtime.isNative.value"
    class="qa-banner"
    role="status"
    aria-live="polite"
  >
    <span>Automation on</span>
    <span>Stash transfers and scans can send input to Path of Exile</span>
    <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>Esc</kbd>
    <span>emergency stop</span>
  </div>

  <div class="app-shell" :class="{ 'has-qa-banner': runtime.isNative.value }">
    <aside class="side-rail" aria-label="Primary">
      <RouterLink class="brand" to="/items" aria-label="PoE2 Intelligence home">
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
        to="/tools/overview"
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
    </aside>

    <section class="app-stage">
      <header class="top-bar">
        <div class="page-heading">
          <span class="eyebrow">{{ route.meta.eyebrow }}</span>
          <h1>{{ route.meta.title }}</h1>
          <p>{{ route.meta.description }}</p>
        </div>

        <div class="safety-cluster" aria-label="Runtime safety status">
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
        <RouterView v-slot="{ Component }">
          <Transition name="route-fade" mode="out-in">
            <Suspense>
              <component :is="Component" :key="route.fullPath" />
              <template #fallback>
                <div class="card loading-card" aria-live="polite">
                  Loading workspace…
                </div>
              </template>
            </Suspense>
          </Transition>
        </RouterView>
      </main>
    </section>
  </div>
</template>
