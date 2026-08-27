import type { RuntimeMode } from "./types.js";

export interface CapabilityConfig {
  mode: RuntimeMode;
  buildAllowsQa: boolean;
  qaAcknowledged: boolean;
  assistiveAcknowledged: boolean;
  allowlist: string[];
  bannerVisible: boolean;
  emergencyStopRegistered: boolean;
}

export class RuntimeCapabilities {
  constructor(private readonly config: CapabilityConfig) {}

  get mode(): RuntimeMode {
    if (this.config.mode === "assistive-access" && this.config.assistiveAcknowledged) {
      return "assistive-access";
    }
    if (!this.config.buildAllowsQa) return "public-companion";
    return this.config.mode;
  }

  canArmAutomation(): boolean {
    if (this.mode === "assistive-access") {
      return (
        this.config.assistiveAcknowledged &&
        this.config.allowlist.length > 0 &&
        this.config.emergencyStopRegistered
      );
    }
    return (
      this.config.buildAllowsQa &&
      this.config.mode === "authorized-qa" &&
      this.config.qaAcknowledged &&
      this.config.allowlist.length > 0 &&
      this.config.bannerVisible &&
      this.config.emergencyStopRegistered
    );
  }

  isProcessAllowed(processName: string): boolean {
    if (!this.canArmAutomation()) return false;
    const normalized = processName.trim().replace(/\.exe$/i, "").toLowerCase();
    return this.config.allowlist.some((entry) => {
      const allowed = entry.trim().replace(/\.exe$/i, "").toLowerCase();
      return allowed.length > 0 && normalized === allowed;
    });
  }
}

export function resolveBuildMode(envValue?: string): RuntimeMode {
  if (envValue === "assistive-access") return "assistive-access";
  return envValue === "authorized-qa" ? "authorized-qa" : "public-companion";
}
