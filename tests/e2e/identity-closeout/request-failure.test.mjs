import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  responseFailure,
  createRequestFailureRecorder,
} from "./request-failure.mjs";

const traceID = "a".repeat(32);
for (const code of ["console_unavailable", "dependency_unavailable"])
  test(`directory 503 retains ${code}`, () => {
    const body = JSON.stringify({ code, message: "private-body" });
    const response = new Response(body, { status: 503 });
    assert.equal(responseFailure(response, body, 200).response_code, code);
  });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-request-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const read = (file) =>
    JSON.parse(readFileSync(join(directory, file), "utf8"));
  return { directory, read };
}
for (const [name, value] of [
  ["unknown code", '{"code":"private-token","message":"secret"}'],
  ["malformed JSON", "private-body"],
])
  test(`response failure drops ${name} and invalid Trace IDs`, () => {
    const response = new Response(value, {
      status: 503,
      headers: {
        "x-antnest-trace-id": "private-token",
        "set-cookie": "credential=secret",
      },
    });
    assert.deepEqual(responseFailure(response, value, 200), {
      http_status: 503,
      expected_status: 200,
    });
  });
test("response failure keeps only recognized code and actual Trace ID", () => {
  const body =
    '{"code":"credential_busy","retryable":true,"message":"private-body"}';
  const response = new Response(body, {
    status: 503,
    headers: { "x-antnest-trace-id": traceID },
  });
  assert.deepEqual(responseFailure(response, body, [200, 204]), {
    http_status: 503,
    expected_status: [200, 204],
    trace_id: traceID,
    response_code: "credential_busy",
  });
});
test("failure recorder persists response before collecting its actual raw closure", async (t) => {
  const f = fixture(t),
    failure = {
      http_status: 503,
      expected_status: 200,
      trace_id: traceID,
      response_code: "identity_unavailable",
    };
  let called = 0;
  const record = createRequestFailureRecorder({
    directory: f.directory,
    jaeger: "http://jaeger",
    secrets: ["secret"],
    collect: async (base, expected, secrets, options) => {
      called++;
      assert.deepEqual(f.read("request-failure.json"), failure);
      assert.equal(base, "http://jaeger");
      assert.deepEqual(expected, [{ traceID }]);
      assert.deepEqual(secrets, ["secret"]);
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.attempts, 20);
      assert.equal(
        options.directory,
        join(f.directory, "request-failure-traces"),
      );
      assert.deepEqual(options.inspect({ traceID }), {
        trace_id: traceID,
        evidence_kind: "failure_diagnostic_not_admission",
      });
      return [{ trace_id: traceID, strict_trace: "failed", error_spans: 2 }];
    },
  });
  await record(failure);
  assert.equal(called, 1);
  assert.equal(f.read("request-failure-trace.json").status, "collected");
  assert.equal(
    f.read("request-failure-trace.json").reports[0].strict_trace,
    "failed",
  );
  assert.equal(
    statSync(join(f.directory, "request-failure.json")).mode & 0o777,
    0o600,
  );
});
test("failure recorder preserves response when raw collection fails", async (t) => {
  const f = fixture(t),
    failure = { http_status: 503, expected_status: 200, trace_id: traceID };
  const record = createRequestFailureRecorder({
    directory: f.directory,
    jaeger: "http://jaeger",
    secrets: [],
    collect: async () => {
      throw new Error("private-upstream-body");
    },
  });
  await record(failure);
  assert.deepEqual(f.read("request-failure.json"), failure);
  const result = f.read("request-failure-trace.json");
  assert.equal(result.status, "collection_failed");
  assert(!JSON.stringify(result).includes("private-upstream-body"));
});
test("failure recorder never invents a Trace ID when absent", async (t) => {
  const f = fixture(t);
  const record = createRequestFailureRecorder({
    directory: f.directory,
    jaeger: "http://jaeger",
    secrets: [],
    collect: async () => assert.fail("must not collect"),
  });
  await record({ http_status: 503, expected_status: 200 });
  assert.equal(f.read("request-failure-trace.json").status, "trace_id_missing");
});
