import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { RequestError } from "@agentclientprotocol/sdk";
import { testScope } from "./support/auth-fixture.ts";
import * as acpHttp from "../src/adapters/acp-http.ts";
import { classifyAcpError, readAcpErrorCapability } from "../src/adapters/acp-errors.ts";
import {
  bridgeFetch,
  bridgeHeaders,
  requireBridgeCapabilities,
  requireLoadCut,
  BridgeCapabilityError,
  parseIntentObservation,
  parseAgentExecutionState,
  consumeAgentExecutionStateStream,
  AgentAccessRevokedError,
  SessionNotFoundError,
  sessionRequestFailure,
  configurationParams,
} from "../src/adapters/acp-http.ts";

const scope = {
  organizationId: "org+1",
  principalId: "user/1",
  agentId: "agent:1",
};

test("the internal ACP caller forwards signed context without browser credentials or authority hints", () => {
  assert.deepEqual(Object.keys(bridgeHeaders(testScope(scope))), ["Antnest-Caller-Context"]);
  assert.throws(() => bridgeHeaders({ ...scope }));
});

test("a caller abort closes a streaming ACP response after garbage collection", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_request, response) => {
    response.on("close", closed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: open\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const caller = new AbortController();
    const response = await bridgeFetch(testScope(scope), fetch)(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/acp`,
      { signal: caller.signal },
    );
    assert.equal(response.status, 200);
    for (let round = 0; round < 3; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      collect();
    }
    caller.abort(new Error("cancelled"));
    assert.equal(await Promise.race([
      disconnected.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]), "closed");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ACP boolean configuration carries the SDK discriminator on the wire", () => {
  const expectedRevision = "a".repeat(64);
  assert.deepEqual(configurationParams("session-1", "safe_mode", false, expectedRevision), {
    sessionId: "session-1", configId: "safe_mode", type: "boolean", value: false,
    _meta: { "antnest.dev/configuration": { expectedRevision } },
  });
  assert.deepEqual(configurationParams("session-1", "model", "a", expectedRevision), {
    sessionId: "session-1", configId: "model", value: "a",
    _meta: { "antnest.dev/configuration": { expectedRevision } },
  });
  assert.throws(() => configurationParams("session-1", "model", "a", "stale"),
    /configuration revision/u);
});

test("Agent state watch parses split SSE frames and fails closed on revocation", async () => {
  const state = {
    agent_id: "agent:1",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "busy",
    active_session_id: "session-2",
    unavailable_reason: null,
  };
  const wire = `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n`;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(wire.slice(0, 19)));
      controller.enqueue(encoder.encode(wire.slice(19)));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const observed: unknown[] = [];
  await consumeAgentExecutionStateStream(response, "agent:1", (value) => {
    observed.push(value);
  }, new AbortController().signal);
  assert.deepEqual(observed, [{ availability: "busy", activeSessionId: "session-2" }]);
  const revoked = { ...state, access_allowed: false, availability: "offline",
    active_session_id: null, configuration_revision: null,
    unavailable_reason: "access_denied" };
  await assert.rejects(
    consumeAgentExecutionStateStream(new Response(
      `event: workspace_state\ndata: ${JSON.stringify(revoked)}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ), "agent:1", () => {}, new AbortController().signal),
    AgentAccessRevokedError,
  );
});

test("Agent execution state rejects denied or mismatched scopes", async () => {
  const state = {
    agent_id: "agent:1",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "busy",
    active_session_id: "session-2",
    unavailable_reason: null,
  };
  assert.deepEqual(
    await parseAgentExecutionState(new Response(JSON.stringify(state)), "agent:1"),
    { availability: "busy", activeSessionId: "session-2" },
  );
  await assert.rejects(
    parseAgentExecutionState(new Response(JSON.stringify(state)), "agent:2"),
    BridgeCapabilityError,
  );
  await assert.rejects(
    parseAgentExecutionState(new Response(JSON.stringify({
      ...state,
      access_allowed: false,
    })), "agent:1"),
    BridgeCapabilityError,
  );
});

test("reliable prompt admission fails closed unless all three producer capabilities are advertised", () => {
  assert.equal(requireBridgeCapabilities({ "antnest.dev/bridge": {
    intentReceipt: 1, targetCancel: 1, deliveryMark: 1,
  } }), false);
  assert.equal(requireBridgeCapabilities({ "antnest.dev/bridge": {
    intentReceipt: 1, targetCancel: 1, deliveryMark: 1, configurationCas: 1,
  } }), true);
  assert.doesNotThrow(() =>
    requireBridgeCapabilities({
      "antnest.dev/bridge": {
        intentReceipt: 1,
        targetCancel: 1,
        deliveryMark: 1,
      },
    }),
  );
  assert.throws(
    () => requireBridgeCapabilities(undefined),
    BridgeCapabilityError,
  );
  assert.throws(
    () =>
      requireBridgeCapabilities({
        "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1 },
      }),
    BridgeCapabilityError,
  );
});

test("load cut requires safe durable watermarks and append versions", () => {
  assert.deepEqual(
    requireLoadCut({
      "antnest.dev/delivery": {
        sealedWatermark: 8,
        appendVersion: 2,
      },
    }),
    { sealedWatermark: 8, appendVersion: 2 },
  );
  assert.throws(
    () =>
      requireLoadCut({
        "antnest.dev/delivery": {
          sealedWatermark: 8,
          appendVersion: -1,
        },
      }),
    BridgeCapabilityError,
  );
  assert.throws(() => requireLoadCut(undefined), BridgeCapabilityError);
});

test("an unknown intent stays uncertain while a hidden Session remains denied", async () => {
  assert.deepEqual(
    await parseIntentObservation(
      new Response(
        JSON.stringify({
          code: "intent_unknown",
          retryable: false,
        }),
        { status: 404 },
      ),
    ),
    { kind: "unknown" },
  );
  await assert.rejects(
    parseIntentObservation(
      new Response(
        JSON.stringify({
          code: "session_not_found",
          retryable: false,
        }),
        { status: 404 },
      ),
    ),
    SessionNotFoundError,
  );
});

test("a hidden or deleted Session keeps its permanent absence across ACP observations", async () => {
  await assert.rejects(
    parseAgentExecutionState(new Response(JSON.stringify({
      code: "session_not_found", retryable: false,
    }), { status: 404 }), "agent:1"),
    SessionNotFoundError,
  );
  const missing = new RequestError(-32020, "Session does not exist", {
    code: "session_not_found", retryable: false,
  });
  assert.ok(sessionRequestFailure(missing) instanceof SessionNotFoundError);
  assert.equal(sessionRequestFailure(new RequestError(-32020, "temporary failure", {
    code: "upstream_unavailable", retryable: true,
  })), undefined);
});

const errorCatalog = JSON.parse(readFileSync(
  new URL("../../../../../contracts/agent-acp/errors.json", import.meta.url), "utf8",
)) as {
  errors: Record<string, { json_rpc_code: number; message: string; retryable: boolean; retry_after_ms?: number }>;
  terminal_outcomes: Record<string, { json_rpc_code: number; message: string }>;
};

function wrappedLoadError(cause: unknown, capability: 1 | null) {
  const constructor = (acpHttp as unknown as {
    AcpLoadError?: new (cause: unknown, capability: 1 | null) => Error & {
      classification: ReturnType<typeof classifyAcpError>;
    };
  }).AcpLoadError;
  assert.equal(typeof constructor, "function", "AcpLoadError is required");
  return new constructor!(cause, capability);
}

test("typed Load failure retains the original service receipt and exposes only its classified message", () => {
  const entry = errorCatalog.errors.configuration_not_ready!;
  const original = new RequestError(entry.json_rpc_code, entry.message, {
    code: "configuration_not_ready", retryable: true,
    retry_after_ms: entry.retry_after_ms,
  });
  const error = wrappedLoadError(original, 1);
  assert.equal(error.cause, original);
  assert.equal(error.message, entry.message);
  assert.deepEqual(error.classification, classifyAcpError(original, 1));
  assert.equal(error.classification.retryDirective, "backoff");
  assert.equal(error.classification.retryAfterMs, entry.retry_after_ms);
});

for (const [name, original, capability] of [
  ["unclassified transport", new Error("PRIVATE-LOAD-FAILURE-CANARY"), 1],
  ["unknown capability", new RequestError(
    errorCatalog.errors.agent_busy!.json_rpc_code,
    errorCatalog.errors.agent_busy!.message,
    { code: "agent_busy", retryable: true, retry_after_ms: errorCatalog.errors.agent_busy!.retry_after_ms },
  ), null],
  ...Object.entries(errorCatalog.terminal_outcomes).map(([name, terminal]) => [
    "terminal " + name,
    new RequestError(terminal.json_rpc_code, terminal.message, {
      code: "model_unsupported_content", retryable: false,
    }),
    1,
  ] as const),
] as const) {
  test("typed Load " + name + " is nonreplayable without inventing a Run query", () => {
    const error = wrappedLoadError(original, capability);
    assert.equal(error.cause, original);
    assert.deepEqual(error.classification, classifyAcpError(original, capability));
    assert.equal(error.message, error.classification.message);
    assert.equal(error.classification.retryable, false);
    assert.equal(Object.hasOwn(error.classification, "retryAfterMs"), false);
    assert(!error.message.includes("PRIVATE-LOAD-FAILURE-CANARY"));
  });
}

function wrappedPromptError(cause: unknown, capability: 1 | null) {
  const constructor = (acpHttp as unknown as {
    AcpPromptError?: new (cause: unknown, capability: 1 | null) => Error & {
      classification: ReturnType<typeof classifyAcpError>;
    };
  }).AcpPromptError;
  assert.equal(typeof constructor, "function", "AcpPromptError is required");
  return new constructor!(cause, capability);
}

test("typed Prompt rejection retains the catalog classification and original receipt without asserting acceptance", () => {
  for (const code of [
    "agent_busy", "access_denied", "runtime_barrier_required",
    "database_error", "intent_already_recorded",
  ]) {
    const entry = errorCatalog.errors[code]!;
    const original = new RequestError(entry.json_rpc_code, entry.message, {
      code,
      retryable: entry.retryable,
      ...(entry.retry_after_ms === undefined ? {} : { retry_after_ms: entry.retry_after_ms }),
    });
    const before = structuredClone(original.toErrorResponse());
    const error = wrappedPromptError(original, 1);
    assert.equal(error.name, "AcpPromptError");
    assert.equal(error.cause, original, code);
    assert.equal(error.message, entry.message, code);
    assert.deepEqual(error.classification, classifyAcpError(original, 1), code);
    assert.equal(error.classification.kind, "admission", code);
    assert.equal(error.classification.code, code);
    assert.equal(error.classification.retryable, entry.retryable, code);
    assert.equal(error.classification.requiresRunQuery,
      ["database_error", "intent_already_recorded"].includes(code), code);
    if (code === "agent_busy") {
      assert.equal(error.classification.retryDirective, "backoff");
      assert.equal(error.classification.retryAfterMs, entry.retry_after_ms);
    } else if (code === "runtime_barrier_required") {
      assert.equal(error.classification.retryDirective, "wait_rebuild");
      assert.equal(Object.hasOwn(error.classification, "retryAfterMs"), false);
    } else if (code === "access_denied") {
      assert.equal(error.classification.retryDirective, "none");
    } else assert.equal(error.classification.retryDirective, "query_intent");
    for (const key of ["acceptance", "phase", "runId", "operationId"])
      assert.equal(Object.hasOwn(error.classification, key), false, "classification invented execution state");
    assert.deepEqual(original.toErrorResponse(), before, "Prompt wrapping changed the original receipt");
  }
});

test("typed Prompt terminal failures retain their original outcome classification and require the original Run query", () => {
  for (const terminal of Object.values(errorCatalog.terminal_outcomes)) {
    const original = new RequestError(terminal.json_rpc_code, terminal.message, {
      code: "model_unsupported_content", retryable: false,
    });
    const error = wrappedPromptError(original, 1);
    assert.equal(error.cause, original);
    assert.equal(error.message, terminal.message);
    assert.deepEqual(error.classification, classifyAcpError(original, 1));
    assert.equal(error.classification.kind, "terminal");
    assert.equal(error.classification.code, "model_unsupported_content");
    assert.equal(error.classification.retryable, false);
    assert.equal(error.classification.requiresRunQuery, true);
    assert.equal(Object.hasOwn(error.classification, "retryAfterMs"), false);
  }
});

test("typed Prompt unsupported capabilities malformed receipts and local errors expose only the safe nonretryable fallback", () => {
  const canary = "PRIVATE-PROMPT-FAILURE-CANARY", busy = errorCatalog.errors.agent_busy!;
  const data = { code: "agent_busy", retryable: true, retry_after_ms: busy.retry_after_ms };
  const busyReceipt = () => new RequestError(busy.json_rpc_code, busy.message, { ...data });
  const fallback = classifyAcpError(new Error(canary), null);
  const cases = [
    ["missing capability", busyReceipt(), readAcpErrorCapability(undefined)],
    ["unknown capability", busyReceipt(), readAcpErrorCapability({ "antnest.dev/errors": { version: 2 } })],
    ["raw private message", new RequestError(busy.json_rpc_code, canary, { ...data }), 1],
    ["contradictory retryability", new RequestError(busy.json_rpc_code, busy.message, { ...data, retryable: false }), 1],
    ["private details", new RequestError(busy.json_rpc_code, busy.message, { ...data, details: { cause: canary } }), 1],
    ["ordinary local error", Object.assign(new Error(canary), { code: busy.json_rpc_code, data: { ...data } }), 1],
  ] as const;
  for (const [label, original, capability] of cases) {
    const error = wrappedPromptError(original, capability);
    assert.equal(error.cause, original, label);
    assert.deepEqual(error.classification, classifyAcpError(original, capability), label);
    assert.deepEqual(error.classification, fallback, label);
    assert.equal(error.message, fallback.message, label);
    assert.equal(error.classification.kind, "unknown", label);
    assert.equal(error.classification.retryable, false, label);
    assert.equal(error.classification.requiresRunQuery, true, label);
    assert.equal(Object.hasOwn(error.classification, "retryAfterMs"), false, label);
    assert(!JSON.stringify({ message: error.message, classification: error.classification }).includes(canary),
      "Prompt public classification exposed a private cause");
  }
});
