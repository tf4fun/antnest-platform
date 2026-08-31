import type {
  ContentBlock,
  EnvironmentChangeFact,
  RunExecutionSnapshot,
  RunState,
  SessionRecord,
} from "../domain/types.js";

export type RunIntent = {
  id: string;
  requestId: string;
  sessionId: string;
  clientMcpRevisionId: string;
  state: RunState;
  userMessageId: string;
  prompt: ContentBlock[];
};

export type CreateRunIntentInput = {
  runId: string;
  requestId: string;
  sessionId: string;
  userMessageId: string;
  prompt: ContentBlock[];
  createdAt: Date;
};

export type AdmissionDisposition = "accepted" | "cancelled";

export type AcceptRunInput = {
  runId: string;
  snapshot: RunExecutionSnapshot;
  environmentFact: EnvironmentChangeFact | null;
  acceptedAt: Date;
};

export interface RunRepository {
  getSession(sessionId: string): Promise<SessionRecord | null>;
  createRunIntent(input: CreateRunIntentInput): Promise<RunIntent>;
  requestCancellation(runId: string, requestedAt: Date): Promise<void>;
  acceptRun(input: AcceptRunInput): Promise<AdmissionDisposition>;
  rejectRun(runId: string, errorClass: string, rejectedAt: Date): Promise<"failed" | "cancelled">;
}
