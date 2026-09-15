import type { KitHost } from "./bagKit.js";
import type { WinReply } from "./winHost.js";

/** The independent listener also hears emergency stop while the input host is busy. */
export function mapTriageControlHost(raw: KitHost): KitHost {
  return { send: (payload) => raw.send(payload.op === "waitkey" ? { ...payload, emergencyStop: true } : payload) };
}

/** Map-only rails; vendor/stash callers keep their own host behavior. */
export function mapTriageHost(raw: KitHost, trace: (record: Record<string, unknown>) => void): KitHost {
  let focusAllowed = true;
  const inputs = new Set(["focus", "move", "hotkey", "rightclick", "click", "clickburst", "identifyburst", "copysweep"]);
  return {
    async send(payload): Promise<WinReply> {
      const op = String(payload.op);
      if (op === "focus") {
        if (!focusAllowed) throw new Error("focus-lost — focus the game and start a new run");
        focusAllowed = false;
      }
      const request = { ...payload, guarded: true, requireForeground: op !== "focus" };
      const reply = await raw.send(request);
      if (inputs.has(op)) {
        trace({ phase: "input", op, points: payload.points, x: payload.x, y: payload.y,
          gapMs: payload.gapMs, hoverMs: payload.hoverMs, shift: payload.shift, ok: reply.ok, count: reply.count, error: reply.error });
      }
      if (!reply.ok) throw new Error(`host-${op}-failed: ${String(reply.error ?? "unknown")}`);
      if (op === "copysweep") {
        const expected = Array.isArray(payload.points) ? payload.points.length : 0;
        if (!Array.isArray(reply.texts) || reply.texts.length !== expected ||
          reply.texts.some((text: unknown) => typeof text !== "string")) {
          throw new Error("incomplete-copy-sweep — clipboard state unverified");
        }
      }
      if (op === "clickburst" && Array.isArray(payload.points) && reply.count !== payload.points.length) {
        throw new Error("incomplete-click-burst — cursor state unverified");
      }
      if (op === "identifyburst") {
        const expected = Array.isArray(payload.points) ? payload.points.length : 0;
        const count = Number(reply.count);
        if (!Number.isInteger(count) || count < 1 || count > expected ||
          !Array.isArray(reply.texts) || reply.texts.length !== count ||
          reply.texts.some((text: unknown) => typeof text !== "string") ||
          (count !== expected && reply.verificationFailed !== true)) {
          throw new Error("incomplete-identify-burst — cursor state unverified");
        }
      }
      return reply;
    },
  };
}
