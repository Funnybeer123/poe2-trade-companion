/**
 * One shared, live copy of the settings snapshot for the Settings sections.
 *
 * Every section needs a different namespace of the same document, so they
 * share one `settings:get` read and one `settings:changed` subscription
 * instead of each holding its own. A `generation` counter guards against a
 * slow reload landing after a newer one (the `useRuntimeState.ts` idiom).
 *
 * P10-internal: other packages read the `app` namespace through `settings:get`
 * themselves — nothing outside this folder imports this file.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { SettingsChangedEvent, SettingsSnapshot } from "../../../shared/features.js";
import { getAppFeatureApi } from "../../services/featureApi";

export interface AppSettingsState {
  snapshot: Ref<SettingsSnapshot>;
  loaded: Ref<boolean>;
  error: Ref<string>;
  load(): Promise<void>;
  /** Merge a patch into one namespace; resolves with the sanitized value. */
  patch<T>(id: string, value: unknown): Promise<T>;
  /** A live, sanitized view of one namespace. */
  slice<T>(id: string, sanitize: (raw: unknown) => T): ComputedRef<T>;
}

let shared: AppSettingsState | undefined;
let stopChanges: (() => void) | undefined;
let generation = 0;

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function create(): AppSettingsState {
  const api = getAppFeatureApi();
  const snapshot = ref<SettingsSnapshot>({});
  const loaded = ref(false);
  const error = ref("");

  async function load(): Promise<void> {
    if (!api) {
      loaded.value = true;
      return;
    }
    const mine = ++generation;
    try {
      const next = await api.invoke("settings:get");
      if (mine !== generation) return;
      snapshot.value = next;
      error.value = "";
    } catch (reason) {
      if (mine !== generation) return;
      error.value = describe(reason, "The settings could not be loaded.");
    } finally {
      if (mine === generation) loaded.value = true;
    }
  }

  async function patch<T>(id: string, value: unknown): Promise<T> {
    if (!api) throw new Error("Settings are only available in the desktop app.");
    const result = (await api.invoke("settings:set", id, value)) as T;
    snapshot.value = { ...snapshot.value, [id]: result };
    return result;
  }

  function slice<T>(id: string, sanitize: (raw: unknown) => T): ComputedRef<T> {
    return computed(() => sanitize(snapshot.value[id]));
  }

  stopChanges = api?.on("settings:changed", (event: SettingsChangedEvent) => {
    snapshot.value = { ...snapshot.value, [event.id]: event.value };
  });

  return { snapshot, loaded, error, load, patch, slice };
}

export function useAppSettings(): AppSettingsState {
  if (!shared) shared = create();
  return shared;
}

/** Tests mount the sections repeatedly; drop the singleton between them. */
export function disposeAppSettings(): void {
  stopChanges?.();
  stopChanges = undefined;
  shared = undefined;
  generation = 0;
}
