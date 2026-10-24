import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { AgentExecutionStateView } from "../domain/agent-execution-state.js";
import type { AgentOwnershipFence } from "../domain/agent-ownership.js";

export type ExecutionStateIdentity = ExecutionIdentity & { ownerFence?: AgentOwnershipFence };

// Enqueue synchronously after the final authorization check, then await only
// transport backpressure. Do not buffer undispatched state across revocation.
export type ExecutionStateSink = (
  state: AgentExecutionStateView,
  signal: AbortSignal,
) => Promise<void>;

export interface AgentExecutionStatePort {
  read(
    identity: ExecutionStateIdentity,
    send: ExecutionStateSink,
    signal: AbortSignal,
  ): Promise<void>;
  watch(
    identity: ExecutionStateIdentity,
    send: ExecutionStateSink,
    signal: AbortSignal,
  ): Promise<void>;
}
