import type { RuntimeMode } from "../world-state/types.js";
import { isQaBuildEnabled } from "../capabilities/buildMode.js";
import { GGG_DISCLAIMER } from "./disclaimer.js";
import { defaultOperatorSettings, type OperatorSettings } from "./settings.js";

export const QA_FIRST_RUN_PHRASE = "AUTHORIZED QA";

export interface FirstRunSubmission {
  selectedMode: RuntimeMode;
  confirmationText?: string;
  acknowledged: boolean;
}

export interface FirstRunEvaluation {
  ok: boolean;
  reasons: string[];
  settings: OperatorSettings;
}

export function evaluateFirstRun(
  submission: FirstRunSubmission,
  compileTimeMode: string | undefined,
  current: OperatorSettings = defaultOperatorSettings(),
): FirstRunEvaluation {
  const reasons: string[] = [];
  if (submission.selectedMode === "authorized-qa") {
    if (!isQaBuildEnabled(compileTimeMode)) {
      reasons.push("compile-time-public");
    }
    if ((submission.confirmationText ?? "").trim() !== QA_FIRST_RUN_PHRASE) {
      reasons.push("qa-confirmation-mismatch");
    }
    if (submission.acknowledged !== true) {
      reasons.push("qa-not-acknowledged");
    }
  }

  const selectedMode: RuntimeMode =
    reasons.length === 0 && submission.selectedMode === "authorized-qa"
      ? "authorized-qa"
      : "public-companion";

  return {
    ok: reasons.length === 0,
    reasons,
    settings: {
      ...current,
      firstRunCompleted: reasons.length === 0,
      selectedMode,
      qaAcknowledged: reasons.length === 0 && selectedMode === "authorized-qa",
    },
  };
}

export function firstRunDisclaimer(): string {
  return GGG_DISCLAIMER;
}
