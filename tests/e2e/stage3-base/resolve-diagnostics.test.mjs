import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  clockWarningsOnly,
  collectLifecycleAdmissionTrace,
  inspectLifecycle,
  reviewedFencedRestartOnly,
} from "./trace.mjs";
import {
  attachAdmission,
  lifecycleResolutionFixture,
} from "./resolve-fixtures.mjs";
import { serializationRetryFixture } from "./trace-fixtures.mjs";
import {
  setTag,
  triggerID,
} from "../observability/gateway-resolution-fixtures.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";

const clock =
  "clock skew adjustment disabled; not applying calculated delta of 1µs";

function preparation(source = "cache") {
  const f = lifecycleResolutionFixture("create", source);
  f.expected.skillPreparation = true;
  const success = f.trace.spans.find(
    (span) => span.operationName === "RunActivity:admit_agent",
  );
  for (const [index, state] of ["queued", "preparing"].entries()) {
    const retry = structuredClone(success);
    retry.spanID = `preparation-${state}`;
    retry.startTime = success.startTime - 4 + index * 2;
    retry.duration = 1;
    for (const [key, value] of Object.entries({
      "span.kind": "server",
      "otel.status_code": "ERROR",
      error: true,
      "otel.status_description": `dependency unavailable: Skill preparation ${state}`,
    }))
      setTag(retry, key, value);
    f.trace.spans.push(retry);
  }
  return f;
}

async function collect(t, f) {
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "lifecycle-diagnostics-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = JSON.stringify([...f.traces.values()]);
  const result = await collectLifecycleAdmissionTrace(
    "http://jaeger",
    f.expected,
    ["PRIVATE"],
    {
      directory,
      attempts: 3,
      request: async (url) =>
        Response.json({
          data: [f.traces.get(new URL(url).pathname.split("/").at(-1))],
        }),
      wait: async () => {},
      inspect: f.inspect ?? inspectLifecycle,
    },
  );
  assert.equal(JSON.stringify([...f.traces.values()]), before);
  for (const [id, trace] of f.traces)
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8")),
      trace,
    );
  return result;
}

for (const source of ["cache", "rpc", "shared"])
  for (const warning of [false, true])
    test(`collected ${source} Skill retries retain raw errors and scoped admission (clock=${warning})`, async (t) => {
      const f = preparation(source);
      if (warning) f.trace.warnings = [clock];
      const result = await collect(t, f);
      assert.equal(result.error_spans, 2);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.resolve_source_error_spans, 0);
      assert.equal(result.skill_preparation_retries, 2);
      assert.equal(clockWarningsOnly([result]), true);
      assert.deepEqual(result.lifecycle_error_claims, [
        {
          trace_id: f.trace.traceID,
          span_id: "preparation-queued",
          reason: "skill-preparation-retry",
        },
        {
          trace_id: f.trace.traceID,
          span_id: "preparation-preparing",
          reason: "skill-preparation-retry",
        },
      ]);
    });

for (const failedCommit of [false, true])
  test(`serialization evidence counts actual ERROR spans, not transactions (commit=${failedCommit})`, async (t) => {
    const f = attachAdmission(
      serializationRetryFixture({ failedCommit }),
      "cache",
      "client-console",
    );
    const result = await collect(t, f);
    assert.equal(result.serialization_retries, 1);
    assert.equal(result.error_spans, failedCommit ? 2 : 1);
    assert.equal(result.lifecycle_error_claims.length, result.error_spans);
    assert(
      result.lifecycle_error_claims.every(
        (claim) => claim.reason === "serialization-retry",
      ),
    );
    assert.equal(result.strict_trace, "failed");
    assert.equal(clockWarningsOnly([result]), true);
  });

test("a source caller error cannot inherit current-trace preparation admission", async (t) => {
  const f = preparation("shared");
  setTag(f.traces.get(triggerID).spans[0], "error", true);
  const result = await collect(t, f);
  assert.equal(result.error_spans, 3);
  assert.equal(result.resolve_source_error_spans, 1);
  assert.equal(clockWarningsOnly([result]), false);
});

for (const [name, change] of [
  ["undeclared preparation", (f) => delete f.expected.skillPreparation],
  [
    "unrelated current error",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.spanID === "business-console"),
        "error",
        true,
      ),
  ],
  [
    "no successful retry",
    (f) =>
      setTag(
        f.trace.spans.find(
          (s) =>
            s.operationName === "RunActivity:admit_agent" &&
            s.spanID !== "preparation-queued" &&
            s.spanID !== "preparation-preparing",
        ),
        "error",
        true,
      ),
  ],
])
  test(`collection still rejects ${name}`, async (t) => {
    const f = preparation();
    change(f);
    await assert.rejects(collect(t, f));
  });

for (const [name, change] of [
  [
    "foreign trace",
    (claims) => {
      claims[0].trace_id = "f".repeat(32);
    },
  ],
  [
    "foreign span",
    (claims) => {
      claims[0].span_id = "not-an-error";
    },
  ],
  [
    "duplicate claim",
    (claims) => {
      claims.push(structuredClone(claims[0]));
    },
  ],
  [
    "unknown reason",
    (claims) => {
      claims[0].reason = "unrelated-error";
    },
  ],
])
  test(`collector rejects ${name} in owning error claims`, async (t) => {
    const f = preparation();
    f.inspect = (...args) => {
      const result = inspectLifecycle(...args);
      result.lifecycle_error_claims ??= [
        {
          trace_id: f.trace.traceID,
          span_id: "preparation-queued",
          reason: "skill-preparation-retry",
        },
        {
          trace_id: f.trace.traceID,
          span_id: "preparation-preparing",
          reason: "skill-preparation-retry",
        },
      ];
      change(result.lifecycle_error_claims);
      return result;
    };
    await assert.rejects(collect(t, f));
  });

test("raw current errors missing from the verified claims remain rejected", async (t) => {
  const f = preparation();
  const result = await collect(t, f);
  result.lifecycle_error_claims =
    result.lifecycle_error_claims?.slice(0, 1) ?? [];
  assert.equal(clockWarningsOnly([result]), false);
});

test("one fenced restart can include independently verified preparation errors", () => {
  const trace_id = "a".repeat(32);
  const restart = {
    trace_id,
    kind: "rebuild",
    fenced_restart_cancellation: true,
    strict_trace: "failed",
    inspector_diagnostics: {
      strict_trace: "failed",
      warning_count: 0,
      warnings: [],
    },
    restart_error_spans: 2,
    platform_probe_errors: 0,
    resolve_source_error_spans: 0,
    error_spans: 3,
    warning_count: 0,
    warnings: [],
    lifecycle_error_span_ids: ["cancel-activity", "cancel-client", "prepare"],
    lifecycle_error_claims: [
      { trace_id, span_id: "cancel-activity", reason: "lifecycle-restart" },
      { trace_id, span_id: "cancel-client", reason: "lifecycle-restart" },
      { trace_id, span_id: "prepare", reason: "skill-preparation-retry" },
    ],
  };
  assert.equal(
    reviewedFencedRestartOnly([restart, { strict_trace: "passed" }]),
    true,
  );
  assert.equal(clockWarningsOnly([restart]), false);
  assert.equal(reviewedFencedRestartOnly([restart, restart]), false);
  for (const altered of [
    { ...restart, resolve_source_error_spans: 1, error_spans: 4 },
    { ...restart, error_spans: 4 },
    {
      ...restart,
      lifecycle_error_claims: restart.lifecycle_error_claims.slice(0, 2),
    },
    { ...restart, platform_probe_errors: 1 },
    { ...restart, warnings: ["unreviewed warning"], warning_count: 1 },
    { ...restart, fenced_restart_cancellation: false },
  ])
    assert.equal(reviewedFencedRestartOnly([altered]), false);
});
