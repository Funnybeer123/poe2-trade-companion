import { ref } from "vue";
import { defaultCombatConfig, HUD_NAMES, type CombatBridge, type CombatConfig, type CombatPreview, type HudRegionName } from "../../core/combatAssist.js";

export type CalibrationTab = "hud" | "cooldown";
interface CalibrationScreenshot extends CombatPreview { capturedAt: string }

function createDraft() {
  const draft = ref(defaultCombatConfig());
  let baseline: CombatConfig | undefined;
  const copy = (config: CombatConfig): CombatConfig => JSON.parse(JSON.stringify(config));
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const size = (config: CombatConfig) => [config.width, config.height];
  function acceptSaved(saved: CombatConfig) { baseline = copy(saved); draft.value = copy(saved); }
  function reconcile(saved: CombatConfig) {
    if (!baseline) { acceptSaved(saved); return; }
    const local = draft.value;
    const localCalibrationChanged = !equal(size(local), size(baseline)) || !equal(local.regions, baseline.regions);
    if (!equal(size(saved), size(baseline)) && localCalibrationChanged && !equal(size(local), size(saved))) {
      throw new Error("Saved HUD resolution changed while calibration edits were pending. Capture the HUD at the current resolution before saving.");
    }
    const merged = copy(saved);
    // Keep only actual local edits; dashboard toggles and other saved changes win
    // over untouched draft fields. A region's coordinates and pixels stay together.
    function moduleSettings<T extends object>(current: T, previous: T, incoming: T): T {
      const result = { ...incoming };
      for (const key of Object.keys(current) as (keyof T)[]) {
        if (!equal(current[key], previous[key])) result[key] = current[key];
      }
      return result;
    }
    merged.health = moduleSettings(local.health, baseline.health, saved.health);
    merged.mana = moduleSettings(local.mana, baseline.mana, saved.mana);
    merged.unleash = moduleSettings(local.unleash, baseline.unleash, saved.unleash);
    if (local.pollMs !== baseline.pollMs) merged.pollMs = local.pollMs;
    if (local.dryRun !== baseline.dryRun) merged.dryRun = local.dryRun;
    if (!equal(size(local), size(baseline))) {
      merged.width = local.width; merged.height = local.height;
      merged.regions = copy(local).regions;
    } else if (equal(size(saved), size(baseline))) {
      for (const name of HUD_NAMES) {
        if (equal(local.regions[name], baseline.regions[name])) continue;
        if (local.regions[name]) merged.regions[name] = copy(local).regions[name];
        else delete merged.regions[name];
      }
    }
    baseline = copy(saved);
    draft.value = merged;
  }
  return {
    draft, reconcile, acceptSaved,
    screenshots: ref<Partial<Record<CalibrationTab, CalibrationScreenshot>>>({}),
    activeTab: ref<CalibrationTab>("hud"),
    selection: ref<HudRegionName>("health"),
    corner: ref<{ x: number; y: number }>(),
    error: ref(""),
  };
}

// A renderer-session cache: navigation retains work, while restarting the app
// drops screenshots and reloads only the explicitly saved configuration.
const drafts = new WeakMap<CombatBridge, ReturnType<typeof createDraft>>();
export function useCombatDraft(api: CombatBridge | undefined) {
  if (!api) return createDraft();
  let session = drafts.get(api);
  if (!session) {
    session = createDraft();
    drafts.set(api, session);
  }
  return session;
}
