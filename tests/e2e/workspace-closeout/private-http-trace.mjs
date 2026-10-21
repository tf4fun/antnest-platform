import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { assertWorkspaceWatchReceipt } from "./private-watch.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  owningServerTopology,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";
import {
  privateACPProcessIdentity,
  assertPrivateACPApplicationJoined,
} from "../observability/private-acp-diagnostics.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import {
  values,
  end,
  expected as expect,
  diagnostics,
} from "../observability/runtime-tool-evidence.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const validateState = new Ajv2020({ strict: false }).compile(schema);
const normalize = (text) => text.replace(/\s+/gu, " ").trim();
const protection = normalize(`SELECT EXISTS (
  SELECT 1 FROM tool_attempts AS attempt
  JOIN runs AS run ON run.id = attempt.run_id
  JOIN acp_sessions AS session ON session.id = run.session_id
  WHERE session.organization_id = $1 AND session.agent_id = $2
    AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision' = $3)
    AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped
) OR EXISTS (
  SELECT 1 FROM temporary_skill_scopes temporary JOIN runs run ON run.id=temporary.run_id
  WHERE temporary.organization_id=$1 AND temporary.agent_id=$2 AND temporary.released_at IS NULL
    AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision'=$3)
) AS protected`);
const reason = "workspace-private-watch-local-close";
const same = (
  actual,
  expected,
  message = "Workspace original HTTP fields disagree",
) => assert(isDeepStrictEqual(actual, expected), message);

export function assertWorkspaceStateReceipt(
  receipt,
  expected,
  { requireTrace = true } = {},
) {
  for (const [key, value] of Object.entries({
    agentId: expected.agentID,
    ...(requireTrace
      ? { traceID: expected.traceID, clientSpanID: expected.clientSpanID }
      : {}),
    session_digest: expected.session_digest,
    method: "POST",
    path: "/rpc/agent-acp/get-agent-execution-state",
    status: 200,
    body_outcome: "eof",
    joined: true,
  }))
    same(receipt[key], value);
  same(receipt.principal, expected.principal);
  same(receipt.request_body, {});
  same(receipt.errors, []);
  if (requireTrace) {
    assert.match(receipt.traceID, /^[a-f0-9]{32}$/u);
    assert.match(receipt.clientSpanID, /^[a-f0-9]{16}$/u);
  }
  assert.match(receipt.session_digest, /^[a-f0-9]{64}$/u);
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof expected.principal[field] === "string" &&
        expected.principal[field],
    );
  if (requireTrace && receipt.response_trace_id != null)
    assert(
      receipt.response_trace_id === receipt.traceID,
      "Workspace response Trace changed",
    );
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
  assert(raw.length > 0 && raw.length <= 1024 * 1024);
  let state;
  try {
    state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("invalid original Workspace state JSON");
  }
  assert(
    validateState(state),
    "invalid complete original Workspace state schema",
  );
  same(state.agent_id, expected.agentID);
  if (expected.state !== undefined) same(state, expected.state);
  return state;
}

export function inspectWorkspaceStateTrace(
  trace,
  expected,
  secrets = [],
  options = {},
) {
  const watch = expected.kind === "private_state_watch";
  assert(watch || expected.kind === "private_state");
  same(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, options);
  same(sources.length, 1, "private state has unexpected causal sources");
  assertSecretFree(JSON.stringify(trace), secrets);
  const receipt = expected.receipt;
  const states = watch
    ? assertWorkspaceWatchReceipt(receipt, expected)
    : [assertWorkspaceStateReceipt(receipt, expected)];
  const timeObservations = [];
  const local = watch && expected.mode === "local-close";
  const path =
    "/rpc/agent-acp/" +
    (watch ? "watch-agent-execution-state" : "get-agent-execution-state");
  const tree = traceTopology(trace),
    readinessRows = trace.spans.filter(
      (span) => span.operationName === "postgres.ready",
    );
  same(readinessRows.length, 1, "one original ACP readiness wrapper required");
  const readiness = readinessRows[0],
    owner = tree.parent(readiness);
  expect(readiness, {
    "span.kind": "internal",
    "db.system.name": "postgresql",
    "db.query.text": undefined,
  });
  const children = trace.spans.filter(
    (span) => tree.parent(span) === readiness,
  );
  same(children.length, 1, "one original readiness SELECT required");
  const readySQL = children[0];
  same(normalize(tag(readySQL, "db.query.text") ?? ""), "SELECT 1");
  // Only this already-proved wrapper is removed from a validation view. The
  // original tree, every field and raw diagnostic are checked independently.
  const databaseView = {
    ...trace,
    spans: trace.spans
      .filter((span) => span !== readiness)
      .map((span) =>
        span === readySQL
          ? {
              ...span,
              references: [
                {
                  refType: "CHILD_OF",
                  traceID: trace.traceID,
                  spanID: owner.spanID,
                },
              ],
            }
          : span,
      ),
  };
  const { client, server, database } = owningServerTopology(databaseView, {
    service: "agent-acp-service",
    route: path,
    method: "POST",
    rpcMethod: watch
      ? "watch_agent_execution_state"
      : "get_agent_execution_state",
    clientService: "antnest-private-acp-client",
    clientSpanID: expected.clientSpanID,
    status: 200,
  });
  same(owner, server);
  same(client.operationName, "HTTP POST agent-acp-workspace");
  expect(client, {
    "http.response.status_code": 200,
    "http.response.body.size": receipt.body_bytes,
    "antnest.protocol.version": "v1",
    "antnest.outcome": receipt.body_outcome,
    "antnest.http.body.outcome": receipt.body_outcome,
  });
  same(server.operationName, "HTTP POST " + path);
  expect(server, {
    "rpc.service": "agent-acp",
    "rpc.system.name": "json-over-http",
    "antnest.listener": "workspace",
    "antnest.agent.id": expected.agentID,
    "antnest.organization.id": expected.principal.organization_id,
  });
  const queries = new Set(database.map((span) => span.spanID));
  if (states.some((state) => state.availability === "ready"))
    assert(
      database.some((span) => span.spanID !== readySQL.spanID),
      "ready Workspace state lacks the original Runtime protection query",
    );
  same(
    trace.spans.length,
    database.length + 3,
    "unaccounted private state work",
  );
  for (const span of trace.spans) {
    end(span);
    values(span.tags);
    same(
      span.references ?? [],
      span === client
        ? []
        : [
            {
              refType: "CHILD_OF",
              traceID: trace.traceID,
              spanID: tree.parent(span)?.spanID,
            },
          ],
    );
    assert(tree.chain(span).includes(client));
    if (span !== client) {
      same(tree.service(span), "agent-acp-service");
      same(
        privateACPProcessIdentity(trace, span),
        privateACPProcessIdentity(trace, server),
      );
      if (span !== server)
        assertPrivateACPApplicationJoined(
          trace,
          tree.parent(span),
          span,
          timeObservations,
          "workspace-state-query-joined",
        );
    }
    if (queries.has(span.spanID)) {
      same(span.operationName, "SELECT");
      expect(span, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "SELECT",
      });
      same(tree.parent(span), span === readySQL ? readiness : server);
      same(
        normalize(tag(span, "db.query.text")),
        span === readySQL ? "SELECT 1" : protection,
      );
    }
    for (const event of span.logs ?? []) {
      values(event.fields);
      assert(
        Number.isFinite(event.timestamp) &&
          event.timestamp >= span.startTime &&
          event.timestamp <= end(span),
      );
    }
    let allowed =
      span === client
        ? {
            "antnest.outcome": receipt.body_outcome,
            "antnest.http.body.outcome": receipt.body_outcome,
          }
        : {};
    if (span === server && local) {
      expect(span, {
        "error.type": "stream_interrupted",
        "antnest.outcome": "disconnected",
      });
      assert(["ERROR", 2].includes(tag(span, "otel.status_code")));
      same(span.logs?.length ?? 0, 0);
      allowed = {
        "error.type": "stream_interrupted",
        "antnest.outcome": "disconnected",
        "otel.status_code": tag(span, "otel.status_code"),
        ...(tag(span, "error") !== undefined ? { error: true } : {}),
      };
    } else assertSessionSuccess(span, allowed);
    diagnostics(span, allowed);
  }
  const report = {
    owned_error_spans: local
      ? [{ trace_id: trace.traceID, span_id: server.spanID, reason }]
      : [],
  };
  return {
    ...resolveTraceDiagnostics(trace, sources),
    ...privateACPDiagnosticInventory(sources, [report], new Set([reason])),
    topology: "passed",
    kind: expected.kind,
    trace_id: trace.traceID,
    client_span_id: client.spanID,
    server_span_id: server.spanID,
    agent_id: expected.agentID,
    sql_spans: database.length,
    time_observations: timeObservations,
    ...(watch
      ? {
          closure: structuredClone(receipt.closure),
          remote_closure_verified: !local,
        }
      : {}),
  };
}
