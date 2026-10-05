import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { testScope } from "./support/auth-fixture.ts";
import {
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
