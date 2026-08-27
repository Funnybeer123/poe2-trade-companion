import {
  CLIENT_RELATIVE_SCAN_SPACE,
  createScanGrid,
  type ScanSessionContext,
  type ScanSlotDraft,
  type ScanSlotStatus,
} from "../src/core/scanContracts.js";

export const TEST_SCAN_CONTEXT: ScanSessionContext = {
  coordinateSpace: { ...CLIENT_RELATIVE_SCAN_SPACE },
  grid: createScanGrid("inventory"),
  source: {
    sourceMode: "fixture",
    runtimeMode: "authorized-qa",
    profileId: "test-profile",
    profileVersion: 3,
    calibrationId: "test-calibration",
    calibrationHash: "calibration-sha256-test",
    ruleHash: "rules-sha256-test",
    timing: {
      profile: "deterministic-test",
      hoverMs: 0,
      copyTimeoutMs: 20,
      pollIntervalMs: 5,
      afterCopyMs: 0,
      randomized: false,
      seed: "test-seed",
    },
  },
};

export function slotDraft(
  sequence: number,
  row: number,
  col: number,
  status: ScanSlotStatus = "empty",
  attempt = 1,
  rawText?: string,
): ScanSlotDraft {
  return {
    sequence,
    observedAt: new Date(sequence * 1_000).toISOString(),
    cell: { row, col },
    clientPoint: { x: col * 10 + 5, y: row * 10 + 5 },
    status,
    attempt,
    ...(rawText == null ? {} : { rawText }),
  };
}
