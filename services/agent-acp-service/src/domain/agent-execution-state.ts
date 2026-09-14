import { z } from "zod";

export const agentExecutionStateRequestSchema = z.strictObject({});
const authorizedState = z.strictObject({
  agent_id: z.string().min(1).max(200),
  access_allowed: z.literal(true),
  configuration_revision: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const agentExecutionStateSchema = z.union([
  authorizedState.extend({
    availability: z.literal("ready"),
    active_session_id: z.null(),
    unavailable_reason: z.null(),
  }),
  authorizedState.extend({
    availability: z.literal("busy"),
    active_session_id: z.string().min(1).max(200).nullable(),
    unavailable_reason: z.literal("agent_unavailable").nullable(),
  }),
  authorizedState.extend({
    availability: z.literal("offline"),
    active_session_id: z.null(),
    unavailable_reason: z.enum(["agent_unavailable", "runtime_barrier_required"]),
  }),
  z.strictObject({
    agent_id: z.string().min(1).max(200),
    access_allowed: z.literal(false),
    availability: z.literal("offline"),
    active_session_id: z.null(),
    configuration_revision: z.null(),
    unavailable_reason: z.literal("access_denied"),
  }),
]);

export type AgentExecutionStateView = z.infer<typeof agentExecutionStateSchema>;
