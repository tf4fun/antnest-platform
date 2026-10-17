import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { costPricingFixture } from "./pricing-collector.fixture.mjs";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { collectPrivateCostTrace } from "./collector.mjs";
import {
  collectCostPricingTrace,
  costStrictOutcome,
} from "./pricing-collector.mjs";
import { collectObservabilityResolution } from "../observability/resolve-evidence.mjs";
import {
  setTag,
  sourceID,
} from "../observability/gateway-resolution-fixtures.mjs";

const warning =
  "clock skew adjustment disabled; not applying calculated delta of -517.433µs";
const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (directory, name) =>
  JSON.parse(readFileSync(join(directory, name)));
const collect = (f) =>
  collectCostPricingTrace("http://jaeger", f.expected, f.options);
const acp = (t) => {
  const f = costCollectorFixture(t, costSessionTraceFixture());
  return collectPrivateCostTrace("http://jaeger", f.expected, f.options);
};

function fixture(t, source = "shared-background") {
  const f = costPricingFixture(t, source);
  f.trace.processes.acp = {
    serviceName: "agent-acp-service",
    tags: fields({
      "host.name": "acp-host",
      "process.pid": 1,
      "service.instance.id": "acp-host:1",
      "process.runtime.name": "nodejs",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.language": "nodejs",
    }),
  };
  const client = {
    traceID: f.trace.traceID,
    spanID: "publication-client",
    processID: f.controller.processID,
    operationName: "HTTP POST agent-acp-service",
    startTime: f.controller.startTime + 10,
    duration: 1000,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.controller.spanID,
      },
    ],
    tags: fields({
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    }),
    logs: [],
  };
  const server = {
    ...structuredClone(client),
    spanID: "publication-server",
    processID: "acp",
    operationName: "HTTP POST /rpc/agent-acp/apply-execution-snapshot",
    duration: 1261,
    references: [
      { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: client.spanID },
    ],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.route": "/rpc/agent-acp/apply-execution-snapshot",
    }),
    warnings: [warning],
  };
  f.trace.spans.push(client, server);
  for (const index of [1, 2])
    f.trace.spans.push({
      ...structuredClone(server),
      spanID: `publication-sql-${index}`,
      operationName: "SELECT",
      startTime: server.startTime + index * 10,
      duration: 5,
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: server.spanID,
        },
      ],
      tags: fields({
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.query.text": "SELECT 1",
      }),
    });
  // Only controlled fixture IDs are normalized; archived production data is never changed.
  const id = (value) => hash(value).slice(0, 16);
  for (const trace of f.traces.values())
    for (const span of trace.spans) {
      span.spanID = id(span.spanID);
      for (const ref of span.references) ref.spanID = id(ref.spanID);
    }
  return { ...f, client, server };
}

for (const source of ["rpc", "cache", "shared", "shared-background"])
  test(`pricing ${source} SDK diagnostics retain exit 2 when ACP is clean`, async (t) => {
    const f = fixture(t, source);
    const before = structuredClone([...f.traces]);
    const result = await collect(f);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.warning_count, 3);
    assert.equal(result.error_spans, 0);
    assert.equal(
      result.pricing_warning_review.waived_external_sdk_warning_count,
      3,
    );
    const outcome = costStrictOutcome([await acp(t)], [result]);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.exit_code, 2);
    assert.equal(outcome.strict_trace, "failed");
    assert.equal(outcome.pricing_reviewed_warning_occurrences, 3);
    assert.deepEqual([...f.traces], before);
    assert.deepEqual(f.waits, [6000, 1000, 1000]);
    const proof = read(
      result.raw_evidence_directory,
      "pricing-warning-review.private.json",
    );
    assert.equal(proof.samples.length, 3);
    assert(
      proof.samples.every(
        (s) => s.policy.waived_external_sdk_warning_count === 3,
      ),
    );
    const manifest = read(
      result.raw_evidence_directory,
      "manifest.private.json",
    );
    assert.equal(manifest.outcome, "complete");
    for (const query of manifest.queries) {
      const bytes = readFileSync(
        join(result.raw_evidence_directory, query.file),
      );
      assert.equal(hash(bytes), query.sha256);
      assert.equal(bytes.length, query.bytes);
      assert.deepEqual(
        bytes,
        f.raw(new URL(query.url).pathname.split("/").at(-1)),
      );
    }
  });

for (const warned of [false, true])
  for (const location of ["main", "source"])
    test(`pricing preserves neutral empty error.type on ${location} with SDK warnings ${warned}`, async (t) => {
      const f = warned ? fixture(t) : costPricingFixture(t);
      const target =
        location === "main" ? f.controller : f.traces.get(sourceID).spans[0];
      setTag(target, "error.type", "");
      const before = structuredClone([...f.traces]);
      const result = await collect(f);
      assert.equal(result.error_spans, 0);
      assert.deepEqual(result.raw_error_inventory, []);
      assert.equal(result.strict_trace, warned ? "failed" : "passed");
      const outcome = costStrictOutcome([await acp(t)], [result]);
      assert.equal(outcome.accepted, true);
      assert.equal(outcome.exit_code, warned ? 2 : 0);
      assert.deepEqual([...f.traces], before);
    });

for (const [name, mutate] of [
  ["internal ACP error", (f) => setTag(f.server, "error", true)],
  [
    "source error",
    (f) => setTag(f.traces.get(sourceID).spans[0], "error", true),
  ],
  ["unknown warning", (f) => (f.server.warnings = ["unreviewed diagnostic"])],
  [
    "unknown SDK",
    (f) => setTag(f.trace.processes.acp, "telemetry.sdk.name", "unknown"),
  ],
  ["missing parent", (f) => (f.server.references[0].spanID = "f".repeat(16))],
  ["foreign parent", (f) => (f.server.references[0].traceID = "f".repeat(32))],
  ["unknown service", (f) => (f.server.processID = "unknown")],
  ["unfinished span", (f) => (f.server.duration = -1)],
  [
    "repeated HTTP method",
    (f) => (f.server.operationName = "HTTP POST POST /rpc"),
  ],
  [
    "captured header",
    (f) =>
      setTag(
        f.server,
        "http.request.header.authorization",
        "controlled-secret",
      ),
  ],
  [
    "captured RPC body",
    (f) =>
      (f.server.logs = [
        {
          timestamp: f.server.startTime,
          fields: fields({
            event: "antnest.request",
            "antnest.payload.json": "{}",
          }),
        },
      ]),
  ],
  [
    "uncommitted Model write",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.operationName === "postgresql transaction"),
        "antnest.transaction.outcome",
        "rolled_back",
      ),
  ],
])
  test(`pricing SDK waiver still rejects ${name}`, async (t) => {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(collect(f));
  });

for (const fault of ["clone", "changed report", "changed raw", "duplicate"])
  test(`pricing final outcome rejects ${fault} even for clean diagnostics`, async (t) => {
    const f = costPricingFixture(t);
    const result = await collect(f);
    const clean = await acp(t);
    assert.equal(costStrictOutcome([clean], [result]).accepted, true);
    let results = [result];
    if (fault === "clone") results = [structuredClone(result)];
    if (fault === "changed report") result.persistence = false;
    if (fault === "changed raw") {
      const manifest = read(
        result.raw_evidence_directory,
        "manifest.private.json",
      );
      writeFileSync(
        join(result.raw_evidence_directory, manifest.queries[0].file),
        "{}",
      );
    }
    if (fault === "duplicate") results.push(result);
    assert.equal(costStrictOutcome([clean], results).accepted, false);
  });

test("default shared Resolve collection still requires warning review", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    collectObservabilityResolution(
      "http://jaeger",
      {
        traceID: f.expected.traceID,
        profile: "console",
        resolveTTLMS: 10000,
        route: "/api/admin/{path...}",
        consoleRoute: f.expected.publicRoute,
        method: "POST",
        status: 201,
      },
      { ...f.options, captureRpcContent: false, inspect: () => ({}) },
    ),
  );
});

test("pricing rechecks SDK review on the third sample", async (t) => {
  const f = fixture(t);
  let waits = 0;
  f.options.wait = async () => {
    if (++waits === 3)
      f.server.warnings = ["unreviewed third-sample diagnostic"];
  };
  await assert.rejects(collect(f));
});
