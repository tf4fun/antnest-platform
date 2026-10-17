import assert from "node:assert/strict";
import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { permissionConfigurationFixture } from "./configuration-trace.fixture.mjs";
import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { completePermissionRuntimeFixture } from "./trace.fixture.mjs";
const url = new URL("./collector.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
for (const version of [1, 2])
  for (const [name, create] of [
    ["initialize", () => costControlTraceFixture({ version })],
    [
      "foreign denial",
      () => costControlTraceFixture({ version, method: "session/new" }),
    ],
    ["new", () => costSessionTraceFixture({ version })],
    [
      "replay",
      () =>
        costSessionTraceFixture({
          version,
          method: version === 1 ? "session/load" : "session/resume",
        }),
    ],
    ["mode", () => permissionConfigurationFixture({ version })],
    [
      "model",
      () =>
        permissionConfigurationFixture({
          version,
          configId: "model",
          value: "profile:alternate",
        }),
    ],
  ])
    test(`private v${version} Permissions ${name} checks its complete owning contract`, () => {
      assert.equal(
        typeof implementation.inspectPrivatePermissionTrace,
        "function",
      );
      const f = create();
      const original = structuredClone(f.trace);
      const report = implementation.inspectPrivatePermissionTrace(
        f.trace,
        f.expected,
        [],
        [],
      );
      assert.equal(report.trace_id, f.trace.traceID);
      assert.deepEqual(f.trace, original);
      assert.throws(() =>
        implementation.inspectPrivatePermissionTrace(
          f.trace,
          f.expected,
          [],
          [{ trace_id: f.trace.traceID }],
        ),
      );
      assert.throws(() =>
        implementation.inspectPrivatePermissionTrace(
          f.trace,
          { ...f.expected, kind: "unknown" },
          [],
          [],
        ),
      );
    });

for (const broken of [false, true])
  test(`private Permissions collector ${broken ? "rejects a missing SQL parent" : "archives three complete stable samples"}`, async (t) => {
    assert.equal(
      typeof implementation.collectPrivatePermissionTrace,
      "function",
    );
    const directory = mkdtempSync(
      join(tmpdir(), "antnest-permission-collector-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = permissionConfigurationFixture();
    const ids = new Map(
      f.trace.spans.map((span, index) => [
        span.spanID,
        (index + 1).toString(16).padStart(16, "0"),
      ]),
    );
    for (const span of f.trace.spans) {
      span.spanID = ids.get(span.spanID);
      for (const ref of span.references)
        if (ref.traceID === f.trace.traceID) ref.spanID = ids.get(ref.spanID);
    }
    const expected = { ...f.expected };
    delete expected.connectionTrace;
    delete expected.connectionSpanID;
    if (broken)
      f.trace.spans = f.trace.spans.filter(
        (span) => span.operationName !== "postgresql transaction",
      );
    let flushed = false;
    const operation = implementation.collectPrivatePermissionTrace(
      "http://jaeger.test:16686",
      expected,
      {
        directory,
        attempts: 3,
        wait: async () => {},
        requests: [],
        flush: async () => {
          flushed = true;
        },
        request: async (address) => {
          assert(flushed);
          if (new URL(address).pathname === "/api/v3/trace-summaries")
            return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
          return Response.json({
            data: [
              new URL(address).pathname.endsWith(f.expected.connectionTraceID)
                ? f.expected.connectionTrace
                : f.trace,
            ],
          });
        },
      },
    );
    if (broken) await assert.rejects(operation);
    else {
      const result = await operation;
      assert.equal(result.complete_source_receipt.stable_samples, 3);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert.equal(
        implementation.privatePermissionStrictOutcome([result]).accepted,
        true,
      );
      const manifest = JSON.parse(
        readFileSync(join(result.evidence_directory, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.queries.length, 9);
      for (const query of manifest.queries)
        assert.equal(query.body_complete, true);
    }
    assert.equal(readdirSync(directory).length, 1);
  });

for (const [phase, broken] of [
  ["v1-reconnect", false],
  ["v2-judge-ask", false],
  ["v2-judge-ask", true],
])
  test(`${phase}: collector ${broken ? "rejects missing Runtime work" : "retains original Runtime cleanup and strict result"}`, async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "antnest-permission-runtime-collector-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const f = completePermissionRuntimeFixture(phase, {
      refresh: phase.startsWith("v1"),
      cleanup: true,
    });
    const ids = new Map(
      f.trace.spans.map((span, index) => [
        span.spanID,
        (index + 1).toString(16).padStart(16, "0"),
      ]),
    );
    for (const span of f.trace.spans) {
      span.spanID = ids.get(span.spanID);
      for (const ref of span.references)
        if (ref.traceID === f.trace.traceID && ids.has(ref.spanID))
          ref.spanID = ids.get(ref.spanID);
      for (const entry of span.logs ?? [])
        for (const field of entry.fields)
          if (field.key === "span_id") field.value = span.spanID;
    }
    for (const request of f.requests)
      request.model_span_id = ids.get(request.model_span_id);
    const expected = { ...f.expected };
    delete expected.connectionTrace;
    delete expected.connectionSpanID;
    if (broken) f.trace.spans = f.trace.spans.filter((span) => span !== f.work);
    const original = structuredClone(f.trace);
    const operation = implementation.collectPrivatePermissionTrace(
      "http://jaeger.test:16686",
      expected,
      {
        directory,
        attempts: 3,
        wait: async () => {},
        requests: f.requests,
        flush: async () => {},
        request: async (address) => {
          const url = new URL(address);
          if (url.pathname === "/api/v3/trace-summaries")
            return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
          return Response.json({
            data: [
              url.pathname.endsWith(expected.connectionTraceID)
                ? f.expected.connectionTrace
                : f.trace,
            ],
          });
        },
      },
    );
    if (broken) await assert.rejects(operation);
    else {
      const result = await operation;
      assert.equal(result.complete_source_receipt.stable_samples, 3);
      assert.equal(result.diagnostic_inventory_verified, true);
      assert(result.error_spans > 0);
      assert.equal(result.raw_error_inventory.length, result.error_spans);
      const strict = implementation.privatePermissionStrictOutcome([result]);
      assert.equal(strict.accepted, true);
      assert.equal(strict.strict_trace, "failed");
      assert.equal(strict.exit_code, 2);
      const manifest = JSON.parse(
        readFileSync(join(result.evidence_directory, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.status, "collected");
      assert.equal(manifest.queries.length, 9);
    }
    assert.deepEqual(f.trace, original);
  });
