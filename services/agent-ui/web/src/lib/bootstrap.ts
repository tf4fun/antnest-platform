import { z } from "zod";
import type { WorkspaceSnapshot } from "./types";

const bootstrapSchema = z.object({
  principal: z.object({
    user_id: z.string().min(1),
    organization_id: z.string().min(1),
    administrator: z.boolean(),
  }),
  agents: z.array(z.object({
    agent_id: z.string().min(1),
    name: z.string().min(1),
  })).refine(agents => new Set(agents.map(agent => agent.agent_id)).size === agents.length, "Duplicate Agent identifiers"),
});

export function workspaceFromBootstrap(payload: unknown): WorkspaceSnapshot {
  const bootstrap = bootstrapSchema.parse(payload);
  return {
    principal: {
      userId: bootstrap.principal.user_id,
      organizationId: bootstrap.principal.organization_id,
      displayName: bootstrap.principal.administrator ? "Administrator" : "Signed in",
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
    })),
    conversations: [],
    activeAgentId: "",
    activeConversationId: null,
    preview: false,
  };
}
