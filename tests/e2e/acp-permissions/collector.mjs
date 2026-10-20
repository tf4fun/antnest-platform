import assert from "node:assert/strict";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { collectPrivateACPNotificationTrace } from "../identity-closeout/private-acp-trace.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { reviewCostWarningSources } from "../acp-cost/warning-source.mjs";
import { inspectPrivateCostControlTrace } from "../acp-cost/control-trace.mjs";
import { inspectPrivateCostSessionTrace } from "../acp-cost/session-trace.mjs";
import { inspectProgressCancelTrace } from "../acp-progress/control-trace.mjs";
import { inspectPermissionConfigurationTrace } from "./configuration-trace.mjs";
import { inspectPermissionTrace } from "./trace.mjs";

const ownedReasons = new Set([
  "cost-rejection",
  "permission-rejection",
  "permission-replay-disconnect",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);

export const privatePermissionStrictOutcome = (results) =>
  privateACPStrictOutcome(results, ownedReasons);

export function inspectPrivatePermissionTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert(["request", "execution"].includes(expected.kind));
  const execution = expected.kind === "execution";
  const selected = requests.filter(
    (row) =>
      row.trace_id === trace.traceID ||
      (execution && row.phase === expected.phase),
  );
  if (execution)
    return inspectPermissionTrace(trace, selected, expected, secrets);
  if (expected.method === "initialize" || expected.rejection !== undefined)
    return inspectPrivateCostControlTrace(trace, expected, secrets, selected);
  if (expected.method === "session/set_config_option")
    return inspectPermissionConfigurationTrace(
      trace,
      expected,
      secrets,
      selected,
    );
  assert(
    ["session/new", "session/load", "session/resume"].includes(expected.method),
    "unowned Permissions method",
  );
  return inspectPrivateCostSessionTrace(trace, expected, secrets, selected);
}

// Shared collectors retain every raw response and require three unchanged,
// complete source samples. This consumer only supplies its business inspector.
const sourceInspection =
  (requests, notification = false) =>
  ({ expected, sources, reports }) => {
    assert(
      !requests.some(
        (row) =>
          row.trace_id === expected.connectionTraceID ||
          (notification && row.trace_id === reports[0].trace_id),
      ),
      "Permissions connection or notification reached Provider",
    );
    const policy = reviewCostWarningSources(
      sources,
      reports.flatMap((report) => report.time_observations ?? []),
    );
    assert.equal(
      policy.eligible_for_review,
      true,
      "unreviewed Permissions diagnostic",
    );
  };

export function collectPrivatePermissionTrace(base, expected, options = {}) {
  return collectPrivateACPConsumerTrace(base, expected, options, {
    ownedReasons,
    inspect: inspectPrivatePermissionTrace,
    inspectCompleteSources: sourceInspection(options.requests ?? []),
  });
}

export function collectPrivatePermissionNotificationTrace(
  base,
  receipt,
  options = {},
) {
  return collectPrivateACPNotificationTrace(base, receipt, {
    ...options,
    inspectCompleteSources: sourceInspection(options.requests ?? [], true),
    inspect: (trace, bound, secrets) => {
      const report = inspectProgressCancelTrace(
        trace,
        receipt,
        bound.connectionTrace,
        secrets,
      );
      return {
        ...report,
        ...privateACPDiagnosticInventory(
          [trace, bound.connectionTrace],
          [report],
          ownedReasons,
        ),
      };
    },
  });
}
