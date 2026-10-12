import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { assertSecretFree } from "../e2e/identity-closeout/evidence.mjs";
import { hasError } from "../e2e/acp-plan/requests.mjs";
import {
  assertCaptureDisabled,
  traceTopology,
} from "../e2e/observability/trace-tree.mjs";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "./storage.mjs";
import { collectResolutionSources } from "./gateway-resolution-collect.mjs";

export function resolveTraceSources(trace, secrets, options = {}) {
  const traces = options.traces ?? new Map([[trace.traceID, trace]]);
  assert(traces.get(trace.traceID) === trace, "wrong current trace snapshot");
  for (const [id, source] of traces) {
    assert.equal(source.traceID, id, "wrong source trace snapshot");
    traceTopology(source);
    assertCaptureDisabled(source);
    assertSecretFree(JSON.stringify(source), secrets);
  }
  return [...traces.values()];
}

export function resolveTraceDiagnostics(trace, sources) {
  const warnings = sources.flatMap((source) => [
    ...(source.warnings ?? []),
    ...source.spans.flatMap((span) => span.warnings ?? []),
  ]);
  const errors = sources.reduce(
    (count, source) => count + source.spans.filter(hasError).length,
    0,
  );
  return {
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    error_spans: errors,
    strict_trace: warnings.length || errors ? "failed" : "passed",
    source_trace_ids: sources
      .map((source) => source.traceID)
      .filter((id) => id !== trace.traceID)
      .sort(),
  };
}

export async function collectResolveTraceEvidence(
  base,
  expectations,
  secrets,
  {
    request = fetch,
    wait = delay,
    attempts = 40,
    directory,
    inspect,
    signal,
  } = {},
) {
  assert(expectations.length > 0, "Identity trace expectations absent");
  signal?.throwIfAborted();
  assert.equal(typeof inspect, "function", "owning trace inspector required");
  directory = evidenceDirectory(directory);
  const ids = new Set(expectations.map((item) => item.traceID));
  for (const id of ids) {
    assert.match(id ?? "", /^[a-f0-9]{32}$/, "Gateway trace ID missing");
    evidenceFilePath(directory, `${id}.json`);
  }
  const result = [];
  for (const id of ids) {
    let previous,
      stable = 0,
      lastError,
      complete;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      let response, text;
      try {
        response = await request(
          `${base.replace(/\/$/, "")}/api/traces/${id}`,
          {
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
          },
        );
        text = await response.text();
      } catch {
        signal?.throwIfAborted();
        throw new Error("Jaeger trace request failed");
      }
      signal?.throwIfAborted();
      if (response.status !== 404) {
        assert.equal(response.status, 200, "Jaeger trace request failed");
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error("Jaeger returned invalid JSON");
        }
        assert(
          body.errors == null ||
            (Array.isArray(body.errors) && body.errors.length === 0),
          "Jaeger backend errors require review",
        );
        assert(
          Array.isArray(body.data) && body.data.length <= 1,
          "invalid Jaeger trace response",
        );
        if (!body.data.length) {
          previous = undefined;
          stable = 0;
        }
        if (body.data.length) {
          const trace = body.data[0];
          assert.equal(trace.traceID, id, "wrong Identity trace");
          try {
            const collection = await collectResolutionSources(base, [trace], {
              request,
              signal,
              directory,
            });
            const sources = resolveTraceSources(trace, secrets, collection);
            const checked = [];
            for (const item of expectations.filter(
              (item) => item.traceID === id,
            )) {
              checked.push(await inspect(trace, item, secrets, collection));
              signal?.throwIfAborted();
            }
            const diagnostics = resolveTraceDiagnostics(trace, sources);
            // A source/trigger can export SQL or diagnostics after the waiter.
            // Convergence therefore covers the entire validated raw closure,
            // including payloads and warnings, not only the waiter's span IDs.
            const current = JSON.stringify(
              sources
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
            if (stable >= 3) {
              if (directory) {
                writeEvidenceFile(
                  directory,
                  `${id}.json`,
                  JSON.stringify(trace),
                );
              }
              complete = checked.map((item) => {
                // Top-level counts describe the raw closure. Keep the owning
                // gate's original fields too: some use warning counts or error
                // detail arrays, and custom warnings still need CI review.
                const owning = Object.fromEntries(
                  Object.keys(diagnostics)
                    .filter((key) => Object.hasOwn(item, key))
                    .map((key) => [key, item[key]]),
                );
                return {
                  ...item,
                  ...diagnostics,
                  ...(Object.keys(owning).length
                    ? { inspector_diagnostics: owning }
                    : {}),
                  // Resolve provenance cannot clear a failure already
                  // established by the owning business gate.
                  strict_trace:
                    item.strict_trace === "failed"
                      ? "failed"
                      : diagnostics.strict_trace,
                };
              });
              break;
            }
            lastError = new Error("Identity trace export did not converge");
          } catch (error) {
            signal?.throwIfAborted();
            lastError = error;
            previous = undefined;
            stable = 0;
          }
        }
      }
      if (response.status === 404) {
        previous = undefined;
        stable = 0;
      }
      if (attempt + 1 < attempts) await wait(1000, undefined, { signal });
    }
    assert(complete, lastError?.message ?? "Identity trace not exported");
    result.push(...complete);
  }
  return result;
}
