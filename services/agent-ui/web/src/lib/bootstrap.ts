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
    availability: z.enum(["ready", "busy", "offline"]),
  })),
});

export function workspaceFromBootstrap(payload: unknown): WorkspaceSnapshot {
  const bootstrap = bootstrapSchema.parse(payload);
  return {
    principal: {
      displayName: bootstrap.principal.administrator ? "Administrator" : "Signed in",
      organizationName: "Organization workspace",
      administrator: bootstrap.principal.administrator,
    },
    connection: "connecting",
    agents: bootstrap.agents.map((agent) => ({
      id: agent.agent_id,
      name: agent.name,
      description: "Managed by your organization",
      modelLabel: "Platform managed",
      status: agent.availability,
    })),
    conversations: [],
    activeAgentId: bootstrap.agents[0]?.agent_id ?? "",
    activeConversationId: null,
    preview: false,
  };
}
