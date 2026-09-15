/**
 * Shared state for the campaign guide's two surfaces (the Tools panel and the
 * overlay panel). Module-level refs so both can mount without re-fetching,
 * plus `disposeCampaignGuide()` for tests.
 *
 * Two staleness guards, both from the repo's own patterns: a monotonic
 * `requestSeq` so a slow `campaign:route` answer never overwrites a newer one
 * (WealthView), and the `progressRevision` pull rule — main pushes a small
 * `campaign:state` on every visit and the consumer re-reads the route itself
 * when its copy is behind, so a walk through the campaign never pushes the
 * whole merged route to every window.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  experienceChipTone,
  visibleObjectives,
  type CampaignCustomisePatch,
  type CampaignGuideSettings,
  type ExperienceEstimate,
  type MergedArea,
  type MergedObjective,
} from "@core/campaignGuide";
import type { CampaignRouteView, CampaignStateView } from "../../../shared/campaignGuide.js";
import { getCampaignApi, type CampaignApi } from "./campaignApi";

const route = ref<CampaignRouteView | null>(null);
const state = ref<CampaignStateView | null>(null);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const notice = ref("");
const selectedAreaId = ref("");

let requestSeq = 0;
let subscribers = 0;
let stops: Array<() => void> = [];
/** Patches QUEUE: one user action may send several, and none may be dropped. */
let patchQueue: Promise<void> = Promise.resolve();
let pendingPatches = 0;

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** Test seam + unmount cleanup: drops every subscription and invalidates in-flight reads. */
export function disposeCampaignGuide(): void {
  requestSeq += 1;
  for (const stop of stops.splice(0)) {
    try {
      stop();
    } catch {
      // A bridge that already went away must not break teardown.
    }
  }
  subscribers = 0;
  patchQueue = Promise.resolve();
  pendingPatches = 0;
  route.value = null;
  state.value = null;
  loading.value = true;
  error.value = "";
  busy.value = false;
  notice.value = "";
  selectedAreaId.value = "";
}

export interface CampaignGuideStore {
  api: CampaignApi | null;
  route: Ref<CampaignRouteView | null>;
  state: Ref<CampaignStateView | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  busy: Ref<boolean>;
  notice: Ref<string>;
  selectedAreaId: Ref<string>;
  settings: ComputedRef<CampaignGuideSettings | undefined>;
  currentArea: ComputedRef<MergedArea | undefined>;
  selectedArea: ComputedRef<MergedArea | undefined>;
  load(what?: "all" | "route" | "state"): Promise<void>;
  retry(): Promise<void>;
  customise(patch: CampaignCustomisePatch, message?: string): Promise<void>;
  subscribe(): () => void;
  selectArea(id: string): void;
  objectivesFor(area: MergedArea, includeHidden?: boolean): MergedObjective[];
  xpChip(estimate: ExperienceEstimate | undefined): "safe" | "warning" | "danger" | "neutral";
}

export function useCampaignGuide(): CampaignGuideStore {
  const api = getCampaignApi();

  const settings = computed(() => route.value?.settings);
  const currentArea = computed(() => {
    const id = state.value?.current?.normalizedId;
    if (!id) return undefined;
    return route.value?.merged.areaIndex[id];
  });
  const selectedArea = computed(() => {
    const id = selectedAreaId.value;
    if (id) return route.value?.merged.areaIndex[id];
    return currentArea.value;
  });

  async function load(what: "all" | "route" | "state" = "all"): Promise<void> {
    if (!api) {
      loading.value = false;
      return;
    }
    const seq = ++requestSeq;
    try {
      if (what !== "state") {
        const next = await api.invoke("campaign:route");
        if (seq !== requestSeq) return;
        route.value = next;
      }
      if (what !== "route") {
        const next = await api.invoke("campaign:state");
        if (seq !== requestSeq) return;
        state.value = next;
      }
      error.value = "";
    } catch (reason) {
      if (seq !== requestSeq) return;
      error.value = describe(reason, "The campaign guide could not be loaded.");
    }
  }

  async function retry(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    loading.value = true;
    error.value = "";
    try {
      await load();
    } finally {
      loading.value = false;
      busy.value = false;
    }
  }

  async function sendPatch(patch: CampaignCustomisePatch, message: string): Promise<void> {
    if (!api) return;
    try {
      route.value = await api.invoke("campaign:customise", patch);
      error.value = "";
      notice.value = message;
    } catch (reason) {
      error.value = describe(reason, "That change could not be saved.");
    }
  }

  /**
   * Queues the patch instead of dropping it while another one is in flight:
   * saving an area sends its edit AND its note in the same tick, and a dropped
   * second patch looks exactly like a successful save that persisted nothing.
   * `busy` stays true from the first enqueue until the queue drains.
   */
  function customise(patch: CampaignCustomisePatch, message = ""): Promise<void> {
    if (!api) return Promise.resolve();
    pendingPatches += 1;
    busy.value = true;
    const done = patchQueue.then(() => sendPatch(patch, message));
    patchQueue = done.then(
      () => undefined,
      () => undefined,
    );
    return done.finally(() => {
      pendingPatches = Math.max(0, pendingPatches - 1);
      if (pendingPatches === 0) busy.value = false;
    });
  }

  /** Subscribes once for however many components are mounted. */
  function subscribe(): () => void {
    if (!api) return () => undefined;
    subscribers += 1;
    if (subscribers === 1) {
      stops.push(
        api.on("campaign:state", (next) => {
          state.value = next;
          const known = route.value?.progressRevision ?? 0;
          if (next.progressRevision > known) void load("route");
        }),
      );
      stops.push(
        api.on("campaign:route-changed", (next) => {
          route.value = next;
        }),
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        for (const stop of stops.splice(0)) stop();
      }
    };
  }

  function selectArea(id: string): void {
    selectedAreaId.value = id;
  }

  function objectivesFor(area: MergedArea, includeHidden = false): MergedObjective[] {
    const current = settings.value;
    if (!current) return area.objectives;
    return visibleObjectives(area, current, includeHidden);
  }

  function xpChip(estimate: ExperienceEstimate | undefined): "safe" | "warning" | "danger" | "neutral" {
    return estimate ? experienceChipTone(estimate) : "neutral";
  }

  return {
    api,
    route,
    state,
    loading,
    error,
    busy,
    notice,
    selectedAreaId,
    settings,
    currentArea,
    selectedArea,
    load,
    retry,
    customise,
    subscribe,
    selectArea,
    objectivesFor,
    xpChip,
  };
}
