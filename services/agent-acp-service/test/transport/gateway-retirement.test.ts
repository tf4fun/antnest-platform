import { readFileSync } from "node:fs";
import { IncomingMessage, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CALLER_CONTEXT_HEADER, CallerContextVerifier } from "../../src/adapters/caller-context.js";
import { RequestAuthentication } from "../../src/transport/request-authentication.js";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { authenticatedCaller, trustedIdentity } from "../../src/transport/trusted-identity.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import {
  signContext,
  testAuthentication,
  testJwks,
  workloadHeaders,
} from "../support/auth-fixture.js";

const routes = [
  ["POST", "/v1/acp"],
  ["GET", "/v1/acp"],
  ["DELETE", "/v1/acp"],
  ["UPGRADE", "/v1/acp"],
  ["UPGRADE", "/v2/acp"],
  ["POST", "/rpc/agent-acp/get-agent-execution-state"],
  ["POST", "/rpc/agent-acp/watch-agent-execution-state"],
  ["GET", "/rpc/agent-acp/workspace/agents/agent-1/learning-status"],
  ["GET", "/rpc/agent-acp/workspace/agents/agent-1/learning-changes"],
  ["GET", "/rpc/agent-acp/workspace/sessions/session-1/execution"],
  ["GET", "/rpc/agent-acp/workspace/sessions/session-1/intents/intent-1"],
] as const;
const claims = () =>
  signContext({
    agt: "agent-1",
    aud: ["agent-ui", "agent-acp-service", "agent-controller"],
  });

function coldAuthentication(unavailable = false) {
  const keys = vi.fn(() =>
    Promise.resolve(unavailable ? new Response(null, { status: 503 }) : Response.json(testJwks())),
  );
  const workload = testAuthentication().workload;
  return {
    keys,
    authentication: new RequestAuthentication(
      workload,
      new CallerContextVerifier("http://identity.invalid/", keys),
    ),
  };
}

for (const context of ["valid", "missing", "forged", "duplicate", "unavailable keys"] as const) {
  it.each(routes)(
    `rejects configured Gateway before ${context} context processing on %s %s`,
    async (method, path) => {
      const { authentication, keys } = coldAuthentication(context === "unavailable keys");
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.method = method === "UPGRADE" ? "GET" : method;
      request.url = path;
      request.rawHeaders = Object.entries(workloadHeaders("edge-gateway")).flat();
      if (context !== "missing")
        request.rawHeaders.push(CALLER_CONTEXT_HEADER, context === "forged" ? "forged" : claims());
      if (context === "duplicate") request.rawHeaders.push("antnest-caller-context", claims());
      try {
        expect(authentication.workload.authenticate(request, ["edge-gateway"])).toMatchObject({
          code: null,
          http_status: 200,
          caller: "edge-gateway",
        });
        expect(await authentication.admit(request, method === "UPGRADE")).toEqual({
          status: 403,
          code: "caller_not_allowed",
        });
        expect(keys).not.toHaveBeenCalled();
        expect(authenticatedCaller(request)).toBeUndefined();
        expect(trustedIdentity(request.headers)).toBeNull();
      } finally {
        socket.destroy();
      }
    },
  );
}

it.each(routes)(
  "retains signed ordinary-member Agent UI admission on %s %s",
  async (method, path) => {
    const { authentication, keys } = coldAuthentication();
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.method = method === "UPGRADE" ? "GET" : method;
    request.url = path;
    request.rawHeaders = Object.entries({
      ...workloadHeaders("agent-ui"),
      [CALLER_CONTEXT_HEADER]: claims(),
    }).flat();
    request.headers["x-antnest-agent-id"] = "forged-agent";
    try {
      expect(await authentication.admit(request, method === "UPGRADE")).toHaveProperty(
        "claims.org_role",
        "member",
      );
      expect(keys).toHaveBeenCalledOnce();
      expect(authenticatedCaller(request)).toBe("agent-ui");
      expect(trustedIdentity(request.headers)).toEqual({
        agentId: "agent-1",
        organizationId: "organization-1",
        principalId: "principal-1",
      });
      expect(request.headers["x-antnest-agent-id"]).toBeUndefined();
    } finally {
      socket.destroy();
    }
  },
);

it("retires Gateway from the entire caller catalog while retaining all 11 Agent UI routes", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../../../../contracts/agent-acp/callers.json", import.meta.url), "utf8"),
  ) as {
    routes: Record<string, { callers: string[]; caller_context: Record<string, string> }>;
  };
  const retained = Object.entries(catalog.routes).filter(([, policy]) =>
    policy.callers.includes("agent-ui"),
  );
  expect(retained).toHaveLength(11);
  for (const policy of Object.values(catalog.routes)) {
    expect(policy.callers).not.toContain("edge-gateway");
    expect(policy.caller_context).not.toHaveProperty("edge-gateway");
  }
  expect(
    retained
      .map(([route]) =>
        route
          .replace("{agent_id}", "agent-1")
          .replace("{session_id}", "session-1")
          .replace("{intent_id}", "intent-1"),
      )
      .sort(),
  ).toEqual(routes.map(([method, path]) => `${method} ${path}`).sort());
  for (const [, policy] of retained) expect(policy.caller_context["agent-ui"]).toBe("required");
});

let server: AgentAcpHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

it.each(routes)(
  "rejects retired Gateway at the real %s %s listener before readiness and business work",
  async (method, path) => {
    const { authentication, keys } = coldAuthentication();
    const ready = vi.fn(() => Promise.resolve(true));
    const access = vi.fn<AcpApplicationPort["assertAccess"]>().mockResolvedValue(undefined);
    const read = vi.fn(() => Promise.reject(new Error("unexpected business query")));
    const watch = vi.fn(() => Promise.reject(new Error("unexpected business watch")));
    server = new AgentAcpHttpServer({
      authentication,
      application: {
        assertAccess: access,
        getSessionConfiguration: read,
        setSessionConfiguration: read,
        readSessionOutput: read,
        createSession: read,
        listSessions: read,
        deleteSession: read,
        forkSession: read,
        resumeSession: read,
        closeSession: read,
        cancelRun: read,
        acceptPrompt: read,
      },
      executionState: { read, watch },
      learningStatus: { read },
      learningChanges: { list: read },
      bridgeObservation: { readIntent: read, readSession: read },
      ready,
      maxWebSocketPayloadBytes: 65536,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}${path}`;
    const headers = { ...workloadHeaders("edge-gateway"), [CALLER_CONTEXT_HEADER]: claims() };
    let received: { status: number; headers: IncomingHttpHeaders; text: string };
    if (method === "UPGRADE") {
      received = await new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>(
        (resolve, reject) => {
          const request = httpRequest(url, {
            agent: false,
            signal: AbortSignal.timeout(5000),
            headers: {
              ...headers,
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Version": "13",
              "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
            },
          });
          request.once("error", reject);
          request.once("upgrade", (_response, socket) => {
            socket.destroy();
            request.destroy();
            reject(new Error("Retired Gateway accepted a WebSocket upgrade"));
          });
          request.once("response", (response) => {
            const chunks: Buffer[] = [];
            let ended = false;
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
              ended = true;
            });
            response.once("close", () => {
              if (!ended || !response.complete) {
                reject(new Error("Retired Gateway rejection did not finish before close"));
                return;
              }
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                text: Buffer.concat(chunks).toString("utf8"),
              });
            });
            response.once("error", reject);
          });
          request.end();
        },
      );
    } else {
      const response = await fetch(url, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        // A malformed body must not bypass the earlier workload denial.
        ...(method === "POST" ? { body: "{" } : {}),
        signal: AbortSignal.timeout(5000),
      });
      received = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
    }
    expect(received.status).toBe(403);
    const body: unknown = JSON.parse(received.text);
    expect(body).toEqual({
      code: "caller_not_allowed",
      message: "Service caller is not allowed",
      retryable: false,
    });
    expect((received.text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length).toBe(3);
    expect(received.headers.connection).toBe("close");
    for (const name of ["antnest-caller-context", "antnest-service-authorization", "set-cookie"])
      expect(received.headers[name]).toBeUndefined();
    expect(keys).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  },
);
