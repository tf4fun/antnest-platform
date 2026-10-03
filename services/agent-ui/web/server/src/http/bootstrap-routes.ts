import { z } from "zod";
import { error, json } from "./command-routes.ts";
import { readWorkspacePrincipal } from "./workspace-principal.ts";
import { bindScopeContext, verifiedRequestContext } from "./trusted-identity.ts";

export type BootstrapScope = { organizationId: string; principalId: string };

const workspaceAgent = z.object({
  agent_id: z.string().min(1).max(200),
  name: z.string().min(1),
  lifecycle_state: z.enum(["not_created", "created", "deleted"]),
  activation_state: z.enum(["enabled", "disabled"]).optional(),
  runtime_state: z.enum(["unknown", "waiting", "available", "unhealthy", "exited", "absent"]),
}).passthrough();

export function createBootstrapHandler(dependencies: {
  discover(scope: BootstrapScope): Promise<unknown>;
  epoch: string;
  now(): number;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    if (new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap")
      return null;
    if (request.method !== "GET")
      return error(405, "method_not_allowed", "Method is not allowed", "none");
    const principal = readWorkspacePrincipal(request.headers);
    if (principal === null)
      return error(401, "unauthenticated", "Trusted identity is missing", "login");
    try {
      const scope = { organizationId: principal.organizationId, principalId: principal.userId };
      bindScopeContext(scope, verifiedRequestContext(request.headers)!);
      const raw = await dependencies.discover(scope);
      const agents = z.array(workspaceAgent).max(20_000).parse(raw);
      const seen = new Set<string>();
      const projected = agents.map((agent) => {
        if (agent.name.trim() === "" || seen.has(agent.agent_id) ||
          (agent.lifecycle_state === "created") !== (agent.activation_state !== undefined))
          throw new Error("Controller workspace directory is invalid");
        seen.add(agent.agent_id);
        return {
          agentId: agent.agent_id,
          name: agent.name,
          lifecycle: agent.lifecycle_state,
          ...(agent.activation_state === undefined ? {} : { activation: agent.activation_state }),
          runtime: agent.runtime_state,
        };
      });
      return json({
        principal,
        agents: projected,
        renderedAt: new Date(dependencies.now()).toISOString(),
        bridgeEpoch: dependencies.epoch,
      });
    } catch {
      return error(503, "workspace_unavailable", "Agent workspace is unavailable", "retry_read");
    }
  };
}
