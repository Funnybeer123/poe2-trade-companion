export interface FollowConfig {
  maxFollowDistancePx: number;
  clickMove: boolean;
  lostTargetTicks: number;
  stuckTicks: number;
}

export const DEFAULT_FOLLOW_CONFIG: FollowConfig = {
  maxFollowDistancePx: 140,
  clickMove: true,
  lostTargetTicks: 8,
  stuckTicks: 12,
};

export function resolveFollowConfig(overrides: Partial<FollowConfig> = {}): FollowConfig {
  return { ...DEFAULT_FOLLOW_CONFIG, ...overrides };
}
