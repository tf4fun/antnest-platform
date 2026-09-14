import type { AgentSettlementResult } from "../domain/agent-settlement.js";

export interface AgentSettlementPort {
  settle(input: unknown, signal?: AbortSignal): Promise<AgentSettlementResult>;
}
