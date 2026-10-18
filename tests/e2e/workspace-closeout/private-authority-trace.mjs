import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { assertWorkspaceResolveDenied } from "./private-authority.mjs";
import {
  owningServerTopology,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";
import {
  values,
  end,
  diagnostics,
} from "../observability/runtime-tool-evidence.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { tokenRead } from "../edge-gateway/resolve-cache-outage-stream.mjs";

const path = "/rpc/identity/resolve-access-token";
const normalize = (query) => query.replace(/\s+/gu, " ").trim();
const same = (
  actual,
  expected,
  message = "Workspace original Identity fields disagree",
) => assert(isDeepStrictEqual(actual, expected), message);
const reasons = new Set([
  "workspace-identity-denied-client",
  "workspace-identity-denied-server",
]);

export function assertWorkspaceAuthorityReceipt(receipt, expected) {
  same(expected.kind, "workspace_identity");
  assert(
    Number.isSafeInteger(expected.scope?.operation_id) &&
      expected.scope.operation_id > 0,
  );
  assert(
    Number.isSafeInteger(expected.scope.index) && expected.scope.index > 0,
  );
  same(receipt.agentId, expected.agentID);
  same(receipt.principal, expected.principal);
  same(receipt.session_digest, expected.session_digest);
  assert(/^[a-f0-9]{64}$/u.test(receipt.session_digest));
  for (const key of ["organization_id", "user_id"])
    assert(
      typeof expected.principal[key] === "string" && expected.principal[key],
    );
  same(receipt.traceID, expected.traceID);
  same(receipt.clientSpanID, expected.clientSpanID);
  assert(
    /^[a-f0-9]{32}$/u.test(receipt.traceID) &&
      /^[a-f0-9]{16}$/u.test(receipt.clientSpanID),
  );
  if (receipt.status === 401) {
    same(expected.scope.kind, "denied-connection");
    return assertWorkspaceResolveDenied(receipt, expected);
  }
  assert(["connection", "watch", "state"].includes(expected.scope.kind));
  same(receipt.status, 200);
  same(receipt.method, "POST");
  same(receipt.path, path);
  same(receipt.request_body, {
    profile: "workspace",
    agent_id: expected.agentID,
  });
  same(receipt.errors, []);
  same(receipt.client_ended, true);
  same(receipt.body_outcome, "eof");
  if (receipt.response_trace_id !== null)
    same(receipt.response_trace_id, receipt.traceID);
  assert(/^application\/json(?:\s*;|$)/iu.test(receipt.content_type));
  const times = [
    receipt.request_started_at,
    receipt.response_received_at,
    receipt.response_completed_at,
  ];
  assert(
    times.every(Number.isSafeInteger) &&
      times[0] >= 0 &&
      times[0] <= times[1] &&
      times[1] <= times[2],
  );
  const raw = Buffer.from(receipt.raw_body_base64, "base64");
  same(raw.toString("base64"), receipt.raw_body_base64);
  same(raw.length, receipt.body_bytes);
  assert(raw.length > 0 && raw.length <= 65536);
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("invalid original Workspace Identity JSON");
  }
  assert(
    typeof body.caller_context === "string" &&
      body.caller_context.length > 0 &&
      body.caller_context.length <= 8192,
  );
  for (const key of ["organization_id", "user_id"])
    same(
      body.principal?.[key],
      expected.principal[key],
      "original Identity Principal changed",
    );
  return receipt;
}

export function inspectWorkspaceAuthorityTrace(
  trace,
  expected,
  secrets = [],
  options = {},
) {
  const receipt = assertWorkspaceAuthorityReceipt(expected.receipt, expected),
    status = receipt.status;
  same(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, options);
  same(sources.length, 1);
  const { server, client, database } = owningServerTopology(trace, {
    service: "identity-service",
    route: path,
    method: "POST",
    rpcMethod: "resolve_access_token",
    clientService: "antnest-private-acp-client",
    clientSpanID: expected.clientSpanID,
    status,
  });
  const tree = traceTopology(trace);
  same(trace.spans.length, 3, "unexpected work in original Identity Resolve");
  same(database.length, 1);
  const sql = database[0],
    denied = status === 401;
  same(client.operationName, "HTTP POST identity-service");
  same(client.references ?? [], []);
  same(server.operationName, "HTTP POST " + path);
  same(server.references, [
    { refType: "CHILD_OF", traceID: trace.traceID, spanID: client.spanID },
  ]);
  same(sql.references, [
    { refType: "CHILD_OF", traceID: trace.traceID, spanID: server.spanID },
  ]);
  same(sql.processID, server.processID);
  same(tree.service(sql), "identity-service");
  same(sql.operationName, "SELECT");
  for (const [key, value] of Object.entries({
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.namespace": "antnest_identity",
    "db.operation.name": "SELECT",
    "pgx.rows_affected": denied ? 0 : 1,
  }))
    same(tag(sql, key), value);
  same(normalize(tag(sql, "db.query.text") ?? ""), normalize(tokenRead));
  same(sql.logs ?? [], []);
  same(client.logs ?? [], []);
  for (const [key, value] of Object.entries({
    "rpc.service": "identity",
    "rpc.system.name": "antnest.http-json",
    "antnest.result": denied ? "rejected" : "success",
    "antnest.outcome": denied ? "rejected" : "success",
    "http.response.body.size": receipt.body_bytes,
  }))
    same(tag(server, key), value);
  assert(
    Number.isSafeInteger(tag(server, "http.request.body.size")) &&
      tag(server, "http.request.body.size") > 0,
  );
  for (const [key, value] of Object.entries({
    "http.response.status_code": status,
    "http.response.body.size": receipt.body_bytes,
    "antnest.outcome": "eof",
    "antnest.http.body.outcome": "eof",
    "antnest.protocol.version": undefined,
  }))
    same(tag(client, key), value);
  for (const span of trace.spans) {
    end(span);
    values(span.tags);
  }
  assert(
    sql.startTime >= server.startTime && end(sql) <= end(server),
    "Identity token read was not joined by its SERVER",
  );
  const report = { owned_error_spans: [] };
  const statusFields = (span) =>
    Object.fromEntries(
      ["http.response.status_code", "http.status_code"]
        .filter((key) => (span.tags ?? []).some((field) => field.key === key))
        .map((key) => [key, status]),
    );
  if (denied) {
    same(tag(client, "error.type"), "IdentityHTTPError");
    assert(["ERROR", 2].includes(tag(client, "otel.status_code")));
    const clientAllowed = {
      ...statusFields(client),
      "error.type": "IdentityHTTPError",
      "otel.status_code": tag(client, "otel.status_code"),
      "antnest.outcome": "eof",
      "antnest.http.body.outcome": "eof",
      ...(tag(client, "error") !== undefined ? { error: true } : {}),
    };
    diagnostics(client, clientAllowed);
    const failure = {
      "error.type": "unauthenticated",
      "antnest.error.type": "unauthenticated",
      "antnest.error.code": "unauthenticated",
      "antnest.error.stage": "protocol",
      "antnest.error.message": "Authentication failed",
      "antnest.error.cause_types": '["*domain.Error"]',
    };
    for (const [key, value] of Object.entries(failure))
      same(tag(server, key), value);
    same(server.logs?.length, 1);
    const event = server.logs[0];
    same(values(event.fields), { event: "antnest.error", ...failure });
    assert(
      Number.isFinite(event.timestamp) && event.timestamp >= end(sql),
      "Identity refusal preceded its token read",
    );
    diagnostics(
      server,
      {
        ...statusFields(server),
        ...failure,
        "antnest.result": "rejected",
        "antnest.outcome": "rejected",
      },
      new Map([[event, { event: "antnest.error", ...failure }]]),
    );
    report.owned_error_spans = [
      {
        trace_id: trace.traceID,
        span_id: client.spanID,
        reason: "workspace-identity-denied-client",
      },
      {
        trace_id: trace.traceID,
        span_id: server.spanID,
        reason: "workspace-identity-denied-server",
      },
    ];
  } else {
    same(server.logs ?? [], []);
    diagnostics(client, {
      "antnest.outcome": "eof",
      "antnest.http.body.outcome": "eof",
    });
    diagnostics(server);
  }
  diagnostics(sql);
  return {
    ...resolveTraceDiagnostics(trace, sources),
    ...privateACPDiagnosticInventory(sources, [report], reasons),
    topology: "passed",
    kind: expected.kind,
    trace_id: trace.traceID,
    client_span_id: client.spanID,
    server_span_id: server.spanID,
    agent_id: expected.agentID,
    status,
    sql_spans: 1,
    authority_scope: structuredClone(expected.scope),
    original_session_verified: true,
  };
}
