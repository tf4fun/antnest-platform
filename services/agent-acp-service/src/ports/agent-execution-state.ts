import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { AgentExecutionStateView } from "../domain/agent-execution-state.js";

// Enqueue synchronously after the final authorization check, then await only
// transport backpressure. Do not buffer undispatched state across revocation.
export type ExecutionStateSink = (
  state: AgentExecutionStateView,
  signal: AbortSignal,
) => Promise<void>;

export interface AgentExecutionStatePort {
  read(identity: ExecutionIdentity, send: ExecutionStateSink, signal: AbortSignal): Promise<void>;
  watch(identity: ExecutionIdentity, send: ExecutionStateSink, signal: AbortSignal): Promise<void>;
}
