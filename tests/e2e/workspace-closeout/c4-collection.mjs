import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { c4PromptExpectations } from "./c4-inventory.mjs";
import { inspectC4RunTrace } from "./c4-run-trace.mjs";
import { inspectC4RevocationTrace } from "./c4-revocation-trace.mjs";
import { collectWorkspaceHTTPTrace } from "./http-collector.mjs";
import { canonicalCompleteSources } from "../../support/complete-source-inspection.mjs";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { hasDiagnosticError } from "../acp-plan/requests.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";

const reasons = new Set([
  "model-cancellation",
  "model-http-cancellation",
  "multimodal-model-unsupported-content",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
  "public-sse-revoked-handler",
  "public-sse-revoked-response",
  "c4-revoked-identity-resolve",
  "c4-revoked-prompt-denial",
  "serialization-retry",
]);
const key = (claim) => `${claim.trace_id}/${claim.span_id}`;
export const c4TraceOutcome = (reports) =>
  privateACPStrictOutcome(reports, reasons);

// Each original root gets an independent archive attempt, including partially
// observed revocations. A missing SSE export must not suppress login, mutation
// or denial response bytes. Admission separately requires the whole inventory.
export function c4TraceInventory(report, config) {
  const rows = c4PromptExpectations(report),
    revoke = report.browser_revocation;
  if (!revoke) return rows;
  const offboarding = revoke.offboarding_expected;
  const revocation = {
    ...revoke,
    traceID: revoke.traceID ?? revoke.checkpoint?.stream?.trace_id,
    gateway: config.gateway,
    login: report.page_login,
    offboarding: {
      source_trace_id: offboarding?.sourceID,
      trace_id: offboarding?.traceID,
      agent_id: offboarding?.agentID,
      request_id: offboarding?.requestID,
      owner_revocation: offboarding?.ownerRevocation?.event,
      disabled_event: offboarding?.disabledEvent,
    },
  };
  const ids = [
    ...new Set(
      [
        revocation.traceID,
        report.page_login?.receipt?.traceID,
        revoke.cause?.traceID,
        revoke.denial?.traceID,
      ].filter((id) => typeof id === "string" && id),
    ),
  ];
  for (const traceID of ids)
    rows.push({
      kind: "c4_revocation",
      traceID,
      revocation,
      relatedTraceIDs: ids.filter((id) => id !== traceID),
    });
  return rows;
}

export function inspectC4TraceSources(
  trace,
  expected,
  secrets,
  collection,
  inventory,
) {
  assert(Array.isArray(inventory));
  const matching = inventory.filter((row) => row.traceID === expected.traceID);
  assert.equal(
    matching.length,
    1,
    "one original C4 collection expectation required",
  );
  assert.deepEqual(matching[0], expected);
  assert.equal(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, collection),
    traces = new Map(sources.map((source) => [source.traceID, source])),
    options = { ...collection, traces },
    reports = [],
    ownedSources = new Set();
  for (const row of inventory.filter(
    (row) => row.kind === "c4_run" && traces.has(row.traceID),
  )) {
    reports.push(
      inspectC4RunTrace(traces.get(row.traceID), row, secrets, options),
    );
    ownedSources.add(row.traceID);
  }
  const revocations = new Map();
  for (const row of inventory.filter((row) => row.kind === "c4_revocation")) {
    const original = row.revocation;
    if (expected.kind !== "c4_revocation" && !traces.has(original?.traceID))
      continue;
    const id = original?.traceID;
    if (revocations.has(id)) assert.deepEqual(revocations.get(id), original);
    else revocations.set(id, original);
  }
  for (const [id, original] of revocations) {
    assert(traces.has(id), "original C4 revocation SSE source missing");
    reports.push(
      inspectC4RevocationTrace(traces.get(id), original, secrets, options),
    );
    for (const owned of [
      id,
      original.login.receipt.traceID,
      original.cause.traceID,
      original.denial.traceID,
    ])
      ownedSources.add(owned);
  }
  assert(reports.length > 0, "C4 source has no owning acceptance");
  assert(["c4_run", "c4_revocation"].includes(expected.kind));
  // Known failures are checked by their owning Run/revocation inspector.
  // Sources outside that inventory have no authority to carry diagnostics.
  for (const source of sources)
    if (!ownedSources.has(source.traceID))
      for (const span of source.spans) assertSessionSuccess(span);
  const rawIDs = new Set(
      sources.flatMap((source) =>
        source.spans
          .filter(hasDiagnosticError)
          .map((span) =>
            key({ trace_id: source.traceID, span_id: span.spanID }),
          ),
      ),
    ),
    claims = new Map();
  for (const report of reports) {
    const own = [
      ...(report.owned_error_spans ?? []),
      ...(report.neutral_diagnostics ?? []).filter((claim) =>
        rawIDs.has(key(claim)),
      ),
    ];
    assert.equal(
      new Set(own.map(key)).size,
      own.length,
      "duplicate owning C4 diagnostic claim",
    );
    for (const claim of own) {
      if (claims.has(key(claim)))
        assert.deepEqual(claims.get(key(claim)), claim);
      else claims.set(key(claim), claim);
    }
  }
  return {
    kind: expected.kind,
    trace_id: trace.traceID,
    expected: structuredClone(expected),
    owning_reports: reports,
    original_sources: structuredClone(sources),
    source_snapshot_sha256: createHash("sha256")
      .update(canonicalCompleteSources(sources))
      .digest("hex"),
    ...resolveTraceDiagnostics(trace, sources),
    ...privateACPDiagnosticInventory(
      sources,
      [{ owned_error_spans: [...claims.values()] }],
      reasons,
    ),
  };
}

export function collectC4Trace(base, expected, { inventory, ...options }) {
  const original = structuredClone(inventory);
  return collectWorkspaceHTTPTrace(
    base,
    expected,
    options,
    (trace, bound, secrets, collection) =>
      inspectC4TraceSources(trace, bound, secrets, collection, original),
  );
}
