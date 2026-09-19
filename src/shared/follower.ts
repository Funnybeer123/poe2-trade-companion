import type { FollowerConfig, FollowReplayStep } from "../core/follower.js";
import type { MapObservation, SteeringDecision } from "../core/followerMapMarker.js";
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
  recording?: { directory: string; frames: number; remainingMs: number };
  lastRecording?: { directory: string; frames: number };
}
export interface FollowerDriveSettings { version: 1; dryRun: boolean; mapScale: number; clickIntervalMs: number }
export interface FollowerDriveStatus {
  running: boolean;
  reason: string;
  settings: FollowerDriveSettings;
  /** Effective dry-run: the saved setting or the app-wide Dry-run switch. */
  dryRun: boolean;
  calibration?: { targetName: string; view: { width: number; height: number }; origin: { x: number; y: number }; markerOffset: { dx: number; dy: number }; labelPixels: number; /** The calibrated label as rows of # and . so the operator can read whose name was captured. */ labelMask: string[]; calibratedAt: string };
  calibrationIssue?: string;
  observation?: MapObservation & { ageMs: number };
  decision?: SteeringDecision;
  /** Own-movement tracking from the map outlines, and whether steering is following the leader's trail or aiming straight at them. */
  odometry?: { tracked: boolean; quality: number; trailPoints: number; via: "trail" | "direct" };
  stats?: {
    cycles: number; clicks: number; previewed: number; refused: number; manualTakeovers: number; observationsPerSecond: number;
    /** Loot: scans run, labels in the latest scan, and pickup clicks sent (or previewed). */
    lootScans: number; lootLabels: number; lootClicks: number;
    cycleMsP50?: number; cycleMsP95?: number; captureToInputMsP50?: number; captureToInputMsP95?: number; worstCaseReactionMsP95?: number;
    /** First clicks after standing near the leader, i.e. reactions to them moving off, and their capture-to-click times. */
    resumes?: number; resumeCaptureToInputMsP50?: number; resumeCaptureToInputMsP95?: number;
  };
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
  record(options: { seconds: number }): Promise<FollowerPerceptionStatus>;
  driveStatus(): Promise<FollowerDriveStatus>;
  driveConfigure(settings: FollowerDriveSettings): Promise<FollowerDriveStatus>;
  /** Omit the selection to find the only party label on the overlay map automatically. */
  driveCalibrate(selection?: { label: PixelRect }): Promise<FollowerDriveStatus & { capture: FollowerCapture }>;
  driveClearCalibration(): Promise<FollowerDriveStatus>;
  driveStart(): Promise<FollowerDriveStatus>;
  driveStop(): Promise<FollowerDriveStatus>;
}
