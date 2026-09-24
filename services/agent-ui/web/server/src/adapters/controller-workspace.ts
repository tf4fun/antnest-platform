import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BootstrapScope } from "../http/bootstrap-routes.ts";
import { withActiveHttpTrace } from "../telemetry.ts";

const pageLimit = 200;
const maximumPages = 100;
const maximumResponseBytes = 2 * 1024 * 1024;
const agentSchema = z.object({
  agent_id: z.string().min(1).max(200),
  name: z.string().min(1),
  lifecycle_state: z.enum(["not_created", "created", "deleted"]),
  activation_state: z.enum(["enabled", "disabled"]).optional(),
  runtime_state: z.enum(["unknown", "waiting", "available", "unhealthy", "exited", "absent"]),
}).passthrough();
const pageSchema = z.object({
  agents: z.array(agentSchema).max(pageLimit),
  next_cursor: z.string().min(1).max(4096).nullable(),
});

export type ControllerWorkspaceAgent = z.infer<typeof agentSchema>;

export async function discoverWorkspaceAgents(input: {
  baseUrl: URL;
  scope: BootstrapScope;
  fetchImpl?: typeof fetch;
}): Promise<ControllerWorkspaceAgent[]> {
  const target = new URL("/rpc/agent-controller/list-workspace-agents", input.baseUrl);
  const fetcher = withActiveHttpTrace(input.fetchImpl ?? fetch);
  const agents: ControllerWorkspaceAgent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  const signal = AbortSignal.timeout(20_000);
  for (let page = 0; page < maximumPages; page++) {
    const response = await fetcher(target, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        request_id: `${randomUUID()}-page-${page + 1}`,
        organization_id: input.scope.organizationId,
        principal_id: input.scope.principalId,
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      signal,
    });
    if (!response.ok)
      throw new Error(`Controller workspace request failed with status ${response.status}`);
    const raw = await readBoundedJSON(response);
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("Controller workspace response is invalid");
    agents.push(...parsed.data.agents);
    if (parsed.data.next_cursor === null) return agents;
    cursor = parsed.data.next_cursor;
    if (seenCursors.has(cursor))
      throw new Error("Controller repeated a workspace cursor");
    seenCursors.add(cursor);
  }
  throw new Error("Controller workspace pagination exceeded its bound");
}

async function readBoundedJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new Error("Controller workspace response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new Error("Controller workspace response exceeds limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Controller workspace response is invalid JSON");
  }
}
