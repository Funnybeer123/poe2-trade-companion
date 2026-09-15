import { describe, expect, it, vi } from "vitest";
import { mapTriageControlHost, mapTriageHost } from "../src/adapters/mapTriageHost.js";

describe("map triage host boundary", () => {
  it("hears global emergency stop independently of the busy input host", async () => {
    const send = vi.fn(async () => ({ ok: true, key: 0 }));
    const control = mapTriageControlHost({ send });
    await control.send({ op: "waitkey", timeoutMs: 600 });
    expect(send).toHaveBeenCalledWith({ op: "waitkey", timeoutMs: 600, emergencyStop: true });
  });
  it("requires foreground and guarded batches without changing the underlying host", async () => {
    const send = vi.fn(async () => ({ ok: true, count: 1, texts: [""] }));
    const trace = vi.fn();
    const host = mapTriageHost({ send }, trace);
    await host.send({ op: "copysweep", points: [{ x: 10, y: 10 }] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ guarded: true, requireForeground: true }));
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ op: "copysweep", ok: true }));
  });

  it("never turns transport failure or a partial sweep into empty bag cells", async () => {
    for (const reply of [{ ok: false, error: "focus-lost" }, { ok: true, texts: [] }, { ok: true, texts: [null] }]) {
      const host = mapTriageHost({ send: async () => reply }, () => undefined);
      await expect(host.send({ op: "copysweep", points: [{ x: 10, y: 10 }] })).rejects.toThrow();
    }
  });

  it("refuses partial bursts and only allows the initial explicit focus", async () => {
    const send = vi.fn(async () => ({ ok: true, count: 1 }));
    const host = mapTriageHost({ send }, () => undefined);
    await host.send({ op: "focus" });
    await expect(host.send({ op: "focus" })).rejects.toThrow("focus-lost");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(host.send({ op: "clickburst", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })).rejects.toThrow("incomplete-click-burst");
  });

  it("only accepts short identify batches when the host reports a verification stop", async () => {
    const points = [{ x: 1, y: 1, itemClass: "Rings" }, { x: 2, y: 2, itemClass: "Rings" }];
    const reply = { ok: true, count: 1, texts: [""], verificationFailed: true };
    const host = mapTriageHost({ send: async () => reply }, () => undefined);
    await expect(host.send({ op: "identifyburst", points })).resolves.toEqual(reply);
    const unsafe = mapTriageHost({ send: async () => ({ ...reply, verificationFailed: false }) }, () => undefined);
    await expect(unsafe.send({ op: "identifyburst", points })).rejects.toThrow("incomplete-identify-burst");
  });
});
