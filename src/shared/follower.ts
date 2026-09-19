import type { FollowerConfig, FollowReplayStep } from "../core/follower.js";
import type { LeaderObservation, PixelRect } from "../core/followerPerception.js";

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
export interface FollowerCapture { image: string; width: number; height: number; capturedAt: string }
export interface FollowerPerceptionStatus {
  observing: boolean;
  reason: string;
  /** The observation preview has no path to game input. */
  inputCapability: "none";
  calibration?: { targetName: string; view: { width: number; height: number }; searchArea: PixelRect; nameplate: PixelRect; calibratedAt: string; templatePixels: number };
  calibrationIssue?: string;
  observation?: LeaderObservation & { ageMs: number };
  stats?: { cycleMs: number; observationsPerSecond: number };
}
export interface FollowerBridge {
  status(): Promise<FollowerStatus>;
  configure(config: FollowerConfig): Promise<FollowerStatus>;
  generateKey(): Promise<string>;
  start(key: string): Promise<FollowerStatus>;
  stop(): Promise<FollowerStatus>;
  demo(): Promise<FollowReplayStep[]>;
  perception(): Promise<FollowerPerceptionStatus>;
  capture(): Promise<FollowerCapture>;
  calibrate(regions: { nameplate: PixelRect; searchArea?: PixelRect }): Promise<FollowerPerceptionStatus>;
  clearCalibration(): Promise<FollowerPerceptionStatus>;
  observe(): Promise<FollowerPerceptionStatus>;
  stopObserving(): Promise<FollowerPerceptionStatus>;
}
