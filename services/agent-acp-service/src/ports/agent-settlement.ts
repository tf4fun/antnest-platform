import type { AgentSettlementResult } from "../domain/agent-settlement.js";
import type { OwnerRegistration } from "../application/owner-incarnation.js";
import type { ExecutionPublication } from "../domain/execution-publication.js";

export type AgentSettlementAuthority = Readonly<{
  owner: OwnerRegistration;
  publication: ExecutionPublication;
}>;

export interface AgentSettlementPort {
  settle(
    input: unknown,
    signal?: AbortSignal,
    expected?: AgentSettlementAuthority,
  ): Promise<AgentSettlementResult>;
}
