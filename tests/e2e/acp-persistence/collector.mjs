import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { inspectPrivateCostControlTrace } from "../acp-cost/control-trace.mjs";
import { inspectPrivateCostSessionTrace } from "../acp-cost/session-trace.mjs";
import { reviewCostWarningSources } from "../acp-cost/warning-source.mjs";
import { assertCostTraceSource } from "../acp-cost/trace-source.mjs";
import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { inspectPrivatePersistenceFaultTrace } from "./fault-trace.mjs";
import { indexPersistenceRequests } from "./client-evidence.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { collectPersistenceLifecycleTrace } from "./lifecycle-collector.mjs";
export { collectPersistenceLifecycleTrace };

const ownedReasons = new Set([
  "persistence-lost-acknowledgement",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);
export const privatePersistenceStrictOutcome = (results) =>
  privateACPStrictOutcome(results, ownedReasons);

function faultReceipt(expected, faults) {
  const selected = faults.filter(
    (fault) => fault.label + "-fault" === expected.label,
  );
  assert.equal(
    selected.length,
    1,
    "missing or ambiguous original persistence fault",
  );
  const fault = selected[0];
  // These are annotations added by the index and collector. Every other field
  // must be the exact original recorder row, including its connection identity.
  const annotations = new Set([
    "version",
    "kind",
    "label",
    "phase",
    "connectionTrace",
    "connectionSpanID",
  ]);
  const actual = Object.fromEntries(
    Object.entries(expected).filter(([key]) => !annotations.has(key)),
  );
  assert.deepEqual(
    actual,
    fault.prompt_receipt,
    "fault borrowed another original prompt receipt",
  );
  return fault;
}
export function inspectPrivatePersistenceTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
  faults = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert([1, 2].includes(expected.version));
  assert.equal(expected.protocolVersion, expected.version);
  assert(["request", "ordinary", "fault"].includes(expected.kind));
  assert.equal(typeof expected.label, "string");
  assert.notEqual(expected.closedBeforeResponse, true);
  assert.equal(
    expected.requestReceipt,
    undefined,
    "Persistence must use its original recorder fields",
  );
  assert(
    !requests.some((row) => row.trace_id === expected.connectionTraceID),
    "connection reached Provider",
  );
  const selected = requests.filter(
    (row) => row.trace_id === trace.traceID || row.phase === expected.label,
  );
  assert(
    selected.every(
      (row) => row.trace_id === trace.traceID && row.phase === expected.label,
    ),
    "Provider Trace and Persistence phase disagree",
  );
  assertCostTraceSource(trace, expected.connectionTrace);
  let report;
  if (expected.kind === "fault") {
    report = inspectPrivatePersistenceFaultTrace(
      trace,
      expected,
      faultReceipt(expected, faults),
      secrets,
      selected,
    );
  } else {
    assert.equal(expected.outcome, "succeeded");
    for (const key of [
      "failure",
      "failureCode",
      "rejection",
      "rejectionReceipt",
    ])
      assert.equal(
        expected[key],
        undefined,
        "successful Persistence request retained a failure",
      );
    if (expected.kind === "ordinary") {
      assert.equal(expected.method, "session/prompt");
      assert.equal(expected.phase, expected.label);
      assert.match(
        expected.label,
        new RegExp(`^v${expected.version}-(intent|accept|finish)-post$`, "u"),
      );
      assert.equal(expected.inputSessionID, expected.sessionId);
      assert.deepEqual(expected.requestParams, {
        sessionId: expected.sessionId,
        prompt: [{ type: "text", text: expected.label }],
      });
      if (expected.version === 1)
        assert.equal(expected.requestResult?.stopReason, "end_turn");
      else
        assert(
          typeof expected.requestResult?.messageId === "string" &&
            expected.requestResult.messageId.length > 0,
          "ordinary v2 ACK missing",
        );
      report = inspectPrivateCommandTrace(trace, expected, secrets, selected);
    } else if (expected.method === "initialize") {
      assert.equal(expected.requestParams, undefined);
      assert.equal(expected.requestResult, undefined);
      report = inspectPrivateCostControlTrace(
        trace,
        expected,
        secrets,
        selected,
      );
    } else {
      assert(
        [
          "session/new",
          expected.version === 1 ? "session/load" : "session/resume",
        ].includes(expected.method),
        "unowned Persistence Session method",
      );
      assert.equal(expected.initializationResult, undefined);
      report = inspectPrivateCostSessionTrace(
        trace,
        {
          ...expected,
          requestReceipt: structuredClone({
            requestId: expected.requestId,
            params: expected.requestParams,
            result: expected.requestResult,
          }),
        },
        secrets,
        selected,
      );
    }
  }
  return {
    ...report,
    label: expected.label,
    kind: expected.kind,
    method: expected.method,
    request_id: expected.requestId,
    connection_trace_id: expected.connectionTraceID,
    protocol_version: expected.version,
  };
}

export function collectPrivatePersistenceTrace(base, expected, options = {}) {
  const faults = structuredClone(options.faults ?? []);
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons,
    inspect: (trace, bound, secrets, requests) =>
      inspectPrivatePersistenceTrace(trace, bound, secrets, requests, faults),
    inspectCompleteSources: ({ sources, reports }) => {
      const policy = reviewCostWarningSources(
        sources,
        reports.flatMap((report) => report.time_observations ?? []),
      );
      assert.equal(
        policy.eligible_for_review,
        true,
        "unreviewed Persistence diagnostic",
      );
    },
  });
}

// Lifecycle admission and private ACP have distinct raw error inventories.
// One cannot acquire the other's injected-fault or business diagnostic claims.
export function persistenceTraceOutcome(privateResults, lifecycleResults) {
  try {
    assert(Array.isArray(lifecycleResults) && lifecycleResults.length === 2);
    assert.deepEqual(lifecycleResults.map((row) => row.kind).sort(), [
      "create",
      "delete",
    ]);
    const all = [...privateResults, ...lifecycleResults];
    assert.equal(
      new Set(all.map((row) => row.trace_id)).size,
      all.length,
      "reused Persistence Trace",
    );
    const privateOutcome = privatePersistenceStrictOutcome(privateResults);
    assert.equal(privateOutcome.accepted, true);
    assert(
      clockWarningsOnly(lifecycleResults),
      "unreviewed Lifecycle diagnostic",
    );
    const failed = all.some((row) => row.strict_trace === "failed");
    return {
      ...privateOutcome,
      strict_trace: failed ? "failed" : "passed",
      accepted: true,
      exit_code: failed ? 2 : 0,
    };
  } catch {
    return { strict_trace: "failed", accepted: false, exit_code: 1 };
  }
}

export async function collectPersistenceTraceEvidence(
  base,
  input,
  options = {},
) {
  const {
    initializations,
    requests,
    connections,
    faults,
    lifecycle,
    modelRequests,
  } = structuredClone(input);
  const directory = evidenceDirectory(options.directory);
  assert(directory, "Persistence collection requires private evidence storage");
  const result = {
    strict_trace: "failed",
    accepted: false,
    exit_code: 1,
    privateResults: [],
    lifecycleResults: [],
  };
  const preserve = () =>
    writeEvidenceFile(
      directory,
      "collection.private.json",
      JSON.stringify(result) + "\n",
    );
  preserve();
  assert.deepEqual(lifecycle.map((row) => row.kind).sort(), [
    "create",
    "delete",
  ]);
  const agentId = lifecycle[0].agentId;
  assert(lifecycle.every((row) => row.agentId === agentId));
  assert.deepEqual(
    { requests, initializations },
    indexPersistenceRequests({ agentId, connections }),
    "Persistence index changed after original receipt validation",
  );
  const faultLabels = requests
    .filter((row) => row.kind === "fault")
    .map((row) => row.label.slice(0, -6));
  assert.deepEqual(faults.map((row) => row.label).sort(), faultLabels.sort());
  const providerLabels = requests
    .filter(
      (row) =>
        row.kind === "ordinary" ||
        (row.kind === "fault" && row.phase === "finish"),
    )
    .map((row) => row.label);
  assert.equal(modelRequests.length, 16);
  assert(
    modelRequests.every((row) => providerLabels.includes(row.phase)),
    "unowned Persistence Provider phase",
  );
  for (const phase of providerLabels)
    assert.equal(modelRequests.filter((row) => row.phase === phase).length, 2);
  const collectOptions = {
    ...options,
    directory,
    requests: modelRequests,
    faults,
  };
  for (const expected of [...initializations, ...requests]) {
    options.signal?.throwIfAborted();
    await options.onStage?.(expected);
    const report = await collectPrivatePersistenceTrace(
      base,
      expected,
      collectOptions,
    );
    options.signal?.throwIfAborted();
    result.privateResults.push(report);
    preserve();
  }
  for (const expected of lifecycle) {
    options.signal?.throwIfAborted();
    await options.onStage?.(expected);
    const report = await collectPersistenceLifecycleTrace(
      base,
      expected,
      collectOptions,
    );
    options.signal?.throwIfAborted();
    result.lifecycleResults.push(report);
    preserve();
  }
  const { privateResults, lifecycleResults } = result;
  assert.equal(privateResults.length, 48);
  const runIDs = privateResults
    .filter((row) => row.run_id)
    .map((row) => row.run_id);
  assert.equal(runIDs.length, 12);
  assert.equal(new Set(runIDs).size, 12, "Persistence reused a durable Run");
  assert.equal(
    privateResults.reduce((sum, row) => sum + (row.runs ?? 0), 0),
    8,
  );
  assert.equal(
    privateResults.reduce((sum, row) => sum + (row.runtime_tool_calls ?? 0), 0),
    8,
  );
  const executing = privateResults.filter((row) => row.runs === 1);
  assert(
    modelRequests.every((row) =>
      executing.some(
        (report) =>
          report.trace_id === row.trace_id && report.label === row.phase,
      ),
    ),
    "unaccounted Persistence Provider request",
  );
  const outcome = persistenceTraceOutcome(privateResults, lifecycleResults);
  assert.equal(outcome.accepted, true, "unreviewed Persistence diagnostics");
  options.signal?.throwIfAborted();
  Object.assign(result, outcome);
  preserve();
  return result;
}
