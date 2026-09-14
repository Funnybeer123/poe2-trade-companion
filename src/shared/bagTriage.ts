export type BagTriageStage = "capture" | "identify" | "drop" | "reconcile";
export interface BagTriageStatus {
  running: boolean;
  phase: "idle" | "countdown" | "running" | "stopping" | "complete" | "error";
  message: string;
  stage?: BagTriageStage;
  journal?: string;
  sessions: Array<{ id: string; label: string }>;
  readiness?: string[];
  physicalItems?: number;
  unreadCells?: number;
  verifiedIdentifications?: number;
  verifiedDrops?: number;
}
export interface BagTriageBridge {
  status(): Promise<BagTriageStatus>;
  select(journal: string): Promise<BagTriageStatus>;
  start(stage: BagTriageStage): Promise<BagTriageStatus>;
  stop(): Promise<BagTriageStatus>;
  onStatus(callback: (status: BagTriageStatus) => void): () => void;
}
