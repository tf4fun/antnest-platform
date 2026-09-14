import { z } from "zod";
import { DomainError } from "./errors.js";

const identifier = z.string().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const agentSettlementRequestSchema = z.strictObject({
  organization_id: identifier,
  agent_id: identifier,
  minimum_revision: revision,
  operation_id: identifier,
  mode: z.enum(["wait", "cancel"]),
  deadline_at: z.iso.datetime(),
});

export const agentSettlementResultSchema = z.strictObject({
  applied_revision: revision,
  outcome: z.enum(["settled", "runtime_barrier_required", "not_settled"]),
});

export type AgentSettlementRequest = z.infer<typeof agentSettlementRequestSchema>;
export type AgentSettlementResult = z.infer<typeof agentSettlementResultSchema>;

export function parseAgentSettlement(input: unknown): AgentSettlementRequest {
  const parsed = agentSettlementRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("invalid_agent_settlement", "Invalid Agent settlement request");
  }
  return parsed.data;
}
