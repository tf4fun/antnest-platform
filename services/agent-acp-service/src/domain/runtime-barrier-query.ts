import { z } from "zod";
import { DomainError } from "./errors.js";

const identifier = z.string().regex(/^\S{1,200}$/u);

export const runtimeBarrierQueryRequestSchema = z.strictObject({
  organization_id: identifier,
  agent_id: identifier,
  expected_runtime_revision: identifier,
});

export const runtimeBarrierQueryResultSchema = z.strictObject({
  organization_id: identifier,
  agent_id: identifier,
  runtime_revision: identifier,
  barrier: z
    .strictObject({
      barrier_id: identifier,
      reason: z.literal("runtime_barrier_required"),
      runtime_execution_id: identifier,
    })
    .nullable(),
});

export type RuntimeBarrierQueryRequest = z.infer<typeof runtimeBarrierQueryRequestSchema>;
export type RuntimeBarrierQueryResult = z.infer<typeof runtimeBarrierQueryResultSchema>;

export function parseRuntimeBarrierQuery(input: unknown): RuntimeBarrierQueryRequest {
  const parsed = runtimeBarrierQueryRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("invalid_request", "Invalid Runtime barrier query request");
  }
  return parsed.data;
}

export function parseRuntimeBarrierQueryResult(input: unknown): RuntimeBarrierQueryResult {
  const parsed = runtimeBarrierQueryResultSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid Runtime barrier query result");
  return parsed.data;
}
