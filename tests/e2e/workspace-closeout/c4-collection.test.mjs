import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c4RunTraceFixture } from "./c4-run-trace.fixture.mjs";
import { c4RevocationTraceFixture } from "./c4-revocation-trace.fixture.mjs";
import { c4InventoryFixture } from "./c4-inventory.fixture.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { serializationRetryFixture } from "../stage3-base/trace-fixtures.mjs";
import { c4OffboardingExpected } from "./c4-revocation.mjs";

const url = new URL("./c4-collection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function io(t, sources) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-c4-collection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    directory,
    attempts: 3,
    wait: async () => {},
    flush: async () => {},
    request: async (address) => {
      const id = new URL(address).pathname.split("/").at(-1),
        trace = sources.get(id);
      return Response.json(
        { data: trace ? [trace] : [] },
        { status: trace ? 200 : 404 },
      );
    },
  };
  return options;
}
function revocation() {
  const f = c4RevocationTraceFixture();
  const expected = {
    kind: "c4_revocation",
    traceID: f.trace.traceID,
    revocation: f.expected,
    relatedTraceIDs: [...f.collection.traces.keys()].filter(
      (id) => id !== f.trace.traceID,
    ),
  };
  return { ...f, expected };
}
function inspect(f, inventory = [f.expected]) {
  assert.equal(typeof implementation.inspectC4TraceSources, "function");
  return implementation.inspectC4TraceSources(
    f.trace,
    f.expected,
    [],
    f.collection ?? f,
    inventory,
  );
}
function inventoryReport(f) {
  const report = c4InventoryFixture();
  report.page_login = f.expected.login;
  report.browser_revocation = {
    ...f.expected,
    offboarding_expected: c4OffboardingExpected({
      before: { events: [] },
      after: {
        events: [
          f.expected.offboarding.owner_revocation,
          f.expected.offboarding.disabled_event,
        ],
      },
      traceID: f.expected.cause.traceID,
      agentId: f.expected.agentId,
      ownerId: f.expected.principal.user_id,
    }),
  };
  return report;
}
function retryRevocation(failedCommit = false) {
  const f = revocation(),
    template = serializationRetryFixture({ failedCommit }),
    ownerID = "rpc-lifecycle.runtime_disable",
    owner = f.raw.trace.spans.find((s) => s.spanID === ownerID),
    original = template.trace.spans.find((s) => s.spanID === ownerID);
  owner.duration = original.duration;
  for (const id of ["aborted", "aborted-statement", "retry"]) {
    const span = structuredClone(
      template.trace.spans.find((s) => s.spanID === id),
    );
    span.traceID = f.raw.trace.traceID;
    span.startTime += owner.startTime - original.startTime;
    for (const reference of span.references) reference.traceID = span.traceID;
    f.raw.trace.spans.push(span);
  }
  return f;
}
for (const phase of ["attachments", "unsupported-audio", "hold-cancel"])
  test(`C4 collector preserves three original complete samples for ${phase}`, async (t) => {
    const f = c4RunTraceFixture(phase, { cleanup: true });
    const original = structuredClone(f.trace),
      options = io(t, new Map([[f.trace.traceID, f.trace]]));
    assert.equal(typeof implementation.collectC4Trace, "function");
    const result = await implementation.collectC4Trace(
      "http://jaeger.test",
      f.expected,
      { ...options, inventory: [f.expected] },
    );
    assert.equal(result.complete_source_receipt.stable_samples, 3);
    assert.equal(result.diagnostic_inventory_verified, true);
    assert.deepEqual(result.original_sources, [f.trace]);
    assert.deepEqual(f.trace, original);
    assert(result.error_spans > 0);
    assert.equal(result.strict_trace, "failed");
    assert.equal(implementation.c4TraceOutcome([result]).accepted, true);
  });

test("C4 collector retains the login, mutation and denial in each SSE sample", async (t) => {
  const f = revocation(),
    options = io(t, f.collection.traces);
  assert.equal(typeof implementation.collectC4Trace, "function");
  const result = await implementation.collectC4Trace(
    "http://jaeger.test",
    f.expected,
    { ...options, inventory: [f.expected] },
  );
  assert.equal(result.complete_source_receipt.source_trace_ids.length, 4);
  assert.deepEqual(
    result.complete_source_receipt.samples.map(
      (sample) => sample.queries.length,
    ),
    [4, 4, 4],
  );
  assert.equal(result.owning_reports[0].authorizationCauseVerified, true);
  assert.equal(implementation.c4TraceOutcome([result]).accepted, true);
});

test("a complete source union can contain another proved audio failure without rewriting either trace", () => {
  const f = c4RunTraceFixture(),
    audio = c4RunTraceFixture("unsupported-audio");
  const source = JSON.parse(
    JSON.stringify({ trace: audio.trace, expected: audio.expected }).replaceAll(
      audio.trace.traceID,
      "e".repeat(32),
    ),
  );
  f.traces = new Map([
    [f.trace.traceID, f.trace],
    [source.trace.traceID, source.trace],
  ]);
  const original = structuredClone([...f.traces]);
  const result = inspect(f, [f.expected, source.expected]);
  assert.equal(result.owning_reports.length, 2);
  assert.equal(result.error_spans, 3);
  assert.equal(implementation.c4TraceOutcome([result]).accepted, true);
  assert.deepEqual([...f.traces], original);
});
for (const [name, mutate] of [
  ["numeric OTel error", (s) => setTag(s, "otel.status_code", 2)],
  ["error type", (s) => setTag(s, "error.type", "unexpected")],
  [
    "event-only error",
    (s) => {
      s.logs = [
        {
          timestamp: s.startTime,
          fields: [{ key: "event", value: "antnest.error" }],
        },
      ];
    },
  ],
  [
    "warning log",
    (s) => {
      s.logs = [
        { timestamp: s.startTime, fields: [{ key: "level", value: "WARN" }] },
      ];
    },
  ],
  [
    "error log",
    (s) => {
      s.logs = [
        { timestamp: s.startTime, fields: [{ key: "level", value: "ERROR" }] },
      ];
    },
  ],
  ["nonzero RPC status", (s) => setTag(s, "rpc.response.status_code", 13)],
  ["nonzero JSON RPC status", (s) => setTag(s, "jsonrpc.error_code", -32603)],
])
  test(`C4 complete sources reject an otherwise successful foreign source with ${name}`, () => {
    const f = c4RunTraceFixture(),
      source = structuredClone(f.trace);
    source.traceID = "e".repeat(32);
    for (const span of source.spans) {
      span.traceID = source.traceID;
      for (const reference of span.references ?? [])
        reference.traceID = source.traceID;
    }
    mutate(source.spans.find((s) => s.spanID === "root"));
    f.traces = new Map([
      [f.trace.traceID, f.trace],
      [source.traceID, source],
    ]);
    assert.equal(typeof implementation.inspectC4TraceSources, "function");
    assert.throws(() => inspect(f), /unclaimed.*raw error|Session/u);
  });

test("C4 rejects an unowned source warning without hiding original strict findings", () => {
  const f = c4RunTraceFixture();
  f.trace.warnings = ["unexpected original exporter warning"];
  const result = inspect(f);
  assert.equal(result.strict_trace, "failed");
  assert.equal(implementation.c4TraceOutcome([result]).accepted, false);
});

for (const [field, value] of [
  ["level", "WARN"],
  ["level", "ERROR"],
  ["rpc.response.status_code", 13],
  ["jsonrpc.error_code", -32603],
])
  test(`C4 mutation proof does not waive unrelated ${field}=${value} diagnostics`, () => {
    const f = revocation();
    if (field === "level")
      f.mutationRoot.logs = [
        {
          timestamp: f.mutationRoot.startTime,
          fields: [{ key: field, value }],
        },
      ];
    else setTag(f.mutationRoot, field, value);
    assert.throws(() => inspect(f));
  });

for (const [field, value] of [
  ["db.response.status_code", "500"],
  ["http.transport.error.type", "unexpected"],
  ["otel.status_description", "unexpected"],
])
  test(`C4 mutation SQL rejects unowned ${field} diagnostics`, () => {
    const f = revocation();
    setTag(f.sql.user, field, value);
    assert.throws(() => inspect(f), /Session/u);
  });

for (const failedCommit of [false, true])
  test(`C4 mutation retains the proved serialization retry (commit=${failedCommit})`, () => {
    const f = retryRevocation(failedCommit),
      original = structuredClone(f.raw.trace);
    const result = inspect(f);
    assert.equal(implementation.c4TraceOutcome([result]).accepted, true);
    assert(result.error_spans > 0);
    assert.deepEqual(f.raw.trace, original);
  });

for (const statusStyle of ["modern", "legacy", "both"])
  test(`C4 mutation admits proved ${statusStyle} Docker absence without changing raw status`, () => {
    const f = revocation(),
      source = f.raw.trace,
      owner = source.spans.find(
        (span) => span.spanID === "rpc-lifecycle.runtime_disable",
      );
    for (const [id, parent, operationName, fields] of [
      [
        "c4-delete-platform",
        owner.spanID,
        "runtime.platform.delete",
        {
          "antnest.agent.id": f.expected.revocation.agentId,
          "antnest.outcome": "completed",
          "antnest.platform": "docker",
        },
      ],
      [
        "c4-absent",
        "c4-delete-platform",
        "HTTP GET docker",
        {
          "span.kind": "client",
          "peer.service": "docker",
          "http.request.method": "GET",
          "http.response.status_code": 404,
          "antnest.outcome": "absent",
        },
      ],
    ])
      source.spans.push({
        traceID: source.traceID,
        spanID: id,
        processID: "runtime-controller",
        operationName,
        startTime: owner.startTime,
        duration: 0,
        references: [
          { refType: "CHILD_OF", traceID: source.traceID, spanID: parent },
        ],
        tags: Object.entries(fields).map(([key, value]) => ({ key, value })),
      });
    const probe = source.spans.at(-1);
    if (statusStyle !== "modern") setTag(probe, "http.status_code", 404);
    if (statusStyle === "legacy")
      probe.tags = probe.tags.filter(
        ({ key }) => key !== "http.response.status_code",
      );
    const original = structuredClone(source);
    assert.equal(implementation.c4TraceOutcome([inspect(f)]).accepted, true);
    assert.deepEqual(source, original);
    setTag(source.spans.at(-1), "db.response.status_code", "500");
    assert.throws(() => inspect(f), /Session/u);
  });

test("C4 mutation cannot attach a settlement result to another controller span", () => {
  const f = revocation(),
    span = f.raw.trace.spans.find((s) => s.spanID === "schedule");
  for (const [field, value] of Object.entries({
    "antnest.agent.id": f.expected.revocation.agentId,
    "antnest.operation.id": f.expected.revocation.offboarding.request_id,
    "antnest.settlement.outcome": "settled",
  }))
    setTag(span, field, value);
  assert.throws(() => inspect(f));
});

test("a late source error is archived and cannot borrow the previous two clean samples", async (t) => {
  const f = c4RunTraceFixture(),
    options = io(t, new Map([[f.trace.traceID, f.trace]])),
    request = options.request;
  let count = 0;
  options.request = async (...args) => {
    if (++count === 3) setTag(f.root, "error.type", "late-original-failure");
    return request(...args);
  };
  assert.equal(typeof implementation.collectC4Trace, "function");
  await assert.rejects(
    implementation.collectC4Trace("http://jaeger.test", f.expected, {
      ...options,
      inventory: [f.expected],
    }),
  );
  const archive = join(
    options.directory,
    readdirSync(options.directory).find((name) =>
      name.startsWith("workspace-http-"),
    ),
  );
  const manifest = JSON.parse(readFileSync(join(archive, "manifest.json")));
  assert.equal(manifest.status, "failed");
  assert(
    readFileSync(join(archive, "query-0003.raw"), "utf8").includes(
      "late-original-failure",
    ),
  );
});

test("C4 collection inventory keeps all eleven original prompts and all four revocation roots", () => {
  const f = c4RevocationTraceFixture(),
    report = inventoryReport(f);
  assert.equal(typeof implementation.c4TraceInventory, "function");
  const rows = implementation.c4TraceInventory(report, {
    gateway: f.expected.gateway,
  });
  assert.equal(rows.length, 15);
  assert.equal(rows.filter((r) => r.kind === "c4_run").length, 11);
  const revoke = rows.filter((r) => r.kind === "c4_revocation");
  assert.equal(revoke.length, 4);
  for (const row of revoke) {
    assert.deepEqual(
      new Set([row.traceID, ...row.relatedTraceIDs]),
      new Set(f.collection.traces.keys()),
    );
    const result = implementation.inspectC4TraceSources(
      f.collection.traces.get(row.traceID),
      row,
      [],
      f.collection,
      rows,
    );
    assert.equal(implementation.c4TraceOutcome([result]).accepted, true);
  }
  delete report.browser_revocation.traceID;
  delete report.browser_revocation.checkpoint;
  delete report.browser_revocation.offboarding_expected;
  const partial = implementation.c4TraceInventory(report, {
    gateway: f.expected.gateway,
  });
  assert.equal(partial.filter((r) => r.kind === "c4_revocation").length, 3);
});

for (const field of ["sourceID", "traceID", "agentID"])
  test(`C4 inventory preserves a mismatched offboarding ${field} for rejection`, () => {
    const f = c4RevocationTraceFixture(),
      report = inventoryReport(f);
    report.browser_revocation.offboarding_expected[field] =
      "wrong-original-owner";
    const rows = implementation.c4TraceInventory(report, {
      gateway: f.expected.gateway,
    });
    const row = rows.find((row) => row.traceID === f.trace.traceID);
    assert.throws(() =>
      implementation.inspectC4TraceSources(
        f.trace,
        row,
        [],
        f.collection,
        rows,
      ),
    );
  });
