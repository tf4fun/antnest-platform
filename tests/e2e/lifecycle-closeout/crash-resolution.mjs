import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { hasError } from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { inspectLifecycleResolution } from "../stage3-base/resolve-trace.mjs";
import { assertGatewayResolutionAttributes } from "../../support/gateway-resolution.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";
import { resolveTraceDiagnostics } from "../../support/gateway-resolution-evidence.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { inspectCrashRecovery } from "./crash-trace.mjs";

const decisionName = "gateway.identity.resolve";
const idPattern = /^[a-f0-9]{32}$/;

function rawDecision(trace) {
  assertGatewayResolutionAttributes(trace);
  const decisions = trace.spans.filter(
    (span) => span.operationName === decisionName,
  );
  assert.equal(
    decisions.length,
    1,
    "one raw crash admission decision required",
  );
  return decisions[0];
}

function prepare(trace, expected, secrets) {
  const decision = rawDecision(trace);
  const recovery = inspectCrashRecovery(trace, expected, secrets);
  assert(
    recovery.projection.spans.includes(decision),
    "crash projection removed Resolve admission",
  );
  return { ...recovery, decision };
}

function inspectPrepared(trace, expected, secrets, options, recovery) {
  const traces = options.traces ?? new Map([[trace.traceID, trace]]);
  assert(
    traces.get(trace.traceID) === trace,
    "wrong raw current trace snapshot",
  );
  // Only the current killed-process trace has a verified recovery projection.
  // Linked caller, refresh and trigger traces remain complete and unmodified.
  const scoped = new Map(traces);
  scoped.set(trace.traceID, recovery.projection);
  const resolution = inspectLifecycleResolution(
    recovery.projection,
    expected,
    secrets,
    {
      ...options,
      traces: scoped,
    },
  );
  const sources = [...traces.values()];
  return {
    ...recovery.evidence,
    ...resolveTraceDiagnostics(trace, sources),
    gateway_resolution: resolution,
    resolve_source_error_spans: sources
      .filter((source) => source !== trace)
      .reduce(
        (count, source) => count + source.spans.filter(hasError).length,
        0,
      ),
    strict_trace: "failed",
  };
}

export function inspectCrashAdmissionTrace(
  trace,
  expected,
  secrets = [],
  options = {},
) {
  return inspectPrepared(
    trace,
    expected,
    secrets,
    options,
    prepare(trace, expected, secrets),
  );
}

async function readTrace(base, id, request, signal) {
  assert.match(id ?? "", idPattern, "invalid crash Resolve trace ID");
  let response, text;
  try {
    response = await request(`${base.replace(/\/$/, "")}/api/traces/${id}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    text = await response.text();
  } catch {
    signal?.throwIfAborted();
    throw new Error("Jaeger crash trace request failed");
  }
  signal?.throwIfAborted();
  if (response.status === 404) return;
  assert.equal(response.status, 200, "Jaeger crash trace request failed");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Jaeger returned invalid crash trace JSON");
  }
  assert(
    body.errors == null ||
      (Array.isArray(body.errors) && body.errors.length === 0),
    "Jaeger crash query errors require review",
  );
  assert(
    Array.isArray(body.data) && body.data.length <= 1,
    "invalid Jaeger crash trace response",
  );
  if (!body.data.length) return;
  assert.equal(body.data[0]?.traceID, id, "wrong crash Resolve trace");
  return body.data[0];
}

// The normal collectors intentionally reject every missing parent. This owner
// archives the raw closure before proving the existing narrow crash scope and
// admission. No projected snapshot overwrites the original raw evidence.
export async function collectCrashAdmissionTrace(
  base,
  expected,
  secrets,
  options = {},
) {
  const { request = fetch, wait = delay, signal } = options;
  const attempts = options.attempts ?? 40;
  assert(
    Number.isSafeInteger(attempts) && attempts >= 3,
    "invalid crash convergence attempts",
  );
  const directory = evidenceDirectory(options.directory);
  assert(directory, "raw crash evidence archive required");
  assert.match(expected.traceID ?? "", idPattern, "invalid crash trace ID");
  let previous,
    stable = 0,
    lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      const trace = await readTrace(base, expected.traceID, request, signal);
      assert(trace, "crash trace not exported");
      writeEvidenceFile(
        directory,
        `${trace.traceID}.json`,
        JSON.stringify(trace),
      );
      const decision = rawDecision(trace);
      let collection = { traces: new Map(), archivedTraceIDs: new Set() };
      if (tag(decision, "antnest.identity.resolve.source") === "shared") {
        const links = (decision.references ?? []).filter(
          (ref) => ref.refType === "FOLLOWS_FROM",
        );
        assert.equal(
          links.length,
          1,
          "one exact crash Resolve source link required",
        );
        assert.notEqual(
          links[0].traceID,
          trace.traceID,
          "crash shared source must be external",
        );
        const source = await readTrace(base, links[0].traceID, request, signal);
        assert(source, "crash Resolve source not exported");
        collection = await collectResolutionSources(base, [source], {
          request,
          signal,
          directory,
          // The separately retained current trace also consumes one slot.
          maxTraces: 127,
        });
        assert(
          !collection.traces.has(trace.traceID),
          "source closure reentered the crashed current trace",
        );
      }
      collection.traces.set(trace.traceID, trace);
      collection.archivedTraceIDs.add(trace.traceID);
      const checked = inspectPrepared(
        trace,
        expected,
        secrets,
        collection,
        prepare(trace, expected, secrets),
      );
      signal?.throwIfAborted();
      const current = JSON.stringify(
        [...collection.traces.values()]
          .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
          .map((source) => ({
            ...source,
            spans: source.spans.toSorted((a, b) =>
              a.spanID.localeCompare(b.spanID),
            ),
          })),
      );
      stable = current === previous ? stable + 1 : 1;
      previous = current;
      if (stable >= 3) return checked;
      lastError = new Error("crash Resolve closure did not converge");
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      previous = undefined;
      stable = 0;
    }
    if (attempt + 1 < attempts) await wait(1000, undefined, { signal });
  }
  throw lastError;
}
