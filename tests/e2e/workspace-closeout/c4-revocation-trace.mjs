import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  gatewayObservation,
  inspectBrowserAccessCause,
} from "../identity-closeout/agent-access-browser-evidence.mjs";
import { inspectIdentityTrace } from "../identity-closeout/support.mjs";
import { hasDiagnosticError } from "../acp-plan/requests.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { committedTransaction } from "../edge-gateway/resolve-cache-recovery-http.mjs";
import {
  owningServerTopology,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { inspectC4StreamBoundary } from "./c4-stream-trace.mjs";
import { inspectWorkspaceOffboardingTrace } from "./private-offboarding-trace.mjs";
import { assertDockerProbe } from "../stage3-base/trace.mjs";
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
    root.startTime <= boundary.root.startTime,
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

function assertEmptyReadonlyReplay(trace, tree, transaction, owners) {
  assert(owners.has(tree.parent(transaction)?.spanID), "unowned C4 replay");
  assert.equal(tree.service(transaction), "agent-controller");
  assert.equal(transaction.operationName, "postgresql transaction");
  assert.equal(tag(transaction, "span.kind"), "internal");
  assert.equal(tag(transaction, "db.system.name"), "postgresql");
  assert(!hasDiagnosticError(transaction));
  const queries = [];
  for (const span of trace.spans.filter(
    (candidate) =>
      candidate !== transaction && tree.chain(candidate).includes(transaction),
  )) {
    assert.equal(tree.parent(span), transaction);
    assert.equal(span.processID, transaction.processID);
    assert.equal(tag(span, "span.kind"), "client");
    assert.equal(tag(span, "db.system.name"), "postgresql");
    if (tag(span, "db.query.text") === undefined) {
      assert.equal(span.operationName, "connect");
      for (const key of [
        "db.operation.name",
        "http.request.method",
        "rpc.method",
        "rpc.system",
      ])
        assert.equal(tag(span, key), undefined);
    } else queries.push(span);
  }
  queries.sort((a, b) => a.startTime - b.startTime);
  assert.deepEqual(
    queries.map((span) => span.operationName),
    ["BEGIN", "SELECT", "ROLLBACK"],
  );
  const sql = queries.map((span) =>
    tag(span, "db.query.text").replace(/\s+/gu, " ").trim(),
  );
  assert.equal(sql[0], "begin isolation level repeatable read read only");
  assert.match(
    sql[1],
    /^SELECT [a-z_, ]+ FROM agent_controller\.agent_lifecycle_operations WHERE request_id = \$1$/u,
  );
  assert.equal(sql[2], "rollback");
  for (const [index, span] of queries.entries()) {
    assert.equal(tag(span, "db.operation.name"), span.operationName);
    assert.equal(tag(span, "pgx.rows_affected"), 0);
    assert(
      span.startTime >= transaction.startTime && end(span) <= end(transaction),
    );
    if (index > 0) assert(end(queries[index - 1]) <= span.startTime);
  }
}

function mutationDiagnostics(trace, expected, offboarding) {
  const tree = traceTopology(trace),
    schedule = one(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "agent-controller" &&
          span.operationName ===
            "agent_controller.identity_offboarding.disable" &&
          tag(span, "agent.id") === expected.agentId &&
          tag(span, "identity.revocation.sequence") ===
            offboarding.revocation_sequence,
      ),
      "one original C4 offboarding schedule required",
    ),
    replayOwners = new Set([
      schedule.spanID,
      ...offboarding.activities
        .filter((activity) => activity.phase === "admit_lifecycle")
        .map((activity) => activity.span_id),
    ]),
    settled = one(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "http.route") === "/rpc/agent-acp/settle-agent",
      ),
      "one original C4 settlement required",
    ),
    settlement = new Set([
      settled,
      tree
        .chain(settled)
        .find(
          (span) =>
            tree.service(span) === "agent-controller" &&
            tag(span, "span.kind") === "client",
        ),
    ]),
    retries = new Set(
      (offboarding.lifecycle_error_claims ?? [])
        .filter((claim) => claim.reason === "serialization-retry")
        .map((claim) => claim.span_id),
    ),
    transactions = new Set();
  for (const id of retries) {
    const span = tree.spans.get(id);
    transactions.add(
      span.operationName === "postgresql transaction"
        ? span
        : tree.parent(span),
    );
  }
  for (const span of trace.spans) {
    // ObservedPlatform always records the code, including the empty success value.
    const allowed = { "antnest.error.code": "" };
    if (
      tag(span, "antnest.transaction.outcome") === "rolled_back" &&
      !transactions.has(span)
    ) {
      // ReplayAgentDisable returns normally when its read-only lookup is empty;
      // the deferred rollback is not a failed lifecycle mutation.
      assertEmptyReadonlyReplay(trace, tree, span, replayOwners);
      allowed["antnest.transaction.outcome"] = "rolled_back";
    }
    if (tag(span, "antnest.settlement.outcome") !== undefined) {
      assert(settlement.has(span), "unowned C4 settlement diagnostic");
      assert.equal(tag(span, "antnest.agent.id"), expected.agentId);
      assert.equal(
        tag(span, "antnest.operation.id"),
        expected.offboarding.request_id,
      );
      assert(
        ["agent-controller", "agent-acp-service"].includes(tree.service(span)),
      );
      allowed["antnest.settlement.outcome"] = "settled";
    }
    // Lifecycle has already proved this precise aborted transaction and its
    // committed retry. Admit only those diagnostics; all other fields still
    // pass the normal success check, including logs and transport/DB failures.
    if (transactions.has(span)) {
      const outcome = tag(span, "antnest.transaction.outcome");
      assert(["rolled_back", "failed"].includes(outcome));
      allowed["antnest.transaction.outcome"] = outcome;
    }
    if (retries.has(span.spanID)) {
      allowed.error = true;
      allowed["otel.status_code"] = "ERROR";
      if (span.operationName === "postgresql transaction") {
        allowed["error.type"] = "transaction_error";
        allowed["otel.status_description"] =
          "transaction did not complete successfully";
      } else {
        const description = tag(span, "otel.status_description");
        assert.match(description ?? "", /\(SQLSTATE 40001\)$/u);
        allowed["otel.status_description"] = description;
        allowed["db.response.status_code"] = "40001";
      }
    }
    let view = span;
    if (tag(span, "http.response.status_code") === 404) {
      assert(
        !hasDiagnosticError(span),
        "Docker absence is not an error waiver",
      );
      assertDockerProbe(trace, tree, span, {
        kind: "disable",
        agentId: expected.agentId,
        requestId: expected.offboarding.request_id,
      });
      const aliases = new Set([
        "http.response.status_code",
        "http.status_code",
      ]);
      const statuses = span.tags.filter(({ key }) => aliases.has(key));
      assert(statuses.length > 0);
      assert.equal(
        new Set(statuses.map(({ key }) => key)).size,
        statuses.length,
      );
      for (const { value } of statuses) assert.equal(value, 404);
      // Only the proved absence status is omitted from this validation view.
      // The original source and its diagnostics remain unchanged in the archive.
      view = {
        ...span,
        tags: span.tags.filter(({ key }) => !aliases.has(key)),
      };
      allowed["antnest.outcome"] = "absent";
    }
    assertSessionSuccess(view, allowed);
  }
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
  let offboarding;
  const result = inspectBrowserAccessCause(
    trace,
    expected,
    secrets,
    collection,
    {
      kind: "user_deactivated",
      boundary,
      inspectOffboarding: ({ mutation, report, principal }) => {
        const result = (offboarding = inspectWorkspaceOffboardingTrace(
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
        ));
        return { result, ownerRevocationSequence: result.revocation_sequence };
      },
    },
  );
  mutationDiagnostics(
    collection.traces.get(expected.cause.traceID),
    expected,
    offboarding,
  );
  if (expected.closure.kind === "transport-end") {
    assert(
      hasDiagnosticError(boundary.root) &&
        hasDiagnosticError(boundary.upstream),
    );
    assert(
      Number.isSafeInteger(result.cause_proof.feed_sequence) &&
        result.cause_proof.feed_sequence > 0,
      "C4 truncated transport requires the original Gateway revocation feed",
    );
    assert.equal(
      result.cause_proof.feed_source_span_id,
      result.cause_proof.identity_server_span_id,
    );
  }
  // Claims refer only to original spans whose diagnostics the owning gates
  // above have validated. Other sources may belong to independently verified
  // C4 Prompts; the collector accounts for the full source union separately.
  const claims = new Map();
  const save = (claim) => {
    const key = `${claim.trace_id}/${claim.span_id}`;
    if (claims.has(key)) assert.deepEqual(claims.get(key), claim);
    else claims.set(key, claim);
  };
  const claim = (id, spanID, reason) => {
    const source = collection.traces.get(id),
      span = source?.spans.find((s) => s.spanID === spanID);
    assert(span, "original C4 diagnostic span missing");
    if (hasDiagnosticError(span))
      save({
        trace_id: id,
        span_id: spanID,
        service: source.processes[span.processID].serviceName,
        operation: span.operationName,
        reason,
      });
  };
  const resolve = (record) => {
    if (record?.outcome !== "rejected") return;
    const reason = "c4-revoked-identity-resolve";
    claim(record.trace_id, record.decision_span_id, reason);
    claim(record.source_trace_id, record.rpc_client_span_id, reason);
    claim(record.source_trace_id, record.identity_server_span_id, reason);
  };
  for (const owned of offboarding.lifecycle_error_claims ?? []) save(owned);
  for (const record of [
    result.gateway_resolution,
    ...result.gateway_revalidations,
  ])
    resolve(record);
  claim(trace.traceID, boundary.root.spanID, "public-sse-revoked-handler");
  claim(trace.traceID, boundary.upstream.spanID, "public-sse-revoked-response");
  const denial = result.denial;
  if (denial.status === 401) {
    claim(denial.trace_id, denial.root_span_id, "c4-revoked-prompt-denial");
    resolve(denial.resolution);
  } else {
    const tree = traceTopology(collection.traces.get(denial.trace_id));
    const server = tree.spans.get(denial.acp_server_span_id);
    for (const span of [server, ...tree.chain(server)])
      claim(denial.trace_id, span.spanID, "c4-revoked-prompt-denial");
  }
  return {
    ...result,
    owned_error_spans: [...claims.values()],
    transport: "http-sse",
    page_owned: true,
    closure: expected.closure.kind,
    login,
  };
}
