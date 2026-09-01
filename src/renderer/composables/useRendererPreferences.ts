import { ref, watch } from "vue";
import { DEFAULT_POE_PROCESS_ALLOWLIST } from "@core/capabilities";

const STORAGE_KEY = "poe2-renderer-preferences-v1";

export const DEFAULT_TRANSFER_ACTIONS_PER_MINUTE = 240;
export const DEFAULT_SORT_ACTIONS_PER_MINUTE = 600;

const defaultDryRun = ref(false);
const processAllowlist = ref(DEFAULT_POE_PROCESS_ALLOWLIST.join(", "));
const transferActionsPerMinute = ref(DEFAULT_TRANSFER_ACTIONS_PER_MINUTE);
const sortActionsPerMinute = ref(DEFAULT_SORT_ACTIONS_PER_MINUTE);
let initialized = false;

function readNumber(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const stored = parsed as Record<string, unknown>;
        if (typeof stored.defaultDryRun === "boolean") {
          defaultDryRun.value = stored.defaultDryRun;
        }
        if (typeof stored.processAllowlist === "string" && stored.processAllowlist.trim()) {
          processAllowlist.value = stored.processAllowlist;
        }
        transferActionsPerMinute.value = readNumber(
          stored.transferActionsPerMinute,
          DEFAULT_TRANSFER_ACTIONS_PER_MINUTE,
          600,
        );
        sortActionsPerMinute.value = readNumber(
          stored.sortActionsPerMinute,
          DEFAULT_SORT_ACTIONS_PER_MINUTE,
          1_200,
        );
      }
    }
  } catch {
    // Preferences simply fall back to safe defaults.
  }
  watch(
    [defaultDryRun, processAllowlist, transferActionsPerMinute, sortActionsPerMinute],
    ([dryRun, allowlist, transferApm, sortApm]) => {
      try {
        globalThis.localStorage?.setItem(
          STORAGE_KEY,
          JSON.stringify({
            defaultDryRun: dryRun,
            processAllowlist: allowlist,
            transferActionsPerMinute: transferApm,
            sortActionsPerMinute: sortApm,
          }),
        );
      } catch {
        // Read-only browser sessions still keep the in-memory setting.
      }
    },
  );
}

export function allowlistEntries(value: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length ? entries : [...DEFAULT_POE_PROCESS_ALLOWLIST];
}

export function useRendererPreferences() {
  initialize();
  return {
    defaultDryRun,
    processAllowlist,
    transferActionsPerMinute,
    sortActionsPerMinute,
  };
}
