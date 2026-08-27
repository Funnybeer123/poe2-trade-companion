import type { SafetyContext } from "./types.js";

export type SafetyDecision = { allow: boolean; reason: string };

function automationMode(mode: SafetyContext["mode"]): boolean {
  return mode === "authorized-qa" || mode === "assistive-access";
}

export function evaluateSafety(ctx: SafetyContext): SafetyDecision {
  if (!automationMode(ctx.mode)) return { allow: false, reason: "public-companion-cannot-arm" };
  if (ctx.killSwitchLatched) return { allow: false, reason: "kill-switch-latched" };
  if (!ctx.processAllowed) return { allow: false, reason: "process-not-allowlisted" };
  if (!ctx.moduleEnabled) return { allow: false, reason: "module-disabled" };
  if (ctx.confidence < ctx.confidenceThreshold) return { allow: false, reason: "confidence-too-low" };
  if (ctx.actionsThisMinute >= ctx.actionsPerMinute) return { allow: false, reason: "rate-limited" };
  if (ctx.dryRun) return { allow: false, reason: "dry-run" };
  return { allow: true, reason: "ok" };
}

export function shouldRecordOnly(ctx: SafetyContext): boolean {
  return ctx.dryRun || !automationMode(ctx.mode);
}

export function rateLimitOk(actionsThisMinute: number, cap: number): boolean {
  return actionsThisMinute < cap;
}

export function backoffMs(failures: number): number {
  return Math.min(30_000, 250 * 2 ** failures);
}
