import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeTraceFixture } from "./private-trace.fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const collect = (...args) => {
  assert.equal(typeof implementation.collectPrivateNativeTrace, "function");
  return implementation.collectPrivateNativeTrace(...args);
};
const outcome = (results) => {
  assert.equal(typeof implementation.privateNativeStrictOutcome, "function");
  return implementation.privateNativeStrictOutcome(results);
};
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));

function fixture(t, options = {}) {
  const f = options.initialize
    ? privateBoundaryFixture(requestFixture("initialize"), {
        version: options.version ?? 1,
      })
    : nativeTraceFixture(options);
  if (options.initialize) {
    delete f.expected.sessionId;
    f.expected.kind = "request";
    f.expected.inputSessionID = null;
    f.trace.spans.find((span) => span.spanID === "request").tags = f.trace.spans
      .find((span) => span.spanID === "request")
      .tags.filter(({ key }) => key !== "antnest.session.id");
  }
  const directory = mkdtempSync(join(tmpdir(), "antnest-native-collector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected };
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  let flushed = false,
    attempts = 0;
  return {
    ...f,
    expected,
    directory,
    get attempts() {
      return attempts;
    },
    options: {
      directory,
      attempts: 4,
      wait: async () => {},
      flush: async () => {
        flushed = true;
      },
      requests: f.requests ?? [],
      secrets: ["PRIVATE_NATIVE_CANARY"],
      request: async (address, { signal }) => {
        assert(flushed);
        assert(signal instanceof AbortSignal);
        const path = new URL(address).pathname;
        if (path === `/api/traces/${f.connectionTrace.traceID}`) {
          attempts++;
          return Response.json({ data: [f.connectionTrace] });
        }
        if (path === "/api/v3/trace-summaries")
          return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
        assert.equal(path, `/api/traces/${f.trace.traceID}`);
        return Response.json({ data: [f.trace] });
      },
    },
  };
}

for (const version of [1, 2])
  for (const failed of [false, true])
    test(`native collector preserves original v${version} ${failed ? "failed" : "completed"} Run and raw strict status`, async (t) => {
      const f = fixture(t, { version, failed });
      const original = structuredClone([f.trace, f.connectionTrace]);
      const result = await collect("http://jaeger", f.expected, f.options);
      assert.equal(f.attempts, 3);
      assert.equal(result.runs, 1);
      assert.equal(result.provider_requests, failed ? 0 : 1);
      assert.equal(result.error_spans, failed ? (version === 1 ? 3 : 2) : 0);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(outcome([result]).exit_code, failed ? 2 : 0);
      assert(
        result.owned_error_spans.every(
          (claim) => claim.reason === "multimodal-model-unsupported-content",
        ),
      );
      assert.deepEqual([f.trace, f.connectionTrace], original);
      const manifest = parse(join(result.evidence_directory, "manifest.json"));
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.queries.length, 9);
      assert.equal(statSync(result.evidence_directory).mode & 0o777, 0o700);
      for (const query of manifest.queries) {
        const path = join(result.evidence_directory, query.file),
          bytes = readFileSync(path);
        assert.equal(query.body_complete, true);
        assert.equal(query.bytes, bytes.length);
        assert.equal(
          query.sha256,
          createHash("sha256").update(bytes).digest("hex"),
        );
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      assert.deepEqual(
        parse(join(result.evidence_directory, "request.json")),
        f.trace,
      );
      assert.deepEqual(
        parse(join(result.evidence_directory, "connection.json")),
        f.connectionTrace,
      );
    });

for (const version of [1, 2])
  test(`native collector separately retains v${version} initialize without a Session or model call`, async (t) => {
    const f = fixture(t, { version, initialize: true });
    const result = await collect("http://jaeger", f.expected, f.options);
    assert.equal(result.method, "initialize");
    assert.equal(result.no_execution, true);
    assert.equal(result.input_session_id, null);
    assert.equal(outcome([result]).exit_code, 0);
  });

for (const [label, mutate] of [
  [
    "foreign Provider Trace with original phase",
    (f) => {
      f.options.requests[0].trace_id = "foreign";
    },
  ],
  [
    "wrong Provider phase on original Trace",
    (f) => {
      f.options.requests[0].phase = "foreign";
    },
  ],
  [
    "missing Provider phase on original Trace",
    (f) => {
      delete f.options.requests[0].phase;
    },
  ],
  [
    "extra Provider call",
    (f) => {
      f.options.requests.push({ ...f.options.requests[0] });
    },
  ],
  [
    "unowned model error",
    (f) => {
      f.set(f.model, "error.type", "Unexpected");
    },
  ],
  [
    "raw payload capture",
    (f) => {
      f.set(f.model, "antnest.payload.json", "{}");
    },
  ],
])
  test(`native collector cannot hide ${label}`, async (t) => {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(async () =>
      collect("http://jaeger", f.expected, f.options),
    );
  });

test("failed native Run cannot hide a Provider request behind another phase", async (t) => {
  const f = fixture(t, { failed: true });
  f.options.requests.push({
    phase: "foreign",
    trace_id: f.trace.traceID,
    model_span_id: "foreign",
  });
  await assert.rejects(async () =>
    collect("http://jaeger", f.expected, f.options),
  );
});

test("native collection options cannot replace the owning inspector or diagnostic reasons", async (t) => {
  const f = fixture(t);
  f.set(f.model, "error.type", "Unexpected");
  await assert.rejects(async () =>
    collect("http://jaeger", f.expected, {
      ...f.options,
      inspect: () => ({ trace_id: f.trace.traceID }),
      ownedReasons: new Set(["anything"]),
    }),
  );
});

test("native strict outcome keeps actual warnings but rejects forged counts and borrowed reasons", async (t) => {
  const f = fixture(t, { failed: true });
  f.model.warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 2ms",
  ];
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(outcome([result]).exit_code, 2);
  assert.equal(outcome([result]).clock_warnings_accepted, true);
  assert.equal(outcome([{ ...result, error_spans: 0 }]).exit_code, 1);
  assert.equal(
    outcome([
      {
        ...result,
        owned_error_spans: result.owned_error_spans.map((item) => ({
          ...item,
          reason: "files-rejection",
        })),
      },
    ]).exit_code,
    1,
  );
});
