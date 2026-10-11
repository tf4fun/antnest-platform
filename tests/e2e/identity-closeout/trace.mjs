import assert from "node:assert/strict";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { setTimeout as delay } from "node:timers/promises";
import {
  inspectIdentityTraceTopology,
  identityTraceSources,
  identityTraceDiagnostics,
} from "./support.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";

export function correlateOIDCRequests(expectations, received) {
  return expectations.map((expected) => ({
    ...expected,
    ...(expected.oidcRequests
      ? {
          oidcRequests: expected.oidcRequests.map((request) => {
            const matches = received.filter(
              (record) =>
                record.method === request.method &&
                record.url === request.url &&
                record.traceparent?.split("-")[1] === expected.traceID,
            );
            assert.equal(
              matches.length,
              1,
              "missing or duplicate actual IdP request",
            );
            assert.match(
              matches[0].traceparent,
              /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
            );
            assert.equal(matches[0].status, 200, "actual IdP request failed");
            return { ...request, spanID: matches[0].traceparent.split("-")[2] };
          }),
        }
      : {}),
  }));
}

export const identityEvidenceExitCode = (evidence) =>
  evidence.some((item) => item.strict_trace === "failed") ? 2 : 0;

export async function verifyIdentityEvidence(
  base,
  expectations,
  secrets,
  {
    request = fetch,
    wait = delay,
    attempts = 40,
    directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
    inspect = inspectIdentityTraceTopology,
    signal,
  } = {},
) {
  assert(expectations.length > 0, "Identity trace expectations absent");
  signal?.throwIfAborted();
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
            const sources = identityTraceSources(trace, secrets, collection);
            const checked = [];
            for (const item of expectations.filter(
              (item) => item.traceID === id,
            )) {
              checked.push(await inspect(trace, item, secrets, collection));
              signal?.throwIfAborted();
            }
            const diagnostics = identityTraceDiagnostics(trace, sources);
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
              complete = checked.map((item) => ({
                ...item,
                ...diagnostics,
              }));
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
