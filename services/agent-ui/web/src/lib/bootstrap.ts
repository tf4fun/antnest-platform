import { z } from "zod";
import type { WorkspaceSnapshot } from "./types";

const bootstrapSchema = z.object({
  principal: z.object({
    user_id: z.string().min(1),
    organization_id: z.string().min(1),
    administrator: z.boolean(),
  }),
  agents: z
    .array(
      z
        .object({
          agent_id: z.string().min(1),
          name: z.string().min(1),
          lifecycle_state: z.enum(["not_created", "created", "deleted"]),
          activation_state: z.enum(["enabled", "disabled"]).optional(),
          runtime_state: z.enum([
            "unknown",
            "waiting",
            "available",
            "unhealthy",
            "exited",
            "absent",
          ]),
        })
        .refine(
          (agent) =>
            (agent.lifecycle_state === "created") ===
            (agent.activation_state !== undefined),
          "Activation state belongs to a created Agent",
        ),
    )
    .refine(
      (agents) =>
        new Set(agents.map((agent) => agent.agent_id)).size === agents.length,
      "Duplicate Agent identifiers",
    ),
});

const bridgeBootstrapSchema = z.strictObject({
  principal: z.strictObject({
    userId: z.string().min(1),
    organizationId: z.string().min(1),
    administrator: z.boolean(),
  }),
  agents: z.array(z.strictObject({
    agentId: z.string().min(1),
    name: z.string().min(1),
    lifecycle: z.enum(["not_created", "created", "deleted"]),
    activation: z.enum(["enabled", "disabled"]).optional(),
    runtime: z.enum(["unknown", "waiting", "available", "unhealthy", "exited", "absent"]),
  }).refine((agent) => (agent.lifecycle === "created") ===
    (agent.activation !== undefined))),
  renderedAt: z.string().min(1),
  bridgeEpoch: z.string().min(1),
});

export function workspaceFromBridgeBootstrap(payload: unknown): WorkspaceSnapshot {
  const bootstrap = bridgeBootstrapSchema.parse(payload);
  return workspaceFromBootstrap({
    principal: {
      user_id: bootstrap.principal.userId,
      organization_id: bootstrap.principal.organizationId,
      administrator: bootstrap.principal.administrator,
    },
    agents: bootstrap.agents.map((agent) => ({
      agent_id: agent.agentId,
      name: agent.name,
      lifecycle_state: agent.lifecycle,
      ...(agent.activation === undefined ? {} : { activation_state: agent.activation }),
      runtime_state: agent.runtime,
    })),
  });
}

export function workspaceFromBootstrap(payload: unknown): WorkspaceSnapshot {
  const bootstrap = bootstrapSchema.parse(payload);
  return {
    principal: {
      userId: bootstrap.principal.user_id,
      organizationId: bootstrap.principal.organization_id,
      displayName: bootstrap.principal.administrator
        ? "Administrator"
        : "Signed in",
      organizationName: "Organization workspace",
      administrator: bootstrap.principal.administrator,
    },
    connection: "offline",
    agents: bootstrap.agents.map((agent) => ({
      id: agent.agent_id,
      name: agent.name,
      description: "Managed by your organization",
      modelLabel: "Platform managed",
      status: "unknown",
      managementState: {
        lifecycle: agent.lifecycle_state,
        activation: agent.activation_state,
        runtime: agent.runtime_state,
      },
    })),
    conversations: [],
    activeAgentId: "",
    activeConversationId: null,
    preview: false,
  };
}
