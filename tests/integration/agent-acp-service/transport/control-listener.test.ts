import { afterEach, expect, it, vi } from "vitest";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { WebSocket } from "ws";

let server: AgentAcpHttpServer | undefined;
afterEach(async () => {
  await server?.close();
});

it.each(["apply-execution-snapshot", "settle-agent"])(
  "never exposes Controller %s on the workspace listener, even with valid credentials",
  async (operation) => {
    const apply = vi.fn().mockResolvedValue({
      organization_id: "organization-1",
      applied_revision: 1,
    });
    const settle = vi.fn();
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: {} as AcpApplicationPort,
      executionConfiguration: { apply },
      settlement: { settle },
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 65536,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    for (const method of ["POST", "GET"]) {
      for (const suffix of ["", "?probe=1"]) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/rpc/agent-acp/${operation}${suffix}`,
          {
            method,
            headers: {
              ...workloadHeaders("agent-controller"),
              "content-type": "application/json",
            },
            ...(method === "POST" ? { body: "{}" } : {}),
          },
        );
        expect(response.status).toBe(404);
        await response.text();
      }
    }
    expect(apply).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  },
);

it("admits only Controller on control routes, excludes workspace traffic, and closes both listeners", async () => {
  const apply = vi.fn().mockResolvedValue({
    organization_id: "organization-1",
    applied_revision: 1,
  });
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application: {} as AcpApplicationPort,
    executionConfiguration: { apply },
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 65536,
  });
  await server.listenControl("127.0.0.1", 0);
  await server.listen("127.0.0.1", 0);
  const control = server.controlAddress();
  const workspace = server.address();
  if (
    !control ||
    typeof control === "string" ||
    !workspace ||
    typeof workspace === "string"
  )
    throw new Error("Missing listeners");
  const origin = `http://127.0.0.1:${control.port}`;
  for (const [credentials, status] of [
    [{}, 401],
    [workloadHeaders("edge-gateway"), 403],
    [workloadHeaders("agent-controller"), 200],
  ] as const) {
    const response = await fetch(
      `${origin}/rpc/agent-acp/apply-execution-snapshot`,
      {
        method: "POST",
        headers: { ...credentials, "content-type": "application/json" },
        body: JSON.stringify(executionConfiguration()),
      },
    );
    expect(response.status).toBe(status);
    await response.text();
    expect(apply).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  }
  for (const path of [
    "/v1/acp",
    "/rpc/agent-acp/get-agent-execution-state",
    "/internal/skill-sources/inspect",
  ]) {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: workloadHeaders("agent-controller"),
      body: "{}",
    });
    expect(response.status).toBe(404);
    await response.text();
  }
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/acp");
  await new Promise<void>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      expect(response.statusCode).toBe(404);
      response.resume();
      response.once("end", () => {
        socket.terminate();
        resolve();
      });
    });
    socket.once("error", reject);
  });
  await server.close();
  expect(server.address()).toBeNull();
  expect(server.controlAddress()).toBeNull();
});
