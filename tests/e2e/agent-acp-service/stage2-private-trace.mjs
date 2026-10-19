import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import {
  hasDiagnosticError,
  privateACPProcessIdentity,
} from "../acp-plan/requests.mjs";
import { inspectCommandHTTPClosure } from "../acp-commands/trace.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { assertNoCredentials } from "./stage2-boundary-evidence.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";

function successful(span, allowed = {}) {
  assertSessionSuccess(span, { "antnest.error.code": "", ...allowed });
  for (const row of span.tags ?? [])
    if (row.key === "rpc.jsonrpc.error_code") assert.equal(row.value, 0);
}

function one(items, label) {
  assert.equal(items.length, 1, `one original Stage2 ${label} required`);
  return items[0];
}
function captured(span, direction) {
  const rows = (span.logs ?? []).filter((event) =>
    event.fields?.some(
      (row) => row.key === "event" && row.value === "antnest." + direction,
    ),
  );
  const event = one(rows, `${direction} capture`);
  const payload = one(
    event.fields.filter((row) => row.key === "antnest.payload.json"),
    `${direction} payload`,
  );
  assert.equal(typeof payload.value, "string");
  return JSON.parse(payload.value);
}
function rootClient(tree, trace, receipt, method, status, bodyOutcome) {
  const client = one(
    trace.spans.filter((span) => !tree.parent(span)),
    "exported CLIENT root",
  );
  assert.equal(client.spanID, receipt.clientSpanID);
  assert.equal(tree.service(client), "antnest-private-acp-client");
  assert.equal(client.operationName, `HTTP ${method} agent-acp-workspace`);
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(tag(client, "http.request.method"), method);
  assert.equal(tag(client, "http.response.status_code"), status);
  assert.deepEqual(client.references, []);
  assert(!hasDiagnosticError(client), "Stage2 private CLIENT failed");
  successful(
    client,
    method === "POST"
      ? {
          "antnest.outcome": bodyOutcome,
          "antnest.http.body.outcome": bodyOutcome,
        }
      : {},
  );
  return client;
}

// Stage2 owns enabled RPC capture. Reuse raw topology, process identity and HTTP
// cleanup checks without applying another consumer's capture-disabled policy.
export function inspectStage2PrivatePrompt(
  trace,
  receipt,
  { connection, http, secrets = [] } = {},
) {
  assert.equal(receipt.boundary, "private-acp");
  assert.equal(receipt.method, "session/prompt");
  assert.equal(receipt.outcome, "succeeded");
  assert(["websocket", "http"].includes(receipt.transport));
  const version = receipt.transport === "websocket" ? 2 : 1;
  assert.equal(receipt.protocolVersion, version);
  assert.equal(receipt.requestParams.sessionId, receipt.inputSessionID);
  for (const value of [
    receipt.agentId,
    receipt.requestId,
    receipt.inputSessionID,
  ])
    assert(typeof value === "string" && value);
  assertNoCredentials(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const tree = traceTopology(trace);
  const request = one(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "span.kind") === "server" &&
        tag(span, "rpc.method") === "session/prompt",
    ),
    "Prompt",
  );
  for (const [key, value] of Object.entries({
    "rpc.system.name": "jsonrpc",
    "rpc.service": "acp",
    "antnest.agent.id": receipt.agentId,
    "antnest.session.id": receipt.inputSessionID,
    "antnest.request.id": receipt.requestId,
    "antnest.protocol.version": `v${version}`,
  }))
    assert.equal(tag(request, key), value, `Stage2 private ${key} changed`);
  assert(!hasDiagnosticError(request), "Stage2 completed Prompt failed");
  successful(request);
  assert.deepEqual(captured(request, "response"), receipt.requestResult);
  if (version === 2)
    assert(
      typeof receipt.requestResult.messageId === "string" &&
        receipt.requestResult.messageId,
    );
  else assert.deepEqual(receipt.requestResult, { stopReason: "end_turn" });
  let receiver;
  let expectedParams = receipt.requestParams;
  if (receipt.transport === "websocket") {
    assert.equal(http, undefined);
    assert.equal(connection?.traceID, receipt.connectionTraceID);
    assertSecretFree(JSON.stringify(connection), secrets);
    assertNoCredentials(connection);
    const upgrade = traceTopology(connection);
    const client = rootClient(upgrade, connection, receipt, "GET", 101);
    receiver = one(
      connection.spans.filter(
        (span) =>
          upgrade.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "http.route") === "/v2/acp" &&
          tag(span, "http.request.method") === "GET",
      ),
      "v2 upgrade",
    );
    assert.equal(receiver.operationName, "HTTP GET /v2/acp");
    assert.equal(upgrade.parent(receiver), client);
    assert.equal(tag(receiver, "http.response.status_code"), 101);
    assert.equal(tag(receiver, "antnest.listener"), "workspace");
    assert(!connection.spans.some(hasDiagnosticError), "Stage2 upgrade failed");
    successful(receiver);
    assert.equal(request.operationName, "acp session/prompt");
    assert.equal(
      one(
        trace.spans.filter((span) => !tree.parent(span)),
        "ACP request root",
      ),
      request,
    );
    assert.deepEqual(request.references, [
      {
        refType: "FOLLOWS_FROM",
        traceID: connection.traceID,
        spanID: receiver.spanID,
      },
    ]);
    assert.deepEqual(
      privateACPProcessIdentity(trace, request),
      privateACPProcessIdentity(connection, receiver),
    );
  } else {
    assert.equal(connection, undefined);
    assert.equal(receipt.connectionTraceID, undefined);
    const { receipts } = inspectCommandHTTPClosure(http);
    const post = one(
      receipts.filter((row) => row.index === receipt.httpRequestIndex),
      "HTTP POST receipt",
    );
    for (const [key, value] of Object.entries({
      method: "POST",
      rpcMethod: receipt.method,
      traceID: receipt.traceID,
      clientSpanID: receipt.clientSpanID,
      connectionID: receipt.connectionID,
      rpcSessionID: receipt.inputSessionID,
      status: 202,
      wireStarted: true,
      failed: false,
    }))
      assert.equal(post[key], value, `Stage2 HTTP ${key} changed`);
    assert.equal(String(post.requestID), receipt.requestId);
    assert.equal(trace.traceID, post.traceID);
    // The SDK may cancel the empty 202 ACK after accepting it. The RPC's actual
    // completed response is checked separately, and the original body outcome
    // must agree with the exported CLIENT. Never accept a truncated body.
    assert(["eof", "cancelled"].includes(post.bodyOutcome));
    if (post.bodyOutcome === "cancelled") assert.equal(post.bytes, 0);
    const client = rootClient(
      tree,
      trace,
      receipt,
      "POST",
      202,
      post.bodyOutcome,
    );
    assert.equal(tag(client, "http.response.body.size"), post.bytes);
    assert.equal(tag(client, "antnest.http.body.outcome"), post.bodyOutcome);
    assert.equal(tag(client, "antnest.outcome"), post.bodyOutcome);
    receiver = one(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "http.route") === "/v1/acp" &&
          tag(span, "http.request.method") === "POST",
      ),
      "v1 HTTP receiver",
    );
    assert.equal(receiver.operationName, "HTTP POST /v1/acp");
    assert.equal(tree.parent(receiver), client);
    assert.equal(tag(receiver, "http.response.status_code"), 202);
    assert.equal(tag(receiver, "antnest.listener"), "workspace");
    successful(receiver);
    if (request !== receiver) {
      assert.equal(tree.parent(request), receiver);
      assert.equal(request.operationName, "acp session/prompt");
    }
    assert(
      !request.references.some(
        (reference) => reference.refType === "FOLLOWS_FROM",
      ),
    );
    assert.deepEqual(
      privateACPProcessIdentity(trace, request),
      privateACPProcessIdentity(trace, receiver),
    );
    // TracedAcpHttpServer carries the receiving HTTP span through the SDK queue
    // before the dispatcher captures parameters. Keep the original send receipt
    // and compare the capture against that exact, independently bound receiver.
    const originalMetadata = receipt.requestParams._meta;
    assert(
      originalMetadata == null ||
        (typeof originalMetadata === "object" &&
          !Array.isArray(originalMetadata)),
      "HTTP caller metadata must permit the server's context injection",
    );
    const metadata = { ...originalMetadata };
    delete metadata.traceparent;
    delete metadata.tracestate;
    expectedParams = {
      ...receipt.requestParams,
      _meta: {
        ...metadata,
        traceparent: `00-${trace.traceID}-${receiver.spanID}-01`,
      },
    };
  }
  assert.deepEqual(captured(request, "request"), expectedParams);
  return {
    trace_id: trace.traceID,
    prompt_span_id: request.spanID,
    agent_id: receipt.agentId,
    session_id: receipt.inputSessionID,
    request_id: receipt.requestId,
    transport: receipt.transport,
    protocol_version: version,
    connection_trace_id: connection?.traceID,
    receiver_span_id: receiver.spanID,
  };
}
