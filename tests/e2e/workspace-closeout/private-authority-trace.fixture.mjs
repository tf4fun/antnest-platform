import assert from "node:assert/strict";
import { fields } from "../observability/trace-fixtures.mjs";
import { tokenRead } from "../edge-gateway/resolve-cache-outage-stream.mjs";
import { workspaceStateTraceFixture } from "./private-http-trace.fixture.mjs";

// Controlled fixture conversion only; archived raw evidence is never rewritten.
export function workspaceAuthorityTraceFixture(status = 200) {
  assert([200, 401].includes(status));
  const f = workspaceStateTraceFixture("private_state");
  const { trace, expected, receipt, client, server, sql, set } = f;
  const path = "/rpc/identity/resolve-access-token";
  const body =
    status === 200
      ? {
          caller_context: "workspace-cct-private-fixture",
          principal: structuredClone(receipt.principal),
        }
      : {
          code: "unauthenticated",
          message: "Authentication failed",
          retryable: false,
        };
  const raw = Buffer.from(JSON.stringify(body) + "\n");
  trace.spans = [client, server, sql];
  trace.processes[server.processID].serviceName = "identity-service";

  receipt.path = path;
  receipt.request_body = { profile: "workspace", agent_id: "agent" };
  receipt.status = status;
  receipt.body_outcome = "eof";
  receipt.client_ended = true;
  receipt.errors = [];
  receipt.raw_body_base64 = raw.toString("base64");
  receipt.body_bytes = raw.length;

  expected.kind = "workspace_identity";
  expected.scope = {
    operation_id: 1,
    kind: status === 401 ? "denied-connection" : "connection",
    index: 1,
  };
  expected.after = 900;

  client.operationName = "HTTP POST identity-service";
  client.logs = [];
  set(client, "antnest.protocol.version", undefined);
  set(client, "http.response.status_code", status);
  set(client, "http.response.body.size", raw.length);
  set(client, "antnest.outcome", "eof");
  set(client, "antnest.http.body.outcome", "eof");

  server.operationName = "HTTP POST " + path;
  server.logs = [];
  for (const key of [
    "antnest.listener",
    "antnest.agent.id",
    "antnest.organization.id",
    "antnest.protocol.version",
    "antnest.operation.phase",
    "antnest.stream.termination",
    "error",
    "otel.status_code",
    "error.type",
  ])
    set(server, key, undefined);
  for (const [key, value] of Object.entries({
    "http.route": path,
    "http.response.status_code": status,
    "http.response.body.size": raw.length,
    "http.request.body.size": Buffer.byteLength(
      JSON.stringify(receipt.request_body),
    ),
    "rpc.service": "identity",
    "rpc.method": "resolve_access_token",
    "rpc.system.name": "antnest.http-json",
    "antnest.result": status === 200 ? "success" : "rejected",
    "antnest.outcome": status === 200 ? "success" : "rejected",
  }))
    set(server, key, value);

  sql.logs = [];
  set(sql, "db.namespace", "antnest_identity");
  set(sql, "db.query.text", tokenRead);
  set(sql, "pgx.rows_affected", status === 200 ? 1 : 0);

  if (status === 401) {
    set(client, "error.type", "IdentityHTTPError");
    set(client, "error", true);
    set(client, "otel.status_code", "ERROR");
    const failure = {
      "error.type": "unauthenticated",
      "antnest.error.code": "unauthenticated",
      "antnest.error.type": "unauthenticated",
      "antnest.error.stage": "protocol",
      "antnest.error.message": "Authentication failed",
      "antnest.error.cause_types": '["*domain.Error"]',
    };
    for (const [key, value] of Object.entries(failure)) set(server, key, value);
    server.logs = [
      {
        timestamp: server.startTime + server.duration - 1,
        fields: fields({ event: "antnest.error", ...failure }),
      },
    ];
  }
  return { ...f, trace, expected, receipt, client, server, sql, set };
}
