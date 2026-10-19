import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  gatewayObservation,
  inspectBrowserAccessCause,
} from "../identity-closeout/agent-access-browser-evidence.mjs";
import { inspectIdentityTrace } from "../identity-closeout/support.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { committedTransaction } from "../edge-gateway/resolve-cache-recovery-http.mjs";
import {
  owningServerTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { inspectC4StreamBoundary } from "./c4-stream-trace.mjs";
import { inspectWorkspaceOffboardingTrace } from "./private-offboarding-trace.mjs";
import {
  assertC4DenialBody,
  assertC4NoNewExecution,
} from "./c4-revocation.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const end = (span) => span.startTime + span.duration;
const tokenInsert =
  "INSERT INTO api_tokens ( id,token_hash,user_id,organization_id,membership_id,issued_at,expires_at, public_session_id,idle_expires_at,last_used_at,user_agent_hint ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10) RETURNING expires_at,idle_expires_at";

function originalPageLogin(boundary, expected, secrets, collection) {
  const receipt = expected.login.receipt,
    trace = collection.traces.get(receipt.traceID);
  assert(
    trace && collection.archivedTraceIDs.has(receipt.traceID),
    "original C4 login Trace must be collected and archived",
  );
  assert.equal(
    new Set([
      receipt.traceID,
      expected.traceID,
      expected.cause.traceID,
      expected.denial.traceID,
    ]).size,
    4,
  );
  inspectIdentityTrace(
    trace,
    {
      traceID: receipt.traceID,
      method: "POST",
      route: "/rpc/identity/local-login",
      rpcMethod: "local_login",
      status: 200,
      clientService: "edge-gateway",
    },
    secrets,
  );
  const tree = traceTopology(trace),
    root = one(
      trace.spans.filter((span) => !tree.parent(span)),
      "one original C4 login Gateway root required",
    );
  assert.equal(tree.service(root), "edge-gateway");
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.route": "/api/session/login",
    "http.request.method": "POST",
    "http.response.status_code": 200,
  }))
    assert.equal(tag(root, key), value);
  gatewayObservation(boundary, trace, root, receipt);
  assert(
    end(root) <= boundary.root.startTime,
    "original C4 login followed SSE dispatch",
  );
  const { server, database } = owningServerTopology(trace, {
    service: "identity-service",
    route: "/rpc/identity/local-login",
    method: "POST",
    rpcMethod: "local_login",
    clientService: "edge-gateway",
  });
  const client = tree.parent(server);
  assert.equal(tree.parent(client), root);
  assert.equal(client.processID, root.processID);
  assert(client.startTime >= root.startTime && end(client) <= end(root));
  for (const span of [client, server])
    assert.equal(tag(span, "http.response.status_code"), 200);
  assert.deepEqual(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "edge-gateway" &&
        tag(span, "span.kind") === "client",
    ),
    [client],
    "unrelated original C4 login Gateway CLIENT",
  );
  const { transaction, sql } = committedTransaction(
    trace,
    tree,
    server,
    database,
  );
  assert.equal(
    sql.length,
    database.length,
    "original C4 login SQL outside its transaction",
  );
  const inserted = one(
    sql.filter(
      (span) =>
        tag(span, "db.query.text")?.replace(/\s+/gu, " ").trim() ===
        tokenInsert,
    ),
    "one committed original C4 token INSERT required",
  );
  assert.equal(tag(inserted, "db.operation.name"), "INSERT");
  assert.equal(tag(inserted, "pgx.rows_affected"), 1);
  for (const span of trace.spans) assertSessionSuccess(span);
  return {
    trace_id: trace.traceID,
    identity_server_span_id: server.spanID,
    transaction_span_id: transaction.spanID,
    token_insert_span_id: inserted.spanID,
    commit_span_id: sql.at(-1).spanID,
  };
}

function originalBody(receipt) {
  assert(
    typeof receipt?.rawBody === "string",
    "original C4 response body required",
  );
  let body;
  try {
    body = JSON.parse(receipt.rawBody);
  } catch {
    throw new Error("original C4 response body must contain valid JSON");
  }
  assert(
    isDeepStrictEqual(body, receipt.body),
    "C4 response differs from its original body",
  );
  return body;
}

export function inspectC4RevocationTrace(trace, expected, secrets, collection) {
  const causeBody = originalBody(expected.cause),
    denialBody = originalBody(expected.denial);
  assert(
    isDeepStrictEqual(causeBody, { status: "updated" }),
    "original C4 User deactivation response differs",
  );
  assert(
    isDeepStrictEqual(expected.cause.requestBody, { active: false }),
    "original C4 User deactivation request differs",
  );
  assertC4DenialBody(denialBody, expected.denial.status);
  assert(
    expected.denial.code === denialBody.code,
    "C4 denial summary differs from original response",
  );
  const boundary = inspectC4StreamBoundary(
    trace,
    expected,
    secrets,
    collection,
  );
  const login = originalPageLogin(boundary, expected, secrets, collection);
  assertC4NoNewExecution(expected.before, expected.after);
  const result = inspectBrowserAccessCause(
    trace,
    expected,
    secrets,
    collection,
    {
      kind: "user_deactivated",
      boundary,
      inspectOffboarding: ({ mutation, report, principal }) => {
        const result = inspectWorkspaceOffboardingTrace(
          [mutation],
          {
            sourceID: mutation.traceID,
            traceID: mutation.traceID,
            agentID: expected.agentId,
            requestID: report.request_id,
            settlementOutcome: "settled",
            ownerRevocation: {
              event: report.owner_revocation,
              ownerUserID: principal.user_id,
              organizationID: "",
              reason: "user_deactivated",
            },
            disabledEvent: report.disabled_event,
          },
          secrets,
        );
        return { result, ownerRevocationSequence: result.revocation_sequence };
      },
    },
  );
  return {
    ...result,
    transport: "http-sse",
    page_owned: true,
    closure: "remote-end",
    login,
  };
}
