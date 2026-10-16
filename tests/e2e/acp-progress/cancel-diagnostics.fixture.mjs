import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationTraceFixture } from "../identity-closeout/private-acp-notification.fixture.mjs";

// The notification receipt comes from the actual SDK/TCP and joined close.
// Request inventory and Jaeger responses are controlled correlation fixtures.
export async function cancellationDiagnosticFixture(
  t,
  version = 1,
  mutate = () => {},
) {
  const f = await notificationTraceFixture(t, version);
  const directory = mkdtempSync(join(tmpdir(), "antnest-progress-diagnostic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prompt = structuredClone(f.trace);
  prompt.traceID = "e".repeat(32);
  for (const span of prompt.spans) span.traceID = prompt.traceID;
  const root = prompt.spans[0];
  root.operationName = "acp session/prompt";
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.request.id": "actual-prompt",
  }))
    f.field(root, key, value);
  const identity = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: version,
    agentId: f.receipt.agentId,
    sessionId: f.receipt.sessionId,
    connectionTraceID: f.receipt.connectionTraceID,
    clientSpanID: f.receipt.clientSpanID,
  };
  const expected = {
    ...identity,
    method: "session/prompt",
    requestId: "actual-prompt",
    inputSessionID: f.receipt.sessionId,
    outcome: version === 1 ? "failed" : "succeeded",
  };
  let closed = false,
    flushed = false,
    attempts = 0;
  const calls = [];
  const client = {
    boundary: "private-acp",
    transport: "websocket",
    version,
    agentId: identity.agentId,
    connectionTraceID: identity.connectionTraceID,
    clientSpanID: identity.clientSpanID,
    requestEvidence: [expected],
    requests: [
      {
        method: expected.method,
        requestId: expected.requestId,
        sessionId: expected.sessionId,
      },
    ],
    initializationRequest: undefined,
    rawFrames: [],
    updates: [],
    notifications: [f.receipt],
    closeAndWait: async () => {
      await f.client.closeAndWait();
      closed = true;
    },
  };
  const options = {
    jaeger: "http://jaeger",
    phase: `v${version}-bash-cancel`,
    version,
    source: "bash",
    ending: "cancel",
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    cancelAt: 1000,
    cancelStarted: 0,
    now: () => 10000,
    client,
    directory,
    frames: [],
    stopped: async () => true,
    lateBudgetMs: 1,
    pollMs: 1,
    attempts: 4,
    wait: async () => {},
    flush: async () => {
      assert(closed);
      flushed = true;
    },
    // Makes the retired implementation fail quickly during the red run.
    fetchJSON: async () => {
      throw new Error("retired unbound query");
    },
    request: async (address, config) => {
      assert(closed && flushed, "query before original joined close and flush");
      assert(config.signal instanceof AbortSignal);
      const url = new URL(address);
      calls.push(url);
      if (url.pathname === `/api/traces/${f.connection.traceID}`) attempts++;
      const state = {
        connection: structuredClone(f.connection),
        prompt: structuredClone(prompt),
        cancel: structuredClone(f.trace),
      };
      mutate(state, attempts);
      if (url.pathname === `/api/traces/${f.connection.traceID}`)
        return Response.json({ data: [state.connection] });
      if (url.pathname === "/api/v3/trace-summaries") {
        const attributes = JSON.parse(url.searchParams.get("query.attributes"));
        const selected =
          attributes["rpc.method"] === "session/prompt"
            ? state.prompt
            : state.cancel;
        return Response.json({
          summaries: [selected, ...(state.extra ?? [])].map((row) => ({
            traceId: row.traceID,
          })),
          ...(state.page ? { nextPageToken: "next" } : {}),
        });
      }
      const trace = [state.prompt, state.cancel, ...(state.extra ?? [])].find(
        (row) => url.pathname === `/api/traces/${row.traceID}`,
      );
      assert(trace, "unexpected diagnostic URL");
      return Response.json({ data: [trace] });
    },
  };
  return {
    ...f,
    prompt,
    expected,
    client,
    directory,
    calls,
    options,
    get attempts() {
      return attempts;
    },
  };
}
