import type { QaArmingState } from "../capabilities/createCapabilities.js";
import {
  DEFAULT_ALLOWLISTED_PROCESS_NAMES,
  DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES,
} from "../perception/allowlist.js";

export function createReplayArming(overrides: Partial<QaArmingState> = {}): QaArmingState {
  return {
    acknowledged: true,
    armed: true,
    emergencyStopLatched: false,
    dryRunDefault: false,
    allowlistedProcessNames: [...DEFAULT_ALLOWLISTED_PROCESS_NAMES],
    allowlistedWindowTitleIncludes: [...DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES],
    ...overrides,
  };
}
