/**
 * One shared Evaluate session for every surface that shows it (the overlay
 * panel and the Item log section). Module-level refs on purpose: main owns
 * exactly one "current" session, so two components must never hold two
 * different copies of it.
 *
 * Request discipline: every call carries a monotonic sequence number PER
 * ACTION, so a slow search that finishes after a newer search is dropped —
 * while the 15 s budget poll, which interleaves with everything, can never
 * swallow another action's result or wipe its error.
 */
import { computed, ref } from "vue";
import type {
  EvaluateBudgetView,
  EvaluateCopyKind,
  EvaluateOpenFailure,
  EvaluateOpenInput,
  EvaluateProfileId,
  EvaluateQueryState,
  EvaluateSession,
} from "../../../shared/evaluate.js";
import { getEvaluateApi, type EvaluateApi } from "./evaluateApi";

const session = ref<EvaluateSession | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
let subscribed: (() => void) | undefined;
/** One sequence per action key ("search", "budget", …), never one shared. */
const requestSeq = new Map<string, number>();
let inFlight = 0;
let cachedApi: EvaluateApi | null | undefined;

function api(): EvaluateApi | null {
  if (cachedApi === undefined) cachedApi = getEvaluateApi();
  return cachedApi;
}

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isFailure(result: EvaluateSession | EvaluateOpenFailure): result is EvaluateOpenFailure {
  return typeof (result as EvaluateOpenFailure).reason === "string";
}

/** One `evaluate:session` listener for the whole renderer. */
function subscribe(): void {
  const bridge = api();
  if (!bridge || subscribed) return;
  subscribed = bridge.on("evaluate:session", (next) => {
    // Pushed state is always the newest truth from main.
    session.value = next;
    error.value = next.error ?? "";
  });
}

/**
 * `key` names the action. Only a NEWER call of the SAME action makes this
 * one stale — the budget poll and a search no longer cancel each other.
 */
async function run<T>(
  work: (bridge: EvaluateApi) => Promise<T>,
  fallback: string,
  key: string,
): Promise<T | undefined> {
  const bridge = api();
  if (!bridge) return undefined;
  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);
  inFlight += 1;
  loading.value = true;
  try {
    const result = await work(bridge);
    if (seq !== requestSeq.get(key)) return undefined;
    error.value = "";
    return result;
  } catch (reason) {
    if (seq !== requestSeq.get(key)) return undefined;
    error.value = describe(reason, fallback);
    return undefined;
  } finally {
    inFlight -= 1;
    if (inFlight <= 0) loading.value = false;
  }
}

export function useEvaluateSession() {
  subscribe();

  /**
   * A surface that was handed a session (the overlay payload, the Item log)
   * adopts it as the shared one: main owns exactly one current session, and
   * every action below addresses it by id.
   */
  function adopt(next: EvaluateSession): void {
    if (session.value?.id === next.id) return;
    session.value = next;
    error.value = next.error ?? "";
  }

  async function refresh(): Promise<void> {
    const current = await run(
      (bridge) => bridge.invoke("evaluate:current"),
      "The session could not be read.",
      "current",
    );
    if (current !== undefined) session.value = current;
  }

  async function open(input: EvaluateOpenInput): Promise<boolean> {
    const result = await run(
      (bridge) => bridge.invoke("evaluate:open", input),
      "The item could not be evaluated.",
      "open",
    );
    if (!result) return false;
    if (isFailure(result)) {
      error.value = result.error;
      return false;
    }
    session.value = result;
    return true;
  }

  async function search(query: EvaluateQueryState): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const next = await run(
      (bridge) => bridge.invoke("evaluate:search", id, query),
      "The trade2 search failed.",
      "search",
    );
    if (next) session.value = next;
  }

  async function more(): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const next = await run((bridge) => bridge.invoke("evaluate:more", id), "The trade2 fetch failed.", "more");
    if (next) session.value = next;
  }

  async function exchange(): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const next = await run(
      (bridge) => bridge.invoke("evaluate:exchange", id),
      "The exchange lookup failed.",
      "exchange",
    );
    if (next) session.value = next;
  }

  async function setProfile(profile: EvaluateProfileId): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const next = await run(
      (bridge) => bridge.invoke("evaluate:set-profile", id, profile),
      "The profile could not be applied.",
      "set-profile",
    );
    if (next) session.value = next;
  }

  async function copy(kind: EvaluateCopyKind, listingId?: string): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const result = await run(
      (bridge) =>
        bridge.invoke("evaluate:copy", id, {
          kind,
          ...(listingId ? { listingId } : {}),
        }),
      "Nothing was copied.",
      "copy",
    );
    if (result?.ok) notice.value = "Copied to the clipboard.";
    else if (result?.error) error.value = result.error;
  }

  async function openSite(): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const result = await run(
      (bridge) => bridge.invoke("evaluate:open-site", id),
      "The trade site could not be opened.",
      "open-site",
    );
    if (result && !result.ok && result.error) error.value = result.error;
  }

  async function watch(): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    const result = await run((bridge) => bridge.invoke("evaluate:watch", id), "The watch was not saved.", "watch");
    if (result?.ok) notice.value = "Watching this item in Deals.";
    else if (result?.error) error.value = result.error;
  }

  async function close(): Promise<void> {
    const id = session.value?.id;
    if (!id) return;
    await run((bridge) => bridge.invoke("evaluate:close", id), "The panel could not be closed.", "close");
  }

  /**
   * Deliberately OUTSIDE run(): the poll fires every 15 s, so it must never
   * mark the panel busy, clear another action's error, or be cancelled by
   * (or cancel) a search that happens to overlap it.
   */
  async function budget(): Promise<EvaluateBudgetView | undefined> {
    const bridge = api();
    if (!bridge) return undefined;
    try {
      return await bridge.invoke("evaluate:budget");
    } catch {
      return undefined;
    }
  }

  return {
    available: api() !== null,
    session,
    loading,
    error,
    notice,
    busy: computed(() => session.value?.busy ?? "idle"),
    adopt,
    refresh,
    open,
    search,
    more,
    exchange,
    setProfile,
    copy,
    openSite,
    watch,
    close,
    budget,
  };
}

/** Tests only: drop the shared state and the single subscription. */
export function disposeEvaluateSession(): void {
  subscribed?.();
  subscribed = undefined;
  session.value = null;
  loading.value = false;
  error.value = "";
  notice.value = "";
  requestSeq.clear();
  inFlight = 0;
  cachedApi = undefined;
}
