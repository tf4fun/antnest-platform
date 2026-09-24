export type BridgeIntentReceipt = {
  intentId: string;
  sessionId: string;
  runId: string;
  phase: "persisting" | "running" | "completed" | "cancelled" | "failed" | "unknown";
  appendVersion: number;
  outputWatermark: number;
  stopReason: string | null;
  errorClass: string | null;
};

export type BridgeSessionExecution = {
  sessionId: string;
  appendVersion: number;
  outputWatermark: number;
  activeRunId: string | null;
  recentReceipts: BridgeIntentReceipt[];
  configurationRevision: string | null;
};

export interface BridgeObservationRepository {
  readIntent(sessionId: string, intentId: string): Promise<BridgeIntentReceipt | null>;
  readSession(sessionId: string): Promise<BridgeSessionExecution | null>;
}
