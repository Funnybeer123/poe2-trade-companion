// @vitest-environment happy-dom

/**
 * The shared renderer store behind every Evaluate surface. These are the
 * request-discipline tests: one subscription, a stale answer dropped, and —
 * the reason the sequence is per action — a 15 s budget poll that interleaves
 * with a search must never swallow its result or wipe its error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateSession } from "../../src/shared/evaluate.js";

const bridge = vi.hoisted(() => ({
  available: true,
  subscribes: 0,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.subscribes += 1;
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
  getAppFeatureApi: () => null,
}));

import {
  disposeEvaluateSession,
  useEvaluateSession,
} from "../../src/renderer/features/evaluate/useEvaluateSession";

function fake(id: string): EvaluateSession {
  return { id, busy: "idle" } as unknown as EvaluateSession;
}

/** A promise plus its settle handles, so a test can control the ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  bridge.available = true;
  bridge.subscribes = 0;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  disposeEvaluateSession();
});

afterEach(() => {
  disposeEvaluateSession();
});

describe("useEvaluateSession", () => {
  it("subscribes to evaluate:session exactly once for the whole renderer", () => {
    const first = useEvaluateSession();
    const second = useEvaluateSession();
    expect(bridge.subscribes).toBe(1);
    expect(first.session).toBe(second.session);
    bridge.listeners.get("evaluate:session")!(fake("ev_pushed"));
    expect(second.session.value?.id).toBe("ev_pushed");
  });

  it("drops a stale search result when a newer search has already answered", async () => {
    const store = useEvaluateSession();
    store.adopt(fake("ev_a"));
    const slow = deferred<EvaluateSession>();
    const quick = deferred<EvaluateSession>();
    bridge.invoke.mockImplementationOnce(async () => slow.promise);
    bridge.invoke.mockImplementationOnce(async () => quick.promise);
    const query = fake("ev_a").query;
    const firstCall = store.search(query);
    const secondCall = store.search(query);
    quick.resolve(fake("ev_second"));
    await secondCall;
    slow.resolve(fake("ev_first"));
    await firstCall;
    expect(store.session.value?.id).toBe("ev_second");
  });

  it("still surfaces a failed search when the budget poll resolves in between", async () => {
    const store = useEvaluateSession();
    store.adopt(fake("ev_a"));
    const search = deferred<EvaluateSession>();
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "evaluate:budget") return { lookups: 3 };
      return search.promise;
    });
    const pending = store.search(fake("ev_a").query);
    // The 15 s poll lands first — under one shared sequence this used to make
    // the search's own rejection invisible.
    await store.budget();
    search.reject(new Error("trade2 is rate limited until 12:10"));
    await pending;
    expect(store.error.value).toContain("rate limited");

    // …and a later poll must not wipe the error it never owned.
    await store.budget();
    expect(store.error.value).toContain("rate limited");
    expect(store.loading.value).toBe(false);
  });

  it("forgets everything on dispose, including the subscription", () => {
    const store = useEvaluateSession();
    store.adopt(fake("ev_a"));
    expect(bridge.listeners.has("evaluate:session")).toBe(true);
    disposeEvaluateSession();
    expect(bridge.listeners.has("evaluate:session")).toBe(false);
    expect(store.session.value).toBeNull();
    expect(store.error.value).toBe("");
  });
});
