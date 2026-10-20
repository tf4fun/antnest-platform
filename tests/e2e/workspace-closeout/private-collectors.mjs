import assert from "node:assert/strict";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
} from "../../support/gateway-resolution-evidence.mjs";
import { collectWorkspaceHTTPTrace as collectHTTP } from "./http-collector.mjs";
import { collectPrivateACPConsumerTrace } from "../acp-commands/collector.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
import { inspectPrivateManagedTrace } from "../managed-mcp/request-trace.mjs";
import {
  inspectProgressBarrierTrace,
  inspectProgressCancelTrace,
} from "../acp-progress/control-trace.mjs";
import { collectPrivateACPNotificationTrace } from "../identity-closeout/private-acp-trace.mjs";
import { assertRuntimeBinding } from "../acp-restart/trace.mjs";
import { privateACPDiagnosticInventory } from "../observability/private-acp-inventory.mjs";
import { workspacePrivateErrorReasons as reasons } from "./private-diagnostics.mjs";
export { workspacePrivateTraceOutcome } from "./private-diagnostics.mjs";
import { inspectWorkspaceDisconnectedTrace } from "./private-disconnect-trace.mjs";
import { inspectWorkspaceAccessDeniedTrace } from "./private-denial-trace.mjs";
import { inspectWorkspaceStateTrace } from "./private-http-trace.mjs";
import { inspectWorkspaceAuthorityTrace } from "./private-authority-trace.mjs";
import { inspectWorkspaceOffboardingTrace } from "./private-offboarding-trace.mjs";

export async function inspectWorkspacePrivateRequest(
  trace,
  expected,
  secrets = [],
  requests = [],
  options = {},
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.protocolVersion, 1);
  assert(["request", "ordinary", "cancelled"].includes(expected.kind));
  let result;
  if (["c4-cancel", "c4-offline"].includes(expected.phase))
    result = await inspectWorkspaceDisconnectedTrace(
      trace,
      expected,
      secrets,
      requests,
      { receipt: options.receipt },
    );
  else if (expected.rejection === "runtime_barrier_required")
    result = inspectProgressBarrierTrace(trace, expected, secrets, requests);
  else if (expected.rejection === "agent_busy")
    result = inspectPrivateManagedTrace(trace, expected, secrets, requests);
  else if (expected.rejection === "access_denied")
    result = inspectWorkspaceAccessDeniedTrace(
      trace,
      expected,
      secrets,
      requests,
    );
  else {
    assert(expected.phase === undefined || expected.phase === "c4-rebuilt");
    assert.equal(expected.rejection, undefined);
    result = inspectPrivateCommandTrace(trace, expected, secrets, requests);
  }
  if (expected.phase || expected.runId) {
    assert.equal(
      result.run_id,
      expected.runId,
      "Workspace Trace uses another Run",
    );
    assert(
      expected.runId && expected.run && expected.runtime,
      "original Workspace Run and Runtime required",
    );
    assertRuntimeBinding(trace, expected.run, expected.runtime);
  }
  for (const [key, value] of Object.entries({
    kind: expected.kind,
    method: expected.method,
    request_id: expected.requestId,
    connection_trace_id: expected.connectionTraceID,
    ...(expected.sessionId ? { session_id: expected.sessionId } : {}),
  })) {
    if (Object.hasOwn(result, key))
      assert.equal(result[key], value, "Workspace report identity differs");
    result[key] = value;
  }
  return result;
}

export async function collectWorkspacePrivateRequest(
  base,
  expected,
  options,
  sidecar = {},
) {
  // The original WeakMap receipt stays outside any generic expectation clone.
  const failures = [];
  try {
    return await collectPrivateACPConsumerTrace(base, expected, options, {
      inspect: async (trace, bound, secrets, requests) => {
        try {
          return await inspectWorkspacePrivateRequest(
            trace,
            bound,
            secrets,
            requests,
            sidecar,
          );
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
      ownedReasons: reasons,
      inspectCompleteSources: () => {},
    });
  } catch (error) {
    if (!failures.length) throw error;
    // The shared convergence collector keeps raw attempts but replaces the
    // owning error. Retain originals for the Workspace private failure archive.
    throw new AggregateError(
      [error, ...failures],
      "Workspace request Trace collection failed",
    );
  }
}
export function collectWorkspacePrivateNotification(base, receipt, options) {
  return collectPrivateACPNotificationTrace(base, receipt, {
    ...options,
    inspect: (trace, bound, secrets) =>
      inspectWorkspacePrivateNotification(
        trace,
        receipt,
        bound.connectionTrace,
        secrets,
      ),
  });
}
export function inspectWorkspacePrivateNotification(
  trace,
  receipt,
  connectionTrace,
  secrets = [],
) {
  const result = inspectProgressCancelTrace(
    trace,
    receipt,
    connectionTrace,
    secrets,
  );
  return {
    ...result,
    ...privateACPDiagnosticInventory(
      [trace, connectionTrace],
      [result],
      new Set(),
    ),
    kind: "notification",
    method: receipt.method,
    session_id: receipt.sessionId,
    connection_trace_id: receipt.connectionTraceID,
  };
}
export { collectHTTP as collectWorkspaceHTTPTrace };
export const collectWorkspacePrivateHTTP = (base, expected, options) =>
  collectHTTP(base, expected, options, inspectWorkspaceStateTrace);
export const collectWorkspaceAuthorityTrace = (base, expected, options) =>
  collectHTTP(base, expected, options, inspectWorkspaceAuthorityTrace);

export async function collectWorkspaceOffboarding(
  config,
  expected,
  secrets,
  signal,
) {
  const [result] = await collectResolveTraceEvidence(
    config.jaeger,
    [expected],
    secrets,
    {
      directory: config.evidence + "/traces",
      signal,
      inspect: (trace, bound, privacy, sources) =>
        inspectWorkspaceOffboardingTrace(
          resolveTraceSources(trace, privacy, sources),
          bound,
          privacy,
        ),
    },
  );
  return result;
}
