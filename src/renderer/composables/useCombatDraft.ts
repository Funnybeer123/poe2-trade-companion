import { ref } from "vue";
import { defaultCombatConfig, type CombatBridge, type CombatPreview, type HudRegionName } from "../../core/combatAssist.js";

export type CalibrationTab = "hud" | "cooldown";
interface CalibrationScreenshot extends CombatPreview { capturedAt: string }

function createDraft() {
  return {
    initialized: false,
    draft: ref(defaultCombatConfig()),
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
