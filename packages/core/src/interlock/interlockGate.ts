import type { Clock } from "../clock.js";
import { SystemClock } from "../clock.js";
import type { QaArmingState } from "../capabilities/createCapabilities.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import { TokenBucketRateLimiter } from "./rateLimiter.js";
import type {
  InterlockCode,
  InterlockContext,
  InterlockGate,
  InterlockIdentity,
  InterlockVerdict,
} from "./types.js";

function deny(code: InterlockCode, message: string): InterlockVerdict {
  return { code, allowExecute: false, allowRecord: true, message };
}

function isWindowAllowlisted(world: WorldState, arming: QaArmingState): boolean {
  const observation = world.process;
  const proc = observation?.value;
  if (!proc || observation.freshness === "missing") {
    return false;
  }
  if (proc.allowlisted !== true) {
    return false;
  }
  if (
    arming.allowlistedProcessNames.length > 0 &&
    proc.name !== undefined &&
    !arming.allowlistedProcessNames.includes(proc.name)
  ) {
    return false;
  }
  const title = proc.title;
  if (
    arming.allowlistedWindowTitleIncludes.length > 0 &&
    title !== undefined &&
    !arming.allowlistedWindowTitleIncludes.some((fragment) => title.includes(fragment))
  ) {
    return false;
  }
  return true;
}

function identityAllowlistDenial(
  arming: QaArmingState,
  scenario: AutomationScenario,
  identity: InterlockIdentity | undefined,
): string | undefined {
  if (arming.scenarioAllowlist !== undefined && !arming.scenarioAllowlist.includes(scenario.id)) {
    return `Scenario ${scenario.id} is not allowlisted`;
  }
  if (arming.realmAllowlist !== undefined) {
    if (identity?.realm === undefined || !arming.realmAllowlist.includes(identity.realm)) {
      return "Realm is not allowlisted";
    }
  }
  if (arming.accountAliasAllowlist !== undefined) {
    if (
      identity?.accountAlias === undefined ||
      !arming.accountAliasAllowlist.includes(identity.accountAlias)
    ) {
      return "Account alias is not allowlisted";
    }
  }
  if (arming.characterAliasAllowlist !== undefined) {
    if (
      identity?.characterAlias === undefined ||
      !arming.characterAliasAllowlist.includes(identity.characterAlias)
    ) {
      return "Character alias is not allowlisted";
    }
  }
  return undefined;
}

export class DefaultInterlockGate implements InterlockGate {
  constructor(private readonly rateLimiter: TokenBucketRateLimiter) {}

  evaluate(ctx: InterlockContext): InterlockVerdict {
    const { capabilities, arming, scenario, world, decision } = ctx;

    if (arming.emergencyStopLatched || world.flags.emergencyStopLatched) {
      return deny("emergency-stop", "Emergency stop is latched");
    }

    if (!capabilities.canEmitNativeInput) {
      return deny("public-mode", "public-companion cannot emit native input");
    }

    const executeRequested = scenario.executionMode === "live" && !arming.dryRunDefault;
    if (capabilities.mode === "authorized-qa") {
      if (!arming.acknowledged) {
        return deny("qa-not-acknowledged", "QA acknowledgement is required");
      }
      if (executeRequested && !arming.armed) {
        return deny("qa-not-armed", "QA runtime is not armed");
      }
    }

    if (!isWindowAllowlisted(world, arming)) {
      return deny("window-not-allowlisted", "Active process/window is not allowlisted");
    }

    const allowlistMessage = identityAllowlistDenial(arming, scenario, ctx.identity);
    if (allowlistMessage !== undefined) {
      return deny("allowlist-denied", allowlistMessage);
    }

    if (!scenario.enabled) {
      return deny("scenario-disabled", `Scenario ${scenario.id} is disabled`);
    }
    if (
      !scenario.enabledModules.includes(decision.module) ||
      capabilities.modules[decision.module] !== true
    ) {
      return deny("module-disabled", `Module ${decision.module} is disabled`);
    }

    if (
      decision.confidence < scenario.confidenceThreshold &&
      scenario.lowConfidencePolicy !== "adversarial-execute"
    ) {
      return deny(
        "low-confidence",
        `Decision confidence ${decision.confidence} is below threshold ${scenario.confidenceThreshold}`,
      );
    }

    const retryLimit = scenario.retryLimits[decision.module];
    if (
      retryLimit !== undefined &&
      ctx.retryIndex !== undefined &&
      ctx.retryIndex >= retryLimit
    ) {
      return deny("retry-exhausted", `Retry limit ${retryLimit} exhausted for ${decision.module}`);
    }

    if (!this.rateLimiter.hasToken(scenario.actionsPerMinute)) {
      return deny("rate-limited", "Action rate limit exceeded");
    }

    if (scenario.executionMode !== "live" || arming.dryRunDefault) {
      return {
        code: "dry-run",
        allowExecute: false,
        allowRecord: true,
        message: "Dry-run records intended input and emits none",
      };
    }

    return { code: "ok", allowExecute: true, allowRecord: true, message: "Interlocks passed" };
  }
}

export function createInterlockGate(options: {
  rateLimiter?: TokenBucketRateLimiter;
  clock?: Clock;
} = {}): InterlockGate {
  const rateLimiter =
    options.rateLimiter ?? new TokenBucketRateLimiter(options.clock ?? new SystemClock());
  return new DefaultInterlockGate(rateLimiter);
}
