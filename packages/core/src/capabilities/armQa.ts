import type { RuntimeCapabilities, QaArmingState } from "./createCapabilities.js";

export interface QaArmingExtras {
  hotkeyRegistered: boolean;
}

export interface QaArmingEvaluation {
  allowArm: boolean;
  reasons: string[];
}

export function evaluateQaArming(
  capabilities: RuntimeCapabilities,
  arming: QaArmingState,
  extras: QaArmingExtras,
): QaArmingEvaluation {
  const reasons: string[] = [];
  if (capabilities.mode !== "authorized-qa") {
    reasons.push("public-mode");
  }
  if (!arming.acknowledged) {
    reasons.push("qa-not-acknowledged");
  }
  if (arming.allowlistedProcessNames.length === 0) {
    reasons.push("process-allowlist-empty");
  }
  if (arming.allowlistedWindowTitleIncludes.length === 0) {
    reasons.push("window-allowlist-empty");
  }
  if (!extras.hotkeyRegistered) {
    reasons.push("emergency-stop-hotkey-not-registered");
  }
  if (arming.emergencyStopLatched) {
    reasons.push("emergency-stop");
  }
  return { allowArm: reasons.length === 0, reasons };
}

export function armQa(
  capabilities: RuntimeCapabilities,
  arming: QaArmingState,
  extras: QaArmingExtras,
): QaArmingState {
  const { allowArm } = evaluateQaArming(capabilities, arming, extras);
  return { ...arming, armed: allowArm };
}
