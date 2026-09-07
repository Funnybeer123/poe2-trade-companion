import { describe, expect, it } from "vitest";
import { memoizeAsync } from "../src/core/memoizeAsync.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("memoizeAsync", () => {
  it("coalesces concurrent calls into one in-flight fetch", async () => {
    const gate = deferred<string[]>();
    let calls = 0;
    const get = memoizeAsync(
      () => {
        calls += 1;
        return gate.promise;
      },
      { ttlMs: 4_000, now: () => 0 },
    );

    const first = get();
    const second = get();
    expect(calls).toBe(1);
    expect(second).toBe(first);

    gate.resolve(["PathOfExile.exe"]);
    expect(await first).toEqual(["PathOfExile.exe"]);
    expect(await second).toBe(await first);
  });

  it("serves the cached value while fresh and fetches again once the ttl has passed", async () => {
    let clock = 0;
    let calls = 0;
    const get = memoizeAsync(
      async () => {
        calls += 1;
        return calls;
      },
      { ttlMs: 4_000, now: () => clock },
    );

    expect(await get()).toBe(1);
    clock = 3_999;
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
    clock = 4_000;
    expect(await get()).toBe(2);
    expect(calls).toBe(2);
    clock = 7_999;
    expect(await get()).toBe(2);
  });

  it("propagates a rejection to every waiter and does not cache it", async () => {
    const gate = deferred<number>();
    let calls = 0;
    const get = memoizeAsync(
      () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve(42);
      },
      { ttlMs: 4_000, now: () => 0 },
    );

    const first = get();
    const second = get();
    gate.reject(new Error("powershell missing"));
    await expect(first).rejects.toThrow("powershell missing");
    await expect(second).rejects.toThrow("powershell missing");

    expect(await get()).toBe(42);
    expect(calls).toBe(2);
  });

  it("reset() discards the cached value", async () => {
    let calls = 0;
    const get = memoizeAsync(
      async () => {
        calls += 1;
        return calls;
      },
      { ttlMs: 60_000, now: () => 0 },
    );
    expect(await get()).toBe(1);
    get.reset();
    expect(await get()).toBe(2);
  });
});
