import { afterEach, expect, it, vi } from "vitest";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import type { AgentExecutionStatePort } from "../../src/ports/agent-execution-state.js";
import {
  testAuthentication,
  testHeaders,
  workloadHeaders,
  signContext,
} from "../support/auth-fixture.js";
import { CALLER_CONTEXT_HEADER } from "../../src/adapters/caller-context.js";
import { SERVICE_AUTH_HEADER } from "../../src/adapters/service-authentication.js";
import { request as httpRequest } from "node:http";

let server: AgentAcpHttpServer | undefined;
afterEach(async () => {
  await server?.close();
});

it("rejects forged identity headers before reading execution state", async () => {
  const read = vi.fn<AgentExecutionStatePort["read"]>((_identity, send, signal) =>
    send(
      {
        agent_id: "agent-1",
        access_allowed: true,
        configuration_revision: "1",
        availability: "ready",
        active_session_id: null,
        unavailable_reason: null,
      },
      signal,
    ),
  );
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: {} as AcpApplicationPort,
    executionState: { read, watch: vi.fn() },
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 65536,
  });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/rpc/agent-acp/get-agent-execution-state`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Antnest-Organization-Id": "organization-1",
        "X-Antnest-Principal-Id": "principal-1",
        "X-Antnest-Agent-Id": "agent-1",
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});

async function fixture() {
  const read = vi.fn<AgentExecutionStatePort["read"]>((_identity, sink, signal) =>
    sink(
      {
        agent_id: "agent-1",
        access_allowed: true,
        configuration_revision: "1",
        availability: "ready",
        active_session_id: null,
        unavailable_reason: null,
      },
      signal,
    ),
  );
  const apply = vi
    .fn()
    .mockResolvedValue({ organization_id: "organization-1", applied_revision: 1 });
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: {} as AcpApplicationPort,
    executionState: { read, watch: vi.fn() },
    executionConfiguration: { apply },
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 65536,
  });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return { read, apply, base: `http://127.0.0.1:${address.port}` };
}
const workspace = () => testHeaders({ "x-antnest-agent-id": "agent-1" });
it.each([
  ["no workload", {}, 401, "service_unauthenticated"],
  ["wrong workload", workloadHeaders("agent-controller"), 403, "caller_not_allowed"],
  ["no context", workloadHeaders("edge-gateway"), 401, "caller_context_required"],
  [
    "wrong audience",
    {
      ...workloadHeaders("edge-gateway"),
      [CALLER_CONTEXT_HEADER]: signContext({ agt: "agent-1", aud: ["agent-ui"] }),
    },
    401,
    "caller_context_invalid",
  ],
  [
    "expired",
    {
      ...workloadHeaders("edge-gateway"),
      [CALLER_CONTEXT_HEADER]: signContext({ agt: "agent-1", iat: 1, exp: 61 }),
    },
    401,
    "caller_context_invalid",
  ],
  [
    "unscoped",
    { ...workloadHeaders("edge-gateway"), [CALLER_CONTEXT_HEADER]: signContext() },
    401,
    "caller_context_invalid",
  ],
] as const)("rejects %s before business effects", async (_label, credentials, status, code) => {
  const f = await fixture();
  const response = await fetch(`${f.base}/rpc/agent-acp/get-agent-execution-state`, {
    method: "POST",
    headers: { ...credentials, "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code, retryable: false });
  expect(response.headers.get("www-authenticate")).toBe(
    code === "service_unauthenticated" ? 'Bearer realm="antnest-service"' : null,
  );
  expect(f.read).not.toHaveBeenCalled();
});
it("derives identity from signed claims despite forged hints", async () => {
  const f = await fixture();
  const response = await fetch(`${f.base}/rpc/agent-acp/get-agent-execution-state`, {
    method: "POST",
    headers: {
      ...workspace(),
      "content-type": "application/json",
      "x-antnest-agent-id": "forged",
      "x-antnest-organization-id": "forged",
      "x-antnest-principal-id": "forged",
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(f.read.mock.calls[0]?.[0]).toEqual({
    organizationId: "organization-1",
    principalId: "principal-1",
    agentId: "agent-1",
  });
});
it.each([
  ["duplicate member", '{"x":1,"x":2}', "application/json", 400],
  ["escaped duplicate", '{"x":1,"\\u0078":2}', "application/json", 400],
  ["nested duplicate", '{"x":{"v":1,"v":2}}', "application/json", 400],
  ["wrong casing", '{"Agent_ID":"agent-1"}', "application/json", 400],
  ["multiple documents", "{}{}", "application/json", 400],
  ["wrong charset", "{}", "application/json; charset=latin1", 415],
  ["unknown parameter", "{}", "application/json; profile=x", 415],
  ["duplicate charset", "{}", "application/json; charset=utf-8; charset=utf-8", 415],
  ["non object", "null", "application/json", 400],
] as const)("rejects %s before reading state", async (_label, body, media, status) => {
  const f = await fixture();
  const response = await fetch(`${f.base}/rpc/agent-acp/get-agent-execution-state`, {
    method: "POST",
    headers: { ...workspace(), "content-type": media },
    body,
  });
  expect(response.status).toBe(status);
  await response.text();
  expect(f.read).not.toHaveBeenCalled();
});
it.each([SERVICE_AUTH_HEADER, CALLER_CONTEXT_HEADER, "Content-Type"])(
  "rejects two raw %s fields",
  async (duplicate) => {
    const f = await fixture();
    const headers: Record<string, string> = { ...workspace(), "Content-Type": "application/json" };
    const entries = Object.entries(headers).flat();
    entries.push("Host", new URL(f.base).host, "Content-Length", "2");
    entries.push(duplicate, headers[duplicate]!);
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        `${f.base}/rpc/agent-acp/get-agent-execution-state`,
        { method: "POST", headers: entries },
        (reply) => {
          const chunks: Buffer[] = [];
          reply.on("data", (chunk: Buffer) => chunks.push(chunk));
          reply.once("end", () =>
            resolve({ status: reply.statusCode!, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    expect(response.status).toBe(duplicate === "Content-Type" ? 415 : 401);
    expect(f.read).not.toHaveBeenCalled();
  },
);
it("hides Controller publication on the workspace listener before invoking the publisher", async () => {
  const f = await fixture();
  const response = await fetch(`${f.base}/rpc/agent-acp/apply-execution-snapshot`, {
    method: "POST",
    headers: { ...workspace(), "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(404);
  await response.text();
  expect(f.apply).not.toHaveBeenCalled();
});
