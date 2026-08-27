import { ref, watch } from "vue";

const STORAGE_KEY = "poe2-renderer-preferences-v1";
const defaultDryRun = ref(true);
let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as { defaultDryRun?: unknown }).defaultDryRun === "boolean"
      ) {
        defaultDryRun.value = (parsed as { defaultDryRun: boolean }).defaultDryRun;
      }
    }
  } catch {
    // Preferences simply fall back to safe defaults.
  }
  watch(defaultDryRun, (value) => {
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ defaultDryRun: value }),
      );
    } catch {
      // Read-only browser sessions still keep the in-memory setting.
    }
  });
}

export function useRendererPreferences() {
  initialize();
  return { defaultDryRun };
}
