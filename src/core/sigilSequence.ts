import type { CombatConfig, CombatModule, CombatReading } from "./combatAssist.js";
import type { BotDecision } from "./types.js";

export type SequenceAction = CombatModule | "weaponSwap";
/** Physical R reaches the game; only its X/T follow-up is generated. */
export class SigilSequence {
  private stage: "idle" | "casting" | "swapping" = "idle";
  private since = 0;
  private started = 0;
  get active(): boolean { return this.stage !== "idle"; }

  trigger(now: number): boolean {
    // Busy presses never queue a future weapon swap.
    if (this.active) return false;
    this.stage = "casting";
    this.started = this.since = now;
    return true;
  }

  decisions(config: CombatConfig, reading: CombatReading, now: number, triggerDown = false): Array<{ name: SequenceAction; decision: BotDecision }> {
    if (!config.sigilSequence.enabled || !this.active) return [];
    if (!reading.valid) throw new Error("Sigil macro interrupted — check your weapon set before restarting");
    if (now - this.started > config.sigilSequence.castMs + config.sigilSequence.swapMs + 5000) {
      throw new Error("Sigil macro timed out — release held keys and check your weapon set");
    }
    const action = (name: SequenceAction, key: string, reason: string) => [{ name, decision: {
      module: "combat" as const, rule: `sigil-sequence-${name}`, reason, confidence: 1,
      intended: [{ kind: "key" as const, key }],
    } }];
    if (this.stage === "casting" && !triggerDown && now - this.since >= config.sigilSequence.castMs) {
      return action("weaponSwap", config.sigilSequence.swapKey, "Manual Sigil press — cast delay elapsed, swap back once");
    }
    if (this.stage === "swapping" && now - this.since >= config.sigilSequence.swapMs) {
      return action("verisium", config.verisium.key, "Manual Sigil press — swap delay elapsed, cast Verisium once");
    }
    return [];
  }

  committed(name: SequenceAction, now: number): void {
    if (name === "weaponSwap" && this.stage === "casting") {
      this.stage = "swapping"; this.since = now;
    } else if (name === "verisium" && this.stage === "swapping") {
      this.stage = "idle";
    }
  }
}
