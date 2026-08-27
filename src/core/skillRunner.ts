import { depositUsesCtrlClick, type Skill, type SkillStep } from "./skills.js";
import type { UiFacts } from "./uiPerception.js";
import { clampToRect, type ScreenRect } from "./screenLayout.js";
import type { InputAction } from "./types.js";

export interface PerceptionSource {
  capture(): Promise<{ facts: UiFacts; client: ScreenRect }>;
}

export interface SkillInput {
  click(x: number, y: number, ctrl?: boolean, shift?: boolean): Promise<{ ok: boolean; error?: string }>;
  hotkey(keys: string): Promise<{ ok: boolean }>;
  move?(x: number, y: number): Promise<{ ok: boolean; error?: string }>;
  drag?(fromX: number, fromY: number, toX: number, toY: number): Promise<{ ok: boolean; error?: string }>;
  burstCtrlClick?(
    points: Array<{ x: number; y: number }>,
    opts?: { shift?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
  rightClick?(x: number, y: number): Promise<{ ok: boolean; error?: string }>;
  wait?(ms: number): Promise<void>;
  cancelled?(): boolean;
}

export interface SkillTrace {
  reason: string;
  kind: SkillStep["kind"];
  action?: InputAction;
}

export function dynamicSkillBudget(skillId: string, facts: UiFacts): number {
  const estimatedItems =
    skillId === "deposit-bag-to-stash"
      ? Math.max(1, facts.occupiedBag.length)
      : Math.max(1, facts.stashItems.length, facts.occupiedStash.length);
  return Math.min(320, Math.max(80, 32 + estimatedItems * 4));
}

async function settle(input: SkillInput, ms: number): Promise<void> {
  if (ms <= 0) return;
  let remaining = ms;
  while (remaining > 0 && !input.cancelled?.()) {
    const slice = Math.min(50, remaining);
    if (input.wait) await input.wait(slice);
    else await new Promise<void>((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

export async function runSkill(
  skill: Skill,
  perception: PerceptionSource,
  input: SkillInput,
  maxSteps?: number,
): Promise<{ traces: SkillTrace[]; result: "done" | "abort"; reason: string }> {
  const traces: SkillTrace[] = [];
  let stepBudget = maxSteps ?? 80;
  for (let i = 0; i < stepBudget; i += 1) {
    if (input.cancelled?.()) return { traces, result: "abort", reason: "cancelled" };
    const { facts, client } = await perception.capture();
    if (input.cancelled?.()) return { traces, result: "abort", reason: "cancelled" };
    if (maxSteps == null) stepBudget = Math.max(stepBudget, dynamicSkillBudget(skill.id, facts));
    const step = skill.plan(facts);
    traces.push({ reason: step.reason, kind: step.kind, action: step.kind === "act" ? step.action : undefined });
    if (step.kind === "abort") return { traces, result: "abort", reason: step.reason };
    if (step.kind === "done") return { traces, result: "done", reason: step.reason };
    if (step.kind === "wait") {
      await settle(input, step.durationMs ?? 400);
      continue;
    }
    if (step.kind === "burst") {
      const clicks = step.actions.filter((action) => action.kind === "click" || depositUsesCtrlClick(step));
      if (clicks.length === step.actions.length && clicks.length > 0) {
        const points: Array<{ x: number; y: number }> = [];
        for (const action of clicks) {
          traces.push({ reason: step.reason, kind: "act", action });
          const from = clampToRect(action.x ?? 0, action.y ?? 0, client);
          if (!from) return { traces, result: "abort", reason: "click-outside-client" };
          points.push(from);
        }
        if (input.burstCtrlClick) {
          const sent = await input.burstCtrlClick(points, { shift: Boolean(step.shift) });
          if (!sent.ok) return { traces, result: "abort", reason: sent.error ?? "input-failed" };
        } else {
          for (const point of points) {
            const sent = await input.click(point.x, point.y, true, Boolean(step.shift));
            if (!sent.ok) return { traces, result: "abort", reason: sent.error ?? "input-failed" };
          }
        }
        await settle(input, step.settleMs ?? 0);
        if (step.terminal) return { traces, result: "done", reason: step.reason };
        continue;
      }
      for (const action of step.actions) {
        traces.push({ reason: step.reason, kind: "act", action });
        const from = clampToRect(action.x ?? 0, action.y ?? 0, client);
        if (!from) return { traces, result: "abort", reason: "click-outside-client" };
        const dest = clampToRect(action.x2 ?? 0, action.y2 ?? 0, client);
        if (!dest || !input.drag) {
          return { traces, result: "abort", reason: dest ? "drag-unsupported" : "click-outside-client" };
        }
        const dragged = await input.drag(from.x, from.y, dest.x, dest.y);
        if (!dragged.ok) return { traces, result: "abort", reason: dragged.error ?? "drag-failed" };
        await settle(input, step.settleMs ?? 40);
      }
      if (step.terminal) return { traces, result: "done", reason: step.reason };
      continue;
    }
    if (step.action.kind === "key") {
      await input.hotkey((step.action.key ?? "i").toLowerCase());
      await settle(input, step.settleMs ?? 0);
      continue;
    }
    if (step.action.kind === "wait") {
      await settle(input, step.action.durationMs ?? 400);
      continue;
    }
    const x = step.action.x ?? 0;
    const y = step.action.y ?? 0;
    const allowed = clampToRect(x, y, client);
    if (!allowed) {
      return { traces, result: "abort", reason: "click-outside-client" };
    }
    if (step.action.kind === "move") {
      if (input.move) {
        const moved = await input.move(allowed.x, allowed.y);
        if (!moved.ok) return { traces, result: "abort", reason: moved.error ?? "move-failed" };
      }
      await settle(input, step.settleMs ?? 160);
      continue;
    }
    if (step.action.kind === "drag") {
      const dest = clampToRect(step.action.x2 ?? 0, step.action.y2 ?? 0, client);
      if (!dest || !input.drag) {
        return { traces, result: "abort", reason: dest ? "drag-unsupported" : "click-outside-client" };
      }
      const dragged = await input.drag(allowed.x, allowed.y, dest.x, dest.y);
      if (!dragged.ok) return { traces, result: "abort", reason: dragged.error ?? "drag-failed" };
      await settle(input, step.settleMs ?? 360);
      continue;
    }
    if (step.action.button === "right") {
      if (!input.rightClick) return { traces, result: "abort", reason: "rightclick-unsupported" };
      if (input.move) {
        const moved = await input.move(allowed.x, allowed.y);
        if (!moved.ok) return { traces, result: "abort", reason: moved.error ?? "move-failed" };
        await settle(input, 40);
      }
      const cleared = await input.rightClick(allowed.x, allowed.y);
      if (!cleared.ok) return { traces, result: "abort", reason: cleared.error ?? "rightclick-failed" };
      await settle(input, step.settleMs ?? 140);
      continue;
    }
    const ctrl = depositUsesCtrlClick(step);
    if (ctrl && input.move) {
      const hovered = await input.move(allowed.x, allowed.y);
      if (!hovered.ok) return { traces, result: "abort", reason: hovered.error ?? "hover-failed" };
      await settle(input, 180);
    }
    const sent = await input.click(allowed.x, allowed.y, ctrl);
    if (!sent.ok) {
      return { traces, result: "abort", reason: sent.error ?? "input-failed" };
    }
    await settle(input, step.settleMs ?? 0);
  }
  return { traces, result: "abort", reason: "max-steps" };
}
