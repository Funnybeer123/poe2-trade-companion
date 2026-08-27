import {
  SCANNER_INVOKE_CHANNELS,
  SCANNER_IPC_VERSION,
  type ScannerRunSummary,
  type ScannerStartRequest,
} from "../shared/ipc.js";
import type { ScanRunResult } from "./scanRunService.js";
import { ScannerRuntimeService } from "./scanRuntimeService.js";

export interface ScanIpcRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}-object-required`);
  }
  return value as Record<string, unknown>;
}

function validateStartRequest(value: unknown): ScannerStartRequest {
  const request = requiredObject(value, "scanner-start-request");
  if (typeof request.gridKind !== "string") {
    throw new Error("scanner-grid-kind-required");
  }
  if (typeof request.dryRun !== "boolean") {
    throw new Error("scanner-dry-run-required");
  }
  if (typeof request.qaAcknowledged !== "boolean") {
    throw new Error("scanner-qa-acknowledgement-required");
  }
  if (!Array.isArray(request.allowlist)) {
    throw new Error("scanner-allowlist-array-required");
  }
  return value as ScannerStartRequest;
}

function summarize(result: ScanRunResult): ScannerRunSummary {
  const statusCounts: Record<string, number> = {};
  for (const slot of result.session.slots) {
    statusCounts[slot.status] = (statusCounts[slot.status] ?? 0) + 1;
  }
  return {
    schemaVersion: SCANNER_IPC_VERSION,
    status: result.status,
    reason: result.reason,
    sessionId: result.session.id,
    sessionStatus: result.session.status,
    startedAt: result.session.startedAt,
    ...(result.session.endedAt
      ? { endedAt: result.session.endedAt }
      : {}),
    recordCount: result.session.slots.length,
    statusCounts,
  };
}

export function registerScanIpc(
  ipc: ScanIpcRegistrar,
  service: ScannerRuntimeService,
): () => void {
  for (const channel of SCANNER_INVOKE_CHANNELS) {
    ipc.removeHandler(channel);
  }
  ipc.handle("scanner:status", () => service.status);
  ipc.handle("scanner:start", async (_event, value) =>
    summarize(await service.start(validateStartRequest(value))),
  );
  ipc.handle("scanner:stop", () => service.stop("operator-stop"));
  return () => {
    for (const channel of SCANNER_INVOKE_CHANNELS) {
      ipc.removeHandler(channel);
    }
  };
}
