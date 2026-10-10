import assert from "node:assert/strict";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { assertEventPage } from "./evidence.mjs";

const traceIdentity = /^[a-f0-9]{32}$/u;
const eventIdentity = /^[a-zA-Z0-9_-]+$/u;

function assertCompletePage(page, agentID) {
  assert(page && typeof page === "object" && !Array.isArray(page));
  assert(Array.isArray(page.events), "event list missing");
  assert(page.events.length < 100, "replay history may be truncated");
  assertEventPage(page, 0, new Set(), agentID);
  let aggregate = 0;
  for (const event of page.events) {
    assert(
      Number.isSafeInteger(event.aggregate_sequence) &&
        event.aggregate_sequence > aggregate,
      "aggregate sequence not positive/increasing",
    );
    aggregate = event.aggregate_sequence;
  }
}

function assertIndependentEvent(
  event,
  { agentID, runtimeRevision, admissionTraceID, replayTraceID },
) {
  assert(event && typeof event === "object" && !Array.isArray(event));
  assert.equal(event.event_type, "agent_runtime_condition_changed");
  assert.equal(event.agent_id, agentID, "observation belongs to another Agent");
  assert(
    event.operation_request_id === undefined ||
      event.operation_request_id === "",
    "observation is associated with a command",
  );
  assert.match(
    event.event_id,
    eventIdentity,
    "invalid observation event identity",
  );
  assert(
    Number.isSafeInteger(event.aggregate_sequence) &&
      event.aggregate_sequence > 0 &&
      Number.isSafeInteger(event.global_sequence) &&
      event.global_sequence > 0 &&
      event.schema_version === 1,
    "invalid observation sequence/schema",
  );
  assert(
    typeof event.occurred_at === "string" &&
      Number.isFinite(Date.parse(event.occurred_at)),
    "invalid public observation date",
  );
  assert(
    typeof runtimeRevision === "string" && runtimeRevision.length > 0,
    "observation target missing",
  );
  assert.match(admissionTraceID, traceIdentity, "admission trace missing");
  assert.match(replayTraceID, traceIdentity, "replay trace missing");
  assert.match(event.trace_id, traceIdentity, "observation trace missing");
  assert.notEqual(
    event.trace_id,
    admissionTraceID,
    "observation reused admission trace",
  );
  assert.notEqual(
    event.trace_id,
    replayTraceID,
    "observation reused replay trace",
  );
}

function assertObservationEvidence(evidence, event, agentID) {
  assert(
    evidence && typeof evidence === "object" && !Array.isArray(evidence),
    "observation collector returned no verified evidence",
  );
  assert.equal(evidence.kind, "runtime-observation");
  assert.equal(
    evidence.topology,
    "passed",
    "observation topology was not verified",
  );
  assert.equal(
    evidence.event_id,
    event.event_id,
    "collector returned another event",
  );
  assert.equal(
    evidence.trace_id,
    event.trace_id,
    "collector returned another trace",
  );
  assert.equal(evidence.agent_id, agentID, "collector returned another Agent");
  assert(Number.isSafeInteger(evidence.spans) && evidence.spans > 0);
  assert.equal(evidence.error_spans, 0, "observation trace contains errors");
  assert(Array.isArray(evidence.warnings), "observation warnings missing");
  assert(
    evidence.warnings.every(
      (warning) =>
        typeof warning === "string" && clockSkewWarning.test(warning),
    ),
    "unreviewed observation trace warning",
  );
  assert.equal(evidence.warning_count, evidence.warnings.length);
  assert.equal(
    evidence.strict_trace,
    evidence.warnings.length ? "failed" : "passed",
    "observation strict verdict differs from its findings",
  );
}

// Replay preserves the full old history. Only a failed-start Create may append
// independently verified Runtime observations while its replay is read.
export async function assertReplayHistory(input, collect) {
  const { before, after, agentID, kind, runtimeStartupFailure } = input;
  assertCompletePage(before, agentID);
  assertCompletePage(after, agentID);
  const metadata = ({ events, next_sequence, ...rest }) => rest;
  assert.deepEqual(
    metadata(after),
    metadata(before),
    "replay changed page metadata",
  );
  assert.deepEqual(
    after.events.slice(0, before.events.length),
    before.events,
    "replay changed the old event history",
  );
  const appended = after.events.slice(before.events.length);
  if (appended.length === 0) return [];
  assert(
    kind === "create" && runtimeStartupFailure === true,
    "replay changed event history outside a failed-start Create",
  );
  assert.equal(typeof collect, "function", "observation collector missing");
  const evidence = [];
  for (const event of appended) {
    assertIndependentEvent(event, input);
    const observed = await collect(event);
    assertObservationEvidence(observed, event, agentID);
    evidence.push(observed);
  }
  return evidence;
}

export function inspectReplayObservation(
  trace,
  {
    event,
    persisted,
    agentID,
    runtimeRevision,
    admissionTraceID,
    replayTraceID,
  },
  secrets = [],
) {
  assertIndependentEvent(event, {
    agentID,
    runtimeRevision,
    admissionTraceID,
    replayTraceID,
  });
  assert(
    persisted && typeof persisted === "object" && !Array.isArray(persisted),
    "persisted observation event missing",
  );
  for (const field of [
    "event_id",
    "agent_id",
    "aggregate_sequence",
    "global_sequence",
    "schema_version",
    "event_type",
    "trace_id",
  ])
    assert.equal(
      persisted[field],
      event[field],
      "public/persisted observation mismatch",
    );
  assert.equal(
    persisted.operation_request_id,
    "",
    "persisted event belongs to a command",
  );
  assert(
    persisted.data &&
      typeof persisted.data === "object" &&
      !Array.isArray(persisted.data),
    "persisted observation data missing",
  );
  assert.equal(
    persisted.data.runtime_revision,
    runtimeRevision,
    "observation target differs",
  );
  assert.equal(trace?.traceID, event.trace_id, "trace differs from its event");
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify({ trace, persisted, event }), secrets);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "one observation root required");
  const [root] = roots;
  assert.equal(tree.service(root), "agent-controller");
  assert.equal(
    root.operationName,
    "agent_controller.runtime_observation.synchronize",
  );
  assert.equal(
    tag(root, "span.kind"),
    "consumer",
    "observation root is not a Consumer",
  );
  for (const span of trace.spans) {
    assert(
      Number.isFinite(span.duration) && span.duration >= 0,
      "unfinished observation span",
    );
    assert(tag(span, "error") !== true, "observation trace contains errors");
    assert(
      !["ERROR", "Error", 2].includes(tag(span, "otel.status_code")),
      "observation trace contains an error status",
    );
  }
  const successful = (span) =>
    Number(tag(span, "http.response.status_code")) === 200;
  const inspection = trace.spans.find((span) => {
    if (
      tree.service(span) !== "runtime-controller" ||
      tag(span, "span.kind") !== "server" ||
      tag(span, "http.request.method") !== "GET" ||
      tag(span, "http.route") !== "/internal/runtimes/{agent_id}" ||
      !successful(span)
    )
      return false;
    const client = tree.parent(span);
    return (
      client &&
      tree.service(client) === "agent-controller" &&
      tag(client, "span.kind") === "client" &&
      tag(client, "http.request.method") === "GET" &&
      tag(client, "rpc.method") === "inspect" &&
      tag(client, "antnest.agent.id") === agentID &&
      successful(client) &&
      tree.chain(client).includes(root)
    );
  });
  assert(inspection, "matching independent Runtime inspection missing");
  const inserted = trace.spans.some((span) => {
    const query = tag(span, "db.query.text");
    if (
      tree.service(span) !== "agent-controller" ||
      span.operationName !== "INSERT" ||
      typeof query !== "string" ||
      !/^\s*INSERT\s+INTO\s+agent_controller\.agent_events(?:\s|\()/iu.test(
        query,
      )
    )
      return false;
    const transaction = tree.parent(span);
    return (
      transaction &&
      tree.service(transaction) === "agent-controller" &&
      transaction.operationName === "postgresql transaction" &&
      tree.chain(transaction).includes(root) &&
      trace.spans.some(
        (commit) =>
          tree.service(commit) === "agent-controller" &&
          commit.operationName === "COMMIT" &&
          tree.parent(commit) === transaction,
      )
    );
  });
  assert(inserted, "observation event INSERT transaction was not committed");
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  assert(
    warnings.every(
      (warning) =>
        typeof warning === "string" && clockSkewWarning.test(warning),
    ),
    "unreviewed observation trace warning",
  );
  return {
    kind: "runtime-observation",
    topology: "passed",
    trace_id: trace.traceID,
    event_id: event.event_id,
    agent_id: agentID,
    spans: trace.spans.length,
    strict_trace: warnings.length ? "failed" : "passed",
    warning_count: warnings.length,
    warnings,
    error_spans: 0,
  };
}

export function observationEventQuery(eventID) {
  assert(
    typeof eventID === "string" &&
      eventIdentity.test(eventID) &&
      !/[\r\n]/u.test(eventID),
    "invalid observation event identity",
  );
  return `SELECT row_to_json(event_evidence) FROM (
SELECT event_id, agent_id, aggregate_sequence, global_sequence, schema_version,
       event_type, trace_id, operation_request_id, data
FROM agent_controller.agent_events WHERE event_id='${eventID}'
) AS event_evidence`;
}
