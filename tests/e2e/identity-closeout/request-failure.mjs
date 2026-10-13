import { join } from "node:path";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";

const codes = new Set([
  "identity_unavailable",
  "console_unavailable",
  "dependency_unavailable",
  "credential_busy",
  "credential_rate_limited",
  "unauthenticated",
  "forbidden",
  "invalid_request",
  "csrf_failed",
  "caller_context_invalid",
  "upstream_unavailable",
]);

export function responseFailure(response, text, expected) {
  const result = { http_status: response.status, expected_status: expected };
  const id = response.headers.get("x-antnest-trace-id");
  if (/^[a-f0-9]{32}$/u.test(id ?? "") && !/^0+$/u.test(id))
    result.trace_id = id;
  try {
    const code = JSON.parse(text)?.code;
    if (codes.has(code)) result.response_code = code;
  } catch {}
  return result;
}

export function createRequestFailureRecorder({
  directory,
  jaeger,
  secrets,
  collect = collectResolveTraceEvidence,
}) {
  directory = evidenceDirectory(directory);
  return async (failure) => {
    writeEvidenceFile(
      directory,
      "request-failure.json",
      JSON.stringify(failure),
    );
    let result = { status: "trace_id_missing" };
    if (failure.trace_id) {
      try {
        const reports = await collect(
          jaeger,
          [{ traceID: failure.trace_id }],
          secrets,
          {
            directory: join(directory, "request-failure-traces"),
            attempts: 20,
            signal: AbortSignal.timeout(20000),
            inspect: (trace) => ({
              trace_id: trace.traceID,
              evidence_kind: "failure_diagnostic_not_admission",
            }),
          },
        );
        result = { status: "collected", reports };
      } catch (error) {
        result = {
          status: "collection_failed",
          failure: summarizeFailure(error),
        };
      }
    }
    writeEvidenceFile(
      directory,
      "request-failure-trace.json",
      JSON.stringify(result),
    );
  };
}
