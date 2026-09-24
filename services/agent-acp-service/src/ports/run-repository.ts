import type {
  ContentBlock,
  EnvironmentChangeFact,
  RunExecutionSnapshot,
  RunState,
  SessionRecord,
} from "../domain/types.js";
import type { SessionConfiguration } from "../domain/session-configuration.js";

export type RunIntent = {
  sessionConfiguration?: SessionConfiguration;
  id: string;
  requestId: string;
  sessionId: string;
  clientMcpRevisionId: string;
  expectedAccessRevision: string;
  state: RunState;
  userMessageId: string;
  prompt: ContentBlock[];
};

export type CreateRunIntentInput = {
  runId: string;
  requestId: string;
  sessionId: string;
  expectedAccessRevision: string;
  userMessageId: string;
  prompt: ContentBlock[];
  createdAt: Date;
  bridgeIntent?: { intentId: string; expectedAppendVersion: number };
};

export type AdmissionDisposition = "accepted" | "cancelled";

export type AcceptRunInput = {
  runId: string;
  snapshot: RunExecutionSnapshot;
  environmentFact: EnvironmentChangeFact | null;
  sessionTitle?: string;
  acceptedAt: Date;
};

export interface RunRepository {
  getSession(sessionId: string): Promise<SessionRecord | null>;
  findBridgeIntent(sessionId: string, intentId: string): Promise<{ digest: string } | null>;
  createRunIntent(input: CreateRunIntentInput): Promise<RunIntent>;
  requestCancellation(runId: string, requestedAt: Date): Promise<void>;
  acceptRun(input: AcceptRunInput): Promise<AdmissionDisposition>;
  rejectRun(runId: string, errorClass: string, rejectedAt: Date): Promise<"failed" | "cancelled">;
}
