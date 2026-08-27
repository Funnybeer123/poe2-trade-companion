import type { RuntimeMode } from "./types.js";

export const DEFAULT_POE_PROCESS_ALLOWLIST = [
  "PathOfExileSteam.exe",
  "PathOfExile.exe",
  "PathOfExile_x64Steam.exe",
] as const;

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
    return this.config.mode;
  }

  canArmAutomation(): boolean {
    return (
      this.normalizedAllowlist().length > 0 && this.config.emergencyStopRegistered
    );
  }

  isProcessAllowed(processName: string): boolean {
    if (!this.canArmAutomation()) return false;
    const normalized = processName.trim().replace(/\.exe$/i, "").toLowerCase();
    return this.normalizedAllowlist().some((entry) => {
      const allowed = entry.replace(/\.exe$/i, "").toLowerCase();
      return allowed.length > 0 && normalized === allowed;
    });
  }

  private normalizedAllowlist(): string[] {
    return this.config.allowlist.map((entry) => entry.trim()).filter(Boolean);
  }
}

export function resolveBuildMode(envValue?: string): RuntimeMode {
  if (envValue === "public-companion") return "public-companion";
  if (envValue === "assistive-access") return "assistive-access";
  return "authorized-qa";
}
