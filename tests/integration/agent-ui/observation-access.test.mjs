import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createTestWorkspaceHttpServer, testHeaders } from "./auth-fixture.mjs";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { parseExecutionObservation } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";

for (const [name, status, body, expectedStatus, expectedCode] of [
  [
    "Agent access denied",
    403,
    { code: "access_denied", message: "Agent access denied", retryable: false },
    403,
    "access_denied",
  ],
  [
    "hidden Session",
    404,
    {
      code: "session_not_found",
      message: "Session not found",
      retryable: false,
    },
    404,
    "session_not_found",
  ],
  [
    "dependency unavailable",
    503,
    { code: "workspace_observation_unavailable", retryable: true },
    503,
    "upstream_unavailable",
  ],
  [
    "downstream caller invalid",
    401,
    { code: "caller_context_invalid", retryable: false },
    503,
    "upstream_unavailable",
  ],
]) {
  test(`real HTTP prompt admission preserves ${name} with the original signed context`, async () => {
    let failure = false,
      dispatched = 0;
    const reads = [];
    const observation = createServer((request, response) => {
      reads.push(request.url);
      response.writeHead(failure ? status : 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify(
          failure
            ? body
            : {
                sessionId: "session-1",
                appendVersion: 0,
                outputWatermark: 0,
                activeRunId: null,
                recentReceipts: [],
                configurationRevision: null,
              },
        ),
      );
    });
    observation.listen(0, "127.0.0.1");
    await once(observation, "listening");
    const upstream = `http://127.0.0.1:${observation.address().port}`;
    const runtime = createWorkspaceRuntime({
      connect: async () => ({
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 0 } };
        },
        async readExecution(sessionId) {
          return parseExecutionObservation(
            await fetch(`${upstream}/sessions/${sessionId}/execution`, {
              signal: AbortSignal.timeout(5000),
            }),
          );
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          dispatched++;
          throw new Error("denied prompt dispatched");
        },
        async cancel() {
          dispatched++;
          throw new Error("denied cancel dispatched");
        },
        close() {},
      }),
    });
    const server = createTestWorkspaceHttpServer(runtime);
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}/api/app/workspace/v1/agents/agent-1/sessions/session-1`;
      const headers = testHeaders({
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
      });
      const originalContext = headers["antnest-caller-context"];
      assert.equal(typeof originalContext, "string");
      const warm = await fetch(`${base}/view`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(warm.status, 200);
      const view = await warm.json();
      const offset = reads.length;
      failure = true;
      const response = await fetch(`${base}/prompts`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          ...headers,
          "content-type": "application/json",
          "if-match": view.historyToken,
          "idempotency-key": "intent-1",
        },
        body: JSON.stringify({
          intentId: "intent-1",
          expectedAppendVersion: view.appendVersion,
          prompt: [{ type: "text", text: "must not run" }],
        }),
      });
      const result = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(result.code, expectedCode);
      if (status === 403) {
        assert.equal(result.retryable, false);
        assert.equal(result.recovery, "none");
      }
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.equal(headers["antnest-caller-context"], originalContext);
      assert.deepEqual(reads.slice(offset), ["/sessions/session-1/execution"]);
      assert.equal(dispatched, 0);
    } finally {
      await runtime.drain(1000);
      for (const listener of [server, observation]) {
        listener.closeAllConnections();
        if (listener.listening)
          await new Promise((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          );
      }
    }
  });
}
