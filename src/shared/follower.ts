import type { FollowerConfig, FollowReplayStep } from "../core/follower.js";

export interface FollowerStatus {
  config: FollowerConfig;
  connection: "stopped" | "listening" | "connecting" | "connected" | "disconnected" | "error";
  reason: string;
  lastSeenAt?: number;
  roundTripMs?: number;
  peerName?: string;
  addresses: string[];
  capability: "connection-preview";
}
export interface FollowerBridge {
  status(): Promise<FollowerStatus>;
  configure(config: FollowerConfig): Promise<FollowerStatus>;
  generateKey(): Promise<string>;
  start(key: string): Promise<FollowerStatus>;
  stop(): Promise<FollowerStatus>;
  demo(): Promise<FollowReplayStep[]>;
}
