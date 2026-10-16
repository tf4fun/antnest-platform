import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateBoundaryFixture } from "./private-boundary.fixture.mjs";
import { privatePlanRequestFixture } from "./private-request.fixture.mjs";
import { executionFixture, requestFixture } from "./trace-fixture.mjs";
import { phases } from "./model.mjs";
import { verdict } from "../../support/ci-shard.mjs";

const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
async function collect(...args) {
  assert.equal(typeof implementation.collectPrivatePlanTrace, "function");
  return implementation.collectPrivatePlanTrace(...args);
}
function outcome(results) {
  assert.equal(typeof implementation.privatePlanStrictOutcome, "function");
  return implementation.privatePlanStrictOutcome(results);
}
const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clockWarning =
  "clock skew adjustment disabled; not applying calculated delta of 2ms";

function fixture(
  t,
  {
    version = 1,
    phase = "execute",
    method,
    denial,
    catalog,
    mutate = () => {},
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-plan-collector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = method
    ? privatePlanRequestFixture({ version, method, denial, catalog })
    : privateBoundaryFixture(executionFixture(`v${version}-${phase}`), {
        version,
      });
  const expected = { ...f.expected };
  delete expected.connectionSpanID;
  delete expected.connectionTrace;
  let attempts = 0,
    flushed = false;
  const queries = [];
  const request = async (address, options) => {
    assert(flushed, "actual CLIENT must be exported before collection");
    assert(options.signal instanceof AbortSignal);
    const addressURL = new URL(address);
    queries.push(addressURL);
    if (addressURL.pathname === `/api/traces/${f.connectionTrace.traceID}`)
      attempts++;
    const state = {
      connection: structuredClone(f.connectionTrace),
      trace: structuredClone(f.trace),
    };
    mutate(state, attempts);
    if (addressURL.pathname === `/api/traces/${f.connectionTrace.traceID}`)
      return Response.json({ data: [state.connection] });
    if (addressURL.pathname === "/api/v3/trace-summaries")
      return Response.json({
        summaries: state.missing ? [] : [{ traceId: state.trace.traceID }],
        ...(state.page ? { nextPageToken: "next" } : {}),
      });
    assert.equal(addressURL.pathname, `/api/traces/${f.trace.traceID}`);
    return Response.json({ data: [state.trace] });
  };
  return {
    ...f,
    expected,
    directory,
    queries,
    get attempts() {
      return attempts;
    },
    options: {
      directory,
      request,
      flush: async () => {
        flushed = true;
      },
      wait: async () => {},
      attempts: 5,
      requests: f.requests ?? [],
      secrets: ["PRIVATE-PLAN-CANARY"],
    },
  };
}

test("Plan raw collector preserves 12 private Runs, 22 variable-stage model calls and two writes", async (t) => {
  const totals = { runs: 0, models: 0, writes: 0 };
  for (const version of [1, 2])
    for (const phase of phases) {
      const f = fixture(t, { version, phase: phase.id });
      const original = structuredClone([f.trace, f.connectionTrace]);
      const result = await collect("http://jaeger", f.expected, f.options);
      assert.equal(f.attempts, 3);
      assert.equal(result.trace_id, f.trace.traceID);
      assert.equal(
        result.connection_span_id,
        f.connectionTrace.spans[1].spanID,
      );
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.deepEqual(result.raw_error_inventory, []);
      assert.equal(outcome([result]).exit_code, 0);
      assert.deepEqual([f.trace, f.connectionTrace], original);
      const manifest = parse(join(result.evidence_directory, "manifest.json"));
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.queries.length, 9);
      assert.equal(statSync(result.evidence_directory).mode & 0o777, 0o700);
      for (const query of manifest.queries) {
        const path = join(result.evidence_directory, query.file);
        const bytes = readFileSync(path);
        assert.equal(query.body_complete, true);
        assert.equal(query.bytes, bytes.length);
        assert.equal(query.sha256, hash(bytes));
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
      totals.runs++;
      totals.models += result.model_requests;
      totals.writes += result.runtime_tool_calls;
    }
  assert.deepEqual(totals, { runs: 12, models: 22, writes: 2 });
});

for (const version of [1, 2])
  for (const method of [
    "session/new",
    "session/load",
    "session/resume",
    "session/fork",
  ])
    for (const denied of [false, true])
      test(`Plan collector keeps v${version} ${method} ${denied ? "denial" : "success"} and exact raw diagnostics`, async (t) => {
        const f = fixture(t, {
          version,
          method,
          ...(denied
            ? {
                denial:
                  method === "session/new"
                    ? "access_denied"
                    : "session_access_denied",
              }
            : {}),
        });
        const result = await collect("http://jaeger", f.expected, f.options);
        assert.equal(result.no_execution, true);
        assert.equal(result.input_session_id, f.expected.inputSessionID);
        assert.equal(result.session_id, f.expected.sessionId);
        assert.equal(result.error_spans, denied ? 2 : 0);
        assert.equal(result.raw_error_inventory.length, denied ? 2 : 0);
        assert.equal(result.owned_error_spans.length, denied ? 2 : 0);
        assert.equal(outcome([result]).exit_code, denied ? 2 : 0);
        assert.equal(result.strict_trace, denied ? "failed" : "passed");
        if (denied)
          assert(
            result.owned_error_spans.every(
              (item) => item.reason === "plan-rejection",
            ),
          );
      });

test("Plan collector also owns each real initialize request without a Session", async (t) => {
  const f = fixture(t, { method: "session/load" });
  const initial = privateBoundaryFixture(requestFixture("initialize"));
  initial.request.tags = initial.request.tags.filter(
    (field) => field.key !== "antnest.session.id",
  );
  delete initial.expected.sessionId;
  Object.assign(f.trace, initial.trace);
  Object.assign(f.expected, { method: "initialize", inputSessionID: null });
  delete f.expected.sessionId;
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(result.method, "initialize");
  assert.equal(result.input_session_id, null);
  assert.equal(result.no_execution, true);
});

test("Plan collector retains original Runtime read cancellation and never rewrites strict status", async (t) => {
  const f = fixture(t, {
    method: "session/load",
    catalog: { runtimeOutcome: "canceled", clientOutcome: "cancelled" },
  });
  const original = structuredClone(f.trace);
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(result.neutral_diagnostics.length, 2);
  assert.equal(result.error_spans, 1);
  assert.equal(result.owned_error_spans.length, 1);
  assert.equal(result.strict_trace, "failed");
  assert.equal(outcome([result]).exit_code, 2);
  assert.deepEqual(
    parse(join(result.evidence_directory, "request.json")),
    original,
  );
});

for (const [label, mutate] of [
  [
    "foreign model Trace",
    (f) => {
      f.options.requests[0].trace_id = "9".repeat(32);
    },
  ],
  [
    "missing model stage",
    (f) => {
      f.options.requests.pop();
    },
  ],
  [
    "extra model stage",
    (f) => {
      f.options.requests.push({ ...f.options.requests[0], stage: 99 });
    },
  ],
  [
    "different request ID",
    (f) => {
      f.expected.requestId = "different";
    },
  ],
  [
    "caller-supplied upgrade",
    (f) => {
      f.expected.connectionTrace = f.connectionTrace;
    },
  ],
  [
    "HTTP instead of owned WS",
    (f) => {
      f.expected.transport = "http";
    },
  ],
])
  test(`Plan collection rejects ${label}`, async (t) => {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(collect("http://jaeger", f.expected, f.options));
  });

for (const [label, mutate] of [
  [
    "unowned numeric error",
    (state) =>
      state.trace.spans[0].tags.push({ key: "otel.status_code", value: 2 }),
  ],
  [
    "missing raw request",
    (state) => {
      state.missing = true;
    },
  ],
  [
    "incomplete query inventory",
    (state) => {
      state.page = true;
    },
  ],
  [
    "nonstable raw",
    (state, attempt) => {
      state.trace.warnings = [`raw changed ${attempt}`];
    },
  ],
])
  test(`Plan collection refuses ${label} and preserves failure evidence`, async (t) => {
    const f = fixture(t, { mutate });
    await assert.rejects(collect("http://jaeger", f.expected, f.options));
    const [archive] = readdirSync(f.directory);
    assert(archive);
    const manifest = parse(join(f.directory, archive, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert(manifest.queries.length > 0);
  });

test("Plan raw collector keeps incomplete response bytes and fails closed", async (t) => {
  const f = fixture(t);
  const partial = Buffer.from('{"data":["PARTIAL-PLAN');
  f.options.request = async () => {
    let chunks = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks++ === 0) controller.enqueue(partial);
          else controller.error(new Error("PRIVATE-PLAN-CANARY"));
        },
      }),
    );
  };
  await assert.rejects(
    collect("http://jaeger", f.expected, f.options),
    (error) => !error.message.includes("PRIVATE-PLAN-CANARY"),
  );
  const [archive] = readdirSync(f.directory);
  const path = join(f.directory, archive);
  const manifest = parse(join(path, "manifest.json"));
  assert.equal(manifest.status, "failed");
  for (const query of manifest.queries) {
    assert.equal(query.body_complete, false);
    assert.deepEqual(readFileSync(join(path, query.file)), partial);
    assert.equal(query.sha256, hash(partial));
  }
});

test("Plan late raw clock warnings reset stability and retain the strict exit 2", async (t) => {
  const f = fixture(t, {
    mutate: (state, attempt) => {
      if (attempt > 1) state.connection.spans[1].warnings = [clockWarning];
    },
  });
  const result = await collect("http://jaeger", f.expected, f.options);
  assert.equal(f.attempts, 4);
  assert.equal(result.warning_count, 1);
  assert.deepEqual(result.warnings, [clockWarning]);
  const strict = outcome([result]);
  assert.equal(strict.exit_code, 2);
  const log = JSON.stringify({
    status: "business_passed",
    scenarios: 12,
    ...strict,
    traces: [result],
  });
  assert.equal(verdict(2, log, true), "warning");
  assert.equal(verdict(2, log, false), "failed");
});

test("Plan outcome rejects missing, duplicated, foreign and rewritten error inventories", async (t) => {
  const f = fixture(t, {
    method: "session/load",
    denial: "session_access_denied",
  });
  const result = await collect("http://jaeger", f.expected, f.options);
  for (const mutate of [
    (r) => {
      r.owned_error_spans.pop();
    },
    (r) => {
      r.owned_error_spans.push({ ...r.owned_error_spans[0] });
    },
    (r) => {
      r.raw_error_inventory.pop();
    },
    (r) => {
      r.owned_error_spans[0].reason = "private-http-sse-close";
    },
    (r) => {
      r.owned_error_spans[0].reason = "command-rejection";
    },
    (r) => {
      r.diagnostic_inventory_verified = false;
    },
    (r) => {
      r.strict_trace = "passed";
    },
    (r) => {
      r.error_spans = 0;
    },
    (r) => {
      r.warnings = ["unknown warning"];
      r.warning_count = 1;
    },
  ]) {
    const changed = structuredClone(result);
    mutate(changed);
    assert.deepEqual(outcome([changed]), {
      strict_trace: "failed",
      accepted: false,
      exit_code: 1,
    });
  }
  assert.equal(outcome([]).exit_code, 1);
});
