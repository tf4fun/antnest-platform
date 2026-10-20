import assert from "node:assert/strict";
import { shutdownPrivateTraceFixture } from "../lifecycle-closeout/shutdown-private-trace.fixture.mjs";

const protectionQuery =
  "SELECT EXISTS ( SELECT 1 FROM tool_attempts AS attempt JOIN runs AS run ON run.id = attempt.run_id JOIN acp_sessions AS session ON session.id = run.session_id WHERE session.organization_id = $1 AND session.agent_id = $2 AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision' = $3) AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped ) OR EXISTS ( SELECT 1 FROM temporary_skill_scopes temporary JOIN runs run ON run.id=temporary.run_id WHERE temporary.organization_id=$1 AND temporary.agent_id=$2 AND temporary.released_at IS NULL AND ($3::text IS NULL OR run.execution_snapshot->'runtime'->>'revision'=$3) ) AS protected";

const set = (span, key, value) => {
  span.tags = span.tags.filter((field) => field.key !== key);
  if (value !== undefined) span.tags.push({ key, value });
};
const frame = (state) =>
  "event: workspace_state\ndata: " + JSON.stringify(state) + "\n\n";

// Controlled fixture conversion only; archived raw evidence is never rewritten.
export function workspaceStateTraceFixture(
  kind = "private_state",
  mode = "local-close",
) {
  assert(["private_state", "private_state_watch"].includes(kind));
  assert(["local-close", "revocation"].includes(mode));
  const f = shutdownPrivateTraceFixture();
  const { trace, expected, receipt, server, client, sql } = f;
  const watch = kind === "private_state_watch";
  const remote = watch && mode === "revocation";
  const state = structuredClone(receipt.events[0]);
  const path =
    "/rpc/agent-acp/" +
    (watch ? "watch-agent-execution-state" : "get-agent-execution-state");

  delete expected.stop;
  delete expected.stopWindow;
  expected.kind = kind;
  expected.mode = mode;
  expected.window = { start: remote ? 2000 : 1000, end: 3500 };
  server.operationName = "HTTP POST " + path;
  for (const key of [
    "error",
    "otel.status_code",
    "error.type",
    "antnest.outcome",
    "antnest.operation.phase",
    "antnest.stream.termination",
  ])
    set(server, key, undefined);
  server.logs = [];
  set(server, "http.route", path);
  set(
    server,
    "rpc.method",
    watch ? "watch_agent_execution_state" : "get_agent_execution_state",
  );
  receipt.path = path;
  receipt.joined = true;
  receipt.errors = [];

  let raw;
  if (watch) {
    receipt.events = [state];
    receipt.terminal_events = [];
    receipt.closure.kind = remote ? "transport-end" : "local-close";
    receipt.body_outcome = remote ? "eof" : "cancelled";
    if (remote) {
      receipt.events.push({
        agent_id: receipt.agentId,
        access_allowed: false,
        availability: "offline",
        active_session_id: null,
        configuration_revision: null,
        unavailable_reason: "access_denied",
      });
      receipt.revocation_start = {
        traceID: receipt.traceID,
        clientSpanID: receipt.clientSpanID,
        observedAt: 2000,
        receivedEvents: 1,
      };
      expected.revocationStart = receipt.revocation_start;
      expected.revocationTraceID = "9".repeat(32);
    } else {
      set(server, "error", true);
      set(server, "otel.status_code", "ERROR");
      set(server, "error.type", "stream_interrupted");
      set(server, "antnest.outcome", "disconnected");
    }
    receipt.closure.receivedEvents = receipt.events.length;
    raw = Buffer.from(receipt.events.map(frame).join(""));
  } else {
    delete receipt.events;
    delete receipt.terminal_events;
    delete receipt.closure;
    delete expected.closure;
    receipt.content_type = "application/json";
    receipt.request_started_at = 1000;
    receipt.response_received_at = 1001;
    receipt.response_completed_at = 2401;
    receipt.body_outcome = "eof";
    raw = Buffer.from(JSON.stringify(state));
  }
  receipt.raw_body_base64 = raw.toString("base64");
  receipt.body_bytes = raw.length;
  set(client, "http.response.body.size", raw.length);
  set(client, "antnest.outcome", receipt.body_outcome);
  set(client, "antnest.http.body.outcome", receipt.body_outcome);
  set(sql, "db.query.text", protectionQuery);
  for (const span of trace.spans)
    if (span.operationName === "SELECT")
      set(span, "db.namespace", "antnest_agent_acp");

  return { ...f, set };
}
