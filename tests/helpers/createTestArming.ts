import type { QaArmingState } from "@poe2tc/core";

export function createTestArming(overrides: Partial<QaArmingState> = {}): QaArmingState {
  return {
    acknowledged: true,
    armed: true,
    emergencyStopLatched: false,
    dryRunDefault: false,
    allowlistedProcessNames: ["PathOfExile.exe", "PathOfExile_x64.exe", "PathOfExileSteam.exe"],
    allowlistedWindowTitleIncludes: ["Path of Exile 2"],
    ...overrides,
  };
}
