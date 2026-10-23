import type { AgentOwnershipFence, AgentOwnershipScope } from "../domain/agent-ownership.js";

export type AgentLease = Readonly<{
  fence: AgentOwnershipFence;
  expiresAt: Date;
  observedAt: Date;
}>;

export interface AgentLeases {
  tryAcquire(
    scope: AgentOwnershipScope,
    ownerInstanceId: string,
    durationMs: number,
  ): Promise<AgentLease | null>;
  renew(fence: AgentOwnershipFence, durationMs: number): Promise<AgentLease | null>;
  release(fence: AgentOwnershipFence): Promise<boolean>;
  // A snapshot can be expired and never substitutes for a transaction fence.
  read(scope: AgentOwnershipScope): Promise<AgentLease | null>;
}
