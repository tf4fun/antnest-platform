import { createServer } from "node:http";
import {
  lifecycleKinds,
  lifecycleAgent,
  lifecycleTrace,
  publicationTrace,
  retainedAgent,
  temporaryAgent,
  lifecycleOrganization,
} from "./development-lifecycle.mjs";

export async function lifecycleServer(options = {}) {
  const f = {
    retainedId: retainedAgent,
    temporaryId: temporaryAgent,
    organization: lifecycleOrganization,
    retained: lifecycleAgent("create", retainedAgent),
    publications: [1, 2, 3].map((n) => publicationTrace(n)),
    lifecycles: Object.fromEntries(
      lifecycleKinds.map((kind) => [kind, lifecycleTrace(kind)]),
    ),
    requests: [],
    stage: null,
    mutationError: undefined,
    ...options,
  };
  f.retained.name = "retained fixture";
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      f.requests.push({ url: request.url, method: request.method, body });
      let value,
        status = 200,
        traceID;
      if (request.url === "/api/session/login")
        value = { principal: { organization_id: f.organization } };
      else if (request.url === `/api/admin/agents/${f.retainedId}`)
        value = f.retained;
      else if (request.url.startsWith("/api/traces?"))
        value = {
          data: f.searchResponse ? f.searchResponse() : f.publications,
        };
      else if (request.url.startsWith("/api/traces/")) {
        const id = request.url.slice("/api/traces/".length);
        const trace = [
          ...f.publications,
          ...Object.values(f.lifecycles).map((x) => x.trace),
        ].find((t) => t.traceID === id);
        value = {
          data: trace ? [f.traceResponse ? f.traceResponse(trace) : trace] : [],
        };
      } else if (request.url.startsWith("/api/admin/operations/"))
        value = { state: f.operationState ?? "completed" };
      else if (request.url === `/api/app/agents/${f.temporaryId}/state`)
        value = {
          agent_id: f.temporaryId,
          availability: "offline",
          unavailable_reason: "agent_unavailable",
          ...f.appState,
        };
      else if (request.url === `/api/admin/agents/${f.temporaryId}`) {
        value = lifecycleAgent(f.stage, f.temporaryId);
        if (f.agentResponse) value = f.agentResponse(value);
      } else if (
        request.method === "POST" &&
        (request.url === "/api/admin/agents" ||
          request.url.startsWith(`/api/admin/agents/${f.temporaryId}/`))
      ) {
        const kind =
          request.url === "/api/admin/agents"
            ? "create"
            : request.url.split("/").at(-1);
        if (!lifecycleKinds.includes(kind))
          throw new Error("unknown transition");
        await f.transition?.(kind, JSON.parse(body), f);
        f.stage = kind;
        const expected = f.lifecycles[kind].expected;
        traceID = expected.traceID;
        status = 202;
        value =
          kind === "create"
            ? {
                agent: { agent_id: f.createdId ?? f.temporaryId },
                operation: { request_id: expected.requestId },
              }
            : { request_id: expected.requestId };
      } else {
        value = {};
        status = 404;
      }
      response.writeHead(status, {
        "content-type": "application/json",
        ...(traceID ? { "x-antnest-trace-id": traceID } : {}),
      });
      response.end(JSON.stringify(value));
    } catch (error) {
      f.mutationError = error;
      response.writeHead(500);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  f.origin = "http://127.0.0.1:" + server.address().port;
  f.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return f;
}
