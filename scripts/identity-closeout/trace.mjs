import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { inspectIdentityTraceTopology } from "./support.mjs";
import { hasError } from "../acp-plan/requests.mjs";

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
  } = {},
) {
  assert(expectations.length > 0, "Identity trace expectations absent");
  const result = [];
  for (const id of new Set(expectations.map((item) => item.traceID))) {
    assert.match(id ?? "", /^[a-f0-9]{32}$/, "Gateway trace ID missing");
    let previous,
      stable = 0,
      lastError,
      complete;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response, text;
      try {
        response = await request(
          `${base.replace(/\/$/, "")}/api/traces/${id}`,
          { signal: AbortSignal.timeout(10000) },
        );
        text = await response.text();
      } catch {
        throw new Error("Jaeger trace request failed");
      }
      if (response.status !== 404) {
        assert.equal(response.status, 200, "Jaeger trace request failed");
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error("Jaeger returned invalid JSON");
        }
        assert.equal(
          body.errors?.length ?? 0,
          0,
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
            const checked = expectations
              .filter((item) => item.traceID === id)
              .map((item) =>
                inspectIdentityTraceTopology(trace, item, secrets),
              );
            const warnings = [
              ...(trace.warnings ?? []),
              ...trace.spans.flatMap((span) => span.warnings ?? []),
            ];
            const errors = trace.spans.filter(hasError).length;
            const current = JSON.stringify(
              trace.spans.map((span) => span.spanID).sort(),
            );
            stable = current === previous ? stable + 1 : 1;
            previous = current;
            if (stable >= 3) {
              if (directory) {
                await mkdir(directory, { recursive: true });
                await writeFile(
                  `${directory}/${id}.json`,
                  JSON.stringify(trace),
                  { mode: 0o600 },
                );
              }
              complete = checked.map((item) => ({
                ...item,
                warning_count: warnings.length,
                warnings: [...new Set(warnings)],
                error_spans: errors,
                strict_trace: warnings.length || errors ? "failed" : "passed",
              }));
              break;
            }
            lastError = new Error("Identity trace export did not converge");
          } catch (error) {
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
      if (attempt + 1 < attempts) await wait(1000);
    }
    assert(complete, lastError?.message ?? "Identity trace not exported");
    result.push(...complete);
  }
  return result;
}
