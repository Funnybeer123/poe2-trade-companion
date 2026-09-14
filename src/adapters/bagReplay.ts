import { validateBagScene, type BagAction, type BagScene, type BagSessionPorts } from "../core/bagSession.js";

export type BagReplayStep = { kind: "observe"; scene: BagScene } |
  { kind: "mutate"; action: BagAction; error?: string } | { kind: "stop" };
/** Ordered observations at the real orchestration boundary. No native modules,
 * clipboard, process spawning, network, or synthetic success fallback. */
export function validateBagReplay(value: unknown): asserts value is BagReplayStep[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Invalid bag replay.");
  for (const s of value as BagReplayStep[]) {
    if (!s || !["observe", "mutate", "stop"].includes(s.kind)) throw new Error("Invalid replay step.");
    if (s.kind === "observe") validateBagScene(s.scene);
    if (s.kind === "mutate" && (!s.action || !["arm", "identify", "pickup", "drop"].includes(s.action.kind) ||
      typeof s.action.id !== "string" || typeof s.action.itemId !== "string" || !s.action.cell || !s.action.ground ||
      s.error !== undefined && typeof s.error !== "string")) throw new Error("Invalid replay mutation.");
  }
}
export function bagReplay(steps: BagReplayStep[], save: BagSessionPorts["save"]) {
  validateBagReplay(steps);
  let cursor = 0, at = "2026-09-14T12:00:00Z";
  const actions: BagAction[] = [];
  const next = () => { const step = steps[cursor++]; if (!step) throw new Error("Replay exhausted."); return step; };
  const ports: BagSessionPorts = {
    save, now: () => at,
    checkpoint: async () => { if (steps[cursor]?.kind === "stop") throw Object.assign(new Error("Replay emergency stop."), { name: "AbortError" }); },
    observe: async () => { const step = next(); if (step.kind !== "observe") throw new Error("Replay expected observation."); at = step.scene.at; return structuredClone(step.scene); },
    mutate: async action => {
      const step = next();
      if (step.kind !== "mutate" || JSON.stringify(step.action) !== JSON.stringify(action)) throw new Error("Replay input mismatch.");
      actions.push(action);
      if (step.error) throw new Error(step.error);
    },
  };
  return { ports, actions, assertConsumed() { if (cursor !== steps.length) throw new Error("Replay has unconsumed steps."); } };
}
