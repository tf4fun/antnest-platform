import type { ConnectionBinding, ModelToolDefinition } from "../domain/types.js";
import type { ModelToolCall } from "./model.js";
import type { PermissionDecision } from "../domain/tool-permissions.js";
import type { Authorization } from "../domain/session-configuration.js";

export type PermissionRequest = {
  runId: string;
  sessionId: string;
  call: ModelToolCall;
  tool: ModelToolDefinition;
};
export type PermissionOwner = Pick<ConnectionBinding, "principalId" | "agentId" | "accessRevision">;
export type PermissionResult = { decision: PermissionDecision; reason: string };

export interface ToolPermissionPort {
  request(
    input: PermissionRequest & { signal: AbortSignal; authoritySignal: AbortSignal },
  ): Promise<PermissionResult>;
}
export interface PermissionRepository {
  open(request: PermissionRequest): Promise<PermissionOwner>;
  decide(input: {
    request: PermissionRequest;
    result: PermissionResult;
    rule?: Authorization["toolRules"][number];
    signal?: AbortSignal;
    authoritySignal?: AbortSignal;
  }): Promise<boolean>;
  cancelAbandoned(): Promise<void>;
}
export type PermissionConnection = {
  binding: ConnectionBinding;
  sessionId: string;
  signal: AbortSignal;
  request(request: PermissionRequest, signal: AbortSignal): Promise<unknown>;
};
export interface PermissionConnectionsPort {
  attach(connection: PermissionConnection): void;
  detach(sessionId: string): void;
}
