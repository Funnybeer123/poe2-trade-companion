<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { defaultCombatConfig, isSkillModule, type CombatModule } from "../../core/combatAssist.js";
import ActionIcon from "../components/ActionIcon.vue";
import { useCombatControls } from "../composables/useCombatControls";
import { useDashboardActions } from "../composables/useDashboardActions";
import { useGameActions } from "../composables/useGameActions";
import { useRuntimeState } from "../composables/useRuntimeState";

const runtime = useRuntimeState();
const game = useGameActions();
const combat = useCombatControls();
const operations = useDashboardActions();
const { state, pending: combatPending, loading: combatLoading, error: combatError, readiness } = combat;
const { scriptStatus, pending: operationPending, loading: operationLoading, error: operationError, voiceActive } = operations;
const { dryRun, busy, canStartEmpty, canStartFill, canStartSort, actionError, railStatus } = game;
const config = computed(() => state.value?.config ?? defaultCombatConfig());
const otherActionActive = computed(() => busy.value || scriptStatus.value.running || voiceActive.value || operationPending.value);
const inputBlocked = computed(() => !runtime.isNative.value || runtime.killLatched.value);
const stashBlocked = computed(() => inputBlocked.value || scriptStatus.value.running || voiceActive.value || operationPending.value || operationLoading.value);
const combatStartReason = computed(() => {
  if (runtime.killLatched.value) return "Re-arm input from the top bar to continue.";
  if (otherActionActive.value) return "Finish the active stash action before starting combat.";
  if (dryRun.value && !config.value.dryRun) return "Dry-run is on. Select Preview only in combat settings, or turn Dry-run off to start live combat.";
  if (!runtime.targetDetected.value && runtime.isNative.value) return "Open Path of Exile 2 to start combat.";
  return readiness.value;
});
const combatMode = computed(() => state.value?.running ? (config.value.sigilSequence.enabled ? (config.value.dryRun ? "Preview armed" : "Armed") : state.value.config.dryRun ? "Previewing" : "Running") : "Paused");
const modules = computed<{ id: CombatModule; title: string; subtitle: string }[]>(() => [
  { id: "health", title: "Health flask", subtitle: "Recover life automatically" },
  { id: "mana", title: "Mana flask", subtitle: "Keep your mana topped up" },
  { id: "unleash", title: config.value.sigilSequence.enabled ? "Sigil of Power" : "Unleash", subtitle: config.value.sigilSequence.enabled ? `Press ${config.value.unleash.key} → ${config.value.sigilSequence.swapKey} → ${config.value.verisium.key} · one cycle` : "Cast as soon as it is ready" },
  { id: "verisium", title: "Powered by Verisium", subtitle: config.value.sigilSequence.enabled ? "Tapped once after your macro's weapon swap" : "Cast as soon as it is ready" },
]);
const workflows = [
  { id: "gear-sort", icon: "sort", title: "Sort gear", description: "Route items to their tabs using your value tiers.", to: "/sort", setup: "Tiers & routing" },
  { id: "craft", icon: "craft", title: "Craft gear", description: "Run your configured crafting workflow.", to: "/sort", setup: "Crafting setup" },
  { id: "shop-scan", icon: "scan", title: "Scan shop", description: "Read listings and reconcile your sales ledger.", to: "/shop", setup: "Listings & repricing" },
  { id: "shop-list", icon: "shop", title: "List inventory", description: "Price bag items and move them to bucket tabs.", to: "/shop", setup: "Shop settings" },
] as const;

function keyLabel(key: string): string { return key === "MOUSE5" ? "Mouse 5" : key; }
function moduleStatus(name: CombatModule): string {
  if (!state.value) return combatLoading.value ? "Loading…" : "Desktop app required";
  if (!config.value[name].enabled) return "Off";
  if (config.value.sigilSequence.enabled && isSkillModule(name)) {
    if (!state.value.running) return "Macro enabled · paused";
    return name === "unleash" ? `Armed · press ${config.value.unleash.key}` : "Part of manual macro";
  }
  if (!config.value.regions[name] || !config.value.regions.anchor || (isSkillModule(name) && !config.value.regions[name]?.cooldown)) return "Needs calibration";
  if (!state.value.running) return "Enabled · paused";
  if (!state.value.reading?.valid) return "Waiting for game HUD";
  if (isSkillModule(name)) {
    const skill = state.value.reading[name];
    return skill === "cooldown" ? "On cooldown" : skill === "ready" ? "Ready to cast" : "Reading skill…";
  }
  const value = state.value.reading[name];
  return value === undefined ? "Reading HUD…" : `${value}% ${name === "health" ? "life" : "mana"}`;
}
</script>

<template>
  <div class="action-dashboard">
    <section class="dashboard-combat" aria-labelledby="combat-quick-title">
      <header class="dashboard-section-heading combat-heading">
        <div>
          <div class="dashboard-kicker">{{ config.sigilSequence.enabled ? 'ON DEMAND MACRO' : 'AUTOMATIC' }}</div>
          <h2 id="combat-quick-title">Combat assist <span class="dashboard-badge" :class="{ active: state?.running }"><i />{{ combatMode }}</span></h2>
          <p>{{ config.sigilSequence.enabled ? `Press ${config.unleash.key} for one macro cycle. F8 arms or pauses.` : 'Your flasks and cooldowns, handled.' }}</p>
        </div>
        <div class="dashboard-combat-actions">
          <RouterLink class="dashboard-text-link" to="/tools/combat"><ActionIcon name="settings" :size="16" />Calibrate & configure</RouterLink>
          <button class="dashboard-button" :class="state?.running ? 'secondary' : 'accent'" :disabled="combatPending || combatLoading || !combat.available || (!state?.running && Boolean(combatStartReason))" :title="state?.running ? 'Pause all combat features' : combatStartReason" @click="state?.running ? combat.stop() : combat.start()">
            <ActionIcon :name="state?.running ? 'pause' : 'play'" :size="16" />{{ combatPending ? 'Updating…' : state?.running ? 'Pause combat' : config.sigilSequence.enabled ? 'Arm macro' : 'Start combat' }}
          </button>
        </div>
      </header>

      <div class="combat-quick-grid">
        <article v-for="module in modules" :key="module.id" class="combat-quick-card" :class="module.id" :aria-labelledby="`quick-${module.id}`">
          <div class="combat-card-top">
            <span class="dashboard-icon combat-icon"><ActionIcon :name="module.id" :size="22" /></span>
            <button class="dashboard-toggle" type="button" role="switch" :aria-label="`Enable ${module.title}`" :aria-checked="config[module.id].enabled" :disabled="!combat.available || combatLoading || combatPending || otherActionActive || (config.sigilSequence.enabled && isSkillModule(module.id))" :title="config.sigilSequence.enabled && isSkillModule(module.id) ? 'Controlled by Manual Sigil macro in combat settings' : undefined" @click="combat.toggleModule(module.id)"><span /></button>
          </div>
          <h3 :id="`quick-${module.id}`">{{ module.title }} <kbd>{{ keyLabel(config[module.id].key) }}</kbd></h3>
          <p>{{ isSkillModule(module.id) ? module.subtitle : `Use below ${config[module.id].threshold}% ${module.id === 'health' ? 'life' : 'mana'}` }}</p>
          <div class="combat-card-status" :class="{ enabled: config[module.id].enabled }"><i />{{ moduleStatus(module.id) }}</div>
        </article>
      </div>

      <div class="combat-quick-footer">
        <span v-if="combatError" class="dashboard-error" role="alert">{{ combatError }}</span>
        <span v-else-if="combatLoading">Loading saved combat settings…</span>
        <span v-else-if="!state?.running && combatStartReason">{{ combatStartReason }}</span>
        <span v-else-if="state?.running">{{ state.reason }}<span v-if="state.cycleMs !== undefined"> · {{ Math.round(state.cycleMs) }} ms last check</span></span>
        <span v-else>{{ state?.reason && state.reason !== 'Stopped' ? state.reason : 'Enable the features you want, then start combat.' }}</span>
        <span class="dashboard-shortcut"><kbd>F8</kbd> {{ config.sigilSequence.enabled ? 'Arm / pause' : 'Pause / resume' }}</span>
      </div>
    </section>

    <section class="dashboard-stash" aria-labelledby="stash-quick-title">
      <header class="dashboard-section-heading">
        <div><div class="dashboard-kicker">ON DEMAND</div><h2 id="stash-quick-title">Stash actions</h2></div>
        <RouterLink class="dashboard-text-link" to="/tools/transfers">Transfer settings <ActionIcon name="arrow" :size="16" /></RouterLink>
      </header>
      <div class="stash-quick-grid">
        <button class="stash-quick-action" :disabled="stashBlocked || !canStartEmpty" :title="game.transferBlockReason()" @click="game.startAssistive({ kind: 'empty' })"><ActionIcon name="down" /><span><strong>Empty inventory</strong><small>Bag → stash</small></span><ActionIcon name="arrow" :size="16" /></button>
        <button class="stash-quick-action" :disabled="stashBlocked || !canStartFill" :title="game.transferBlockReason()" @click="game.startAssistive({ kind: 'fill' })"><ActionIcon name="up" /><span><strong>Fill inventory</strong><small>Stash → bag</small></span><ActionIcon name="arrow" :size="16" /></button>
        <button class="stash-quick-action" :disabled="stashBlocked || !canStartFill" :title="game.transferBlockReason()" @click="game.startAssistive({ kind: 'two-cycle' })"><ActionIcon name="repeat" /><span><strong>Two-cycle transfer</strong><small>Fill, then empty</small></span><ActionIcon name="arrow" :size="16" /></button>
        <button class="stash-quick-action" :disabled="stashBlocked || !canStartSort" :title="game.sortBlockReason()" @click="game.sortStash()"><ActionIcon name="dashboard" /><span><strong>{{ dryRun ? 'Preview stash sort' : 'Sort stash' }}</strong><small>Organize the open tab</small></span><ActionIcon name="arrow" :size="16" /></button>
      </div>
      <div class="dashboard-status-line">
        <span v-if="actionError" class="dashboard-error" role="alert">{{ actionError }}</span>
        <span v-else-if="stashBlocked && scriptStatus.running">{{ scriptStatus.phase }} is running. Stash actions are paused.</span>
        <span v-else>{{ railStatus }}</span>
        <button v-if="game.canStop.value" class="dashboard-text-button danger" @click="game.stopGameActions()">Stop stash action</button>
        <RouterLink v-else-if="!game.gridsReady.value && runtime.isNative.value" class="dashboard-text-link" to="/tools/calibration">Set up grids <ActionIcon name="arrow" :size="14" /></RouterLink>
        <span v-else class="dashboard-mode-note">{{ dryRun ? 'Dry-run · preview actions' : 'Open your stash before running' }}</span>
      </div>
    </section>

    <section aria-labelledby="workflows-title">
      <header class="dashboard-section-heading">
        <div><div class="dashboard-kicker">WORKFLOWS</div><h2 id="workflows-title">Organize, craft & sell</h2></div>
        <div v-if="scriptStatus.running" class="dashboard-running-operation"><span class="dashboard-badge active"><i />{{ scriptStatus.phase }}</span><button class="dashboard-text-button danger" @click="operations.stopScripts()">Stop workflow</button></div>
        <span v-else class="dashboard-mode-note">{{ dryRun ? 'Preview mode' : 'Uses your saved settings' }}</span>
      </header>
      <div class="dashboard-workflow-grid">
        <article v-for="workflow in workflows" :key="workflow.id" class="dashboard-workflow-card">
          <span class="dashboard-icon"><ActionIcon :name="workflow.icon" /></span>
          <h3>{{ workflow.title }}</h3>
          <p>{{ workflow.description }}</p>
          <div class="workflow-card-actions">
            <button class="dashboard-button secondary" :disabled="!operations.canRunScript(workflow.id)" :title="operations.scriptBlockReason(workflow.id)" @click="operations.runScript(workflow.id)">{{ dryRun ? 'Preview' : 'Run' }}<ActionIcon name="arrow" :size="15" /></button>
            <RouterLink class="dashboard-text-link" :to="workflow.to">{{ workflow.setup }}</RouterLink>
          </div>
        </article>
      </div>
      <p v-if="operationError" class="dashboard-error operation-notice" role="alert">{{ operationError }}</p>
      <p v-else-if="operationLoading" class="operation-notice">Checking workflow settings…</p>
      <p v-else-if="operations.scriptBlockReason('gear-sort')" class="operation-notice">{{ operations.scriptBlockReason('gear-sort') }}</p>
      <p v-else-if="!operations.shopConfigured.value" class="operation-notice">Set your shop tab in <RouterLink to="/shop">Shop settings</RouterLink> to enable selling actions.</p>
    </section>

    <section class="dashboard-utilities" aria-label="More game tools">
      <div class="dashboard-utility voice-utility">
        <ActionIcon name="voice" /><div><strong>Voice transfer</strong><small>{{ voiceActive ? 'Listening / processing' : 'Speak a stash command' }}</small></div>
        <button class="dashboard-text-button" :disabled="!voiceActive && !operations.canListen.value" :title="operations.voiceBlockReason()" @click="voiceActive ? operations.cancelVoice() : operations.listenOnce()">{{ voiceActive ? 'Cancel' : 'Listen' }}</button>
        <RouterLink class="utility-settings" to="/tools/transfers" aria-label="Voice transfer settings"><ActionIcon name="settings" :size="16" /></RouterLink>
      </div>
      <RouterLink class="dashboard-utility" to="/items#scans"><ActionIcon name="scan" /><div><strong>Scan stash items</strong><small>Rules, scans & results</small></div><ActionIcon name="arrow" :size="16" /></RouterLink>
      <RouterLink class="dashboard-utility" to="/tools/stash-tabs"><ActionIcon name="builds" /><div><strong>Manage stash tabs</strong><small>Rename, organize & recolor</small></div><ActionIcon name="arrow" :size="16" /></RouterLink>
      <RouterLink class="dashboard-utility" to="/tools/hotkeys"><ActionIcon name="settings" /><div><strong>Game hotkeys</strong><small>Bindings & numpad actions</small></div><ActionIcon name="arrow" :size="16" /></RouterLink>
    </section>
  </div>
</template>

<style scoped>
.action-dashboard { --dash-accent: #bad3ad; --dash-muted: #9b9eaa; max-width: 1520px; margin: 0 auto; display: grid; gap: 30px; padding: 2px 0 12px; }
.dashboard-section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 16px; }
.dashboard-section-heading h2 { display: flex; align-items: center; gap: 12px; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.4px; }
.dashboard-section-heading p { margin: 7px 0 0; color: var(--dash-muted); font-size: 13px; }
.dashboard-kicker { margin-bottom: 7px; color: var(--dash-muted); font-size: 10px; letter-spacing: 1.6px; font-weight: 600; }
.dashboard-combat { padding: 24px; border: 1px solid #333b38; border-radius: 16px; background: radial-gradient(ellipse at 85% 0, #bad3ad08, transparent 60%), #14171b; }
.dashboard-combat-actions { display: flex; align-items: center; gap: 20px; }
.dashboard-badge { display: inline-flex; align-items: center; gap: 6px; width: fit-content; border: 1px solid #383c42; border-radius: 6px; padding: 4px 8px; color: #aeb1bb; background: #202329; font-size: 10px; font-weight: 500; letter-spacing: .15px; }
.dashboard-badge i, .combat-card-status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.dashboard-badge.active { border-color: #bad3ad30; background: #bad3ad0c; color: var(--dash-accent); }
.dashboard-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid transparent; border-radius: 8px; padding: 9px 13px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s; }
.dashboard-button.accent { color: #1c291a; background: var(--dash-accent); }
.dashboard-button.accent:hover:not(:disabled) { background: #cee4c2; }
.dashboard-button.secondary { color: #d6d9e1; border-color: #363b44; background: #242830; }
.dashboard-button.secondary:hover:not(:disabled) { background: #303640; border-color: #565e6a; }
.dashboard-button:disabled, .stash-quick-action:disabled, .dashboard-toggle:disabled, .dashboard-text-button:disabled { opacity: .42; cursor: not-allowed; }
.dashboard-text-link, .dashboard-text-button { display: inline-flex; align-items: center; gap: 7px; color: #adb4bc; font-size: 12px; white-space: nowrap; }
.dashboard-text-link:hover, .dashboard-text-button:hover:not(:disabled) { color: #e4ebdf; }
.dashboard-text-button { border: 0; background: transparent; padding: 4px 0; cursor: pointer; }
.dashboard-text-button.danger, .dashboard-error { color: #f0a69e; }
.combat-quick-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.combat-quick-card { --module-color: #e59996; --module-bg: #e599960e; padding: 18px 20px 15px; border: 1px solid #353137; border-radius: 11px; background: linear-gradient(125deg, var(--module-bg), transparent 85%), #181b20; }
.combat-quick-card.mana { --module-color: #88b6eb; --module-bg: #88b6eb0e; border-color: #2c3541; }
.combat-quick-card.unleash { --module-color: #c1a8ea; --module-bg: #c1a8ea0e; border-color: #35303f; }
.combat-quick-card.verisium { --module-color: #86d3e6; --module-bg: #86d3e60e; border-color: #2c3d43; }
.combat-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 17px; }
.dashboard-icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 1px solid #393e45; border-radius: 9px; color: #bfc4cc; background: #252930; }
.combat-icon { color: var(--module-color); border-color: color-mix(in srgb, var(--module-color) 24%, transparent); background: color-mix(in srgb, var(--module-color) 8%, transparent); }
.combat-quick-card h3 { display: flex; align-items: center; gap: 10px; margin: 0 0 7px; font-size: 16px; font-weight: 600; letter-spacing: -.15px; }
.combat-quick-card kbd { margin-left: auto; height: 23px; min-width: 27px; padding: 0 7px; font-size: 10px; font-weight: 500; color: #bfc1cd; border: 1px solid #ffffff16; background: #0d101536; border-radius: 5px; }
.combat-quick-card p { margin: 0; font-size: 12px; color: var(--dash-muted); }
.combat-card-status { display: flex; align-items: center; gap: 7px; margin-top: 20px; font-size: 11px; color: #9397a3; }
.combat-card-status.enabled { color: var(--module-color); }
.dashboard-toggle { width: 35px; height: 21px; padding: 3px; border: 1px solid #4a4c56; border-radius: 99px; background: #343640; cursor: pointer; }
.dashboard-toggle span { display: block; width: 13px; height: 13px; border-radius: 50%; background: #a2a3ae; transition: transform .15s; }
.dashboard-toggle[aria-checked='true'] { border-color: var(--dash-accent); background: var(--dash-accent); }
.dashboard-toggle[aria-checked='true'] span { transform: translateX(13px); background: #243120; }
.combat-quick-footer { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-top: 17px; color: var(--dash-muted); font-size: 11px; min-height: 23px; }
.dashboard-shortcut { display: inline-flex; gap: 8px; align-items: center; white-space: nowrap; }
.dashboard-shortcut kbd { color: #aeb5bb; border-color: #343a41; font-weight: 400; background: transparent; }
.stash-quick-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.stash-quick-action { display: flex; align-items: center; gap: 13px; min-height: 83px; padding: 15px 17px; border: 1px solid #30363e; border-radius: 10px; text-align: left; background: #171b20; color: #b6c8b0; cursor: pointer; }
.stash-quick-action:hover:not(:disabled) { border-color: #65745e; background: #1e2522; }
.stash-quick-action > svg:first-child { flex-shrink: 0; }
.stash-quick-action > svg:last-child { margin-left: auto; color: #7b8482; }
.stash-quick-action span { display: grid; gap: 5px; }
.stash-quick-action strong { font-size: 12px; font-weight: 550; }
.stash-quick-action small { font-size: 11px; color: var(--dash-muted); }
.dashboard-status-line { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-top: 12px; font-size: 11px; color: var(--dash-muted); }
.dashboard-mode-note { font-size: 11px; color: var(--dash-muted); }
.dashboard-running-operation { display: flex; align-items: center; gap: 14px; }
.dashboard-workflow-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.dashboard-workflow-card { display: flex; flex-direction: column; padding: 20px; border: 1px solid #2d333c; border-radius: 11px; background: #15191e; }
.dashboard-workflow-card h3 { margin: 17px 0 7px; font-size: 15px; font-weight: 600; }
.dashboard-workflow-card p { flex: 1; margin: 0 0 23px; color: var(--dash-muted); font-size: 12px; max-width: 240px; }
.workflow-card-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.workflow-card-actions .dashboard-text-link { font-size: 11px; }
.workflow-card-actions .dashboard-button { padding: 7px 10px; font-size: 11px; }
.operation-notice { margin: 10px 0 0; color: var(--dash-muted); font-size: 11px; }
.operation-notice a { text-decoration: underline; text-underline-offset: 3px; }
.operation-notice.dashboard-error { color: #f0a69e; }
.dashboard-utilities { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #2b3038; padding-top: 20px; gap: 16px; }
.dashboard-utility { display: flex; align-items: center; gap: 12px; padding: 8px 2px; color: #8c98a3; }
.dashboard-utility > svg { flex-shrink: 0; }
.dashboard-utility > div { display: grid; gap: 5px; }
.dashboard-utility strong { font-weight: 500; font-size: 12px; }
.dashboard-utility small { font-size: 10px; color: var(--dash-muted); }
.dashboard-utility > svg:last-child, .voice-utility .dashboard-text-button { margin-left: auto; }
.dashboard-utility:hover strong { color: var(--dash-accent); }
.utility-settings { display: flex; padding: 5px; }
@media (max-width: 1350px) {
  .dashboard-workflow-grid, .dashboard-utilities { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stash-quick-grid, .combat-quick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-workflow-card { display: grid; grid-template-columns: 36px 1fr; column-gap: 14px; padding: 18px; }
  .dashboard-workflow-card .dashboard-icon { grid-row: span 2; }
  .dashboard-workflow-card h3 { margin: 0 0 6px; }
  .dashboard-workflow-card p { max-width: none; margin-bottom: 17px; }
  .workflow-card-actions { grid-column: 2; }
  .combat-heading { align-items: flex-start; }
  .dashboard-combat-actions { align-items: flex-end; flex-direction: column-reverse; gap: 10px; }
  .combat-quick-card { padding: 16px; }
  .combat-quick-card h3 { font-size: 14px; flex-wrap: wrap; }
}
@media (max-width: 760px) {
  .dashboard-combat { padding: 18px; }
  .combat-quick-grid { grid-template-columns: 1fr; }
  .combat-quick-card { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .combat-card-top { grid-column: 1 / -1; margin-bottom: 6px; }
  .combat-quick-card h3 { grid-column: 1 / -1; }
  .combat-card-status { margin: 0; justify-content: flex-end; }
  .combat-quick-footer, .dashboard-status-line { align-items: flex-start; flex-direction: column; gap: 9px; }
  .dashboard-section-heading h2 { font-size: 18px; }
  .dashboard-combat-actions .dashboard-text-link { font-size: 10px; }
}
@media (max-width: 480px) {
  .dashboard-workflow-grid, .dashboard-utilities, .stash-quick-grid { grid-template-columns: 1fr; }
  .dashboard-section-heading { align-items: flex-start; flex-wrap: wrap; }
  .dashboard-combat-actions { flex-direction: row; align-items: center; flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .dashboard-toggle span, .dashboard-button { transition: none; } }
</style>
