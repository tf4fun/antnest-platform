import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  collectOutageTraceArchive,
  outageTraceSelection,
} from "./resolve-cache-outage-collect.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";
import { workspaceOutageFixture } from "../workspace-closeout/chat-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { inspectOutageAuthority } from "./resolve-cache-outage-authority.mjs";
import { runtimeCancellationBusinessFixture } from "./resolve-cache-runtime-cancellation-business-fixtures.mjs";
import { outageClockFixture } from "./resolve-cache-outage-clock-fixtures.mjs";

const id = (n) => n.toString(16).padStart(32, "0");
function sample() {
  const frame = (method) => ({
    direction: "send",
    raw: JSON.stringify({ method }),
  });
  const trace = (n, connection, method) => ({
    traceID: id(n),
    processes: { edge: { serviceName: "edge-gateway" } },
    spans: [
      {
        traceID: id(n),
        spanID: "1234567890abcdef",
        processID: "edge",
        operationName: `acp ${method}`,
        startTime: 1,
        duration: 1,
        tags: [
          { key: "span.kind", value: "server" },
          { key: "rpc.method", value: method },
        ],
        references: [
          {
            refType: "FOLLOWS_FROM",
            traceID: id(connection),
            spanID: "1234567890abcdef",
          },
        ],
      },
    ],
  });
  return {
    evidence: {
      http: [{ trace_id: id(1) }],
      stream: { trace_id: id(2) },
      wire: {
        upgrade: { trace_id: id(3) },
        frames: [frame("initialize"), frame("session/cancel")],
      },
      prep_wire: {
        upgrade: { trace_id: id(4) },
        frames: [frame("session/prompt")],
      },
      model_observations: [{ state: { requests: [{ trace_id: id(5) }] } }],
    },
    found: {
      messages: [
        trace(6, 3, "initialize"),
        trace(7, 3, "session/cancel"),
        trace(5, 4, "session/prompt"),
        trace(8, 99, "session/list"),
      ],
      feed: [{ traceID: id(9) }],
      feedAttempts: [{ traceID: id(9) }, { traceID: id(11) }],
      jwks: [{ traceID: id(10) }],
      refresh: [],
      close: [],
      deletion: [],
    },
  };
}
test("outage raw scope includes HTTP/SSE, both actual WSS connections, model origins, feed and JWKS", () => {
  const { evidence, found } = sample();
  assert.deepEqual(
    outageTraceSelection(evidence, found),
    [1, 2, 3, 4, 5, 6, 7, 9, 10, 11].map(id),
  );
});

function withRecoveryObservers(s) {
  s.evidence.recovery = { cases: [] };
  for (const n of [20, 30]) {
    s.evidence.recovery.cases.push({
      name: `case-${n}`,
      wire: {
        upgrade: { trace_id: id(n) },
        frames: [{ direction: "send", raw: '{"method":"initialize"}' }],
      },
      stream: { trace_id: id(n + 1) },
    });
    const message = structuredClone(s.found.messages[0]);
    message.traceID = id(n + 2);
    message.spans[0].traceID = message.traceID;
    message.spans[0].references[0].traceID = id(n);
    s.found.messages.push(message);
  }
}

test("outage inventory includes every recovery WSS message and SSE", () => {
  const s = sample();
  withRecoveryObservers(s);
  assert.deepEqual(
    outageTraceSelection(s.evidence, s.found),
    [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 20, 21, 22, 30, 31, 32].map(id),
  );
});

test("outage inventory rejects a missing recovery WSS message", () => {
  const s = sample();
  withRecoveryObservers(s);
  s.found.messages.pop();
  assert.throws(() => outageTraceSelection(s.evidence, s.found), /inventory/u);
});

test("outage inventory rejects duplicate connection identities", () => {
  const s = sample();
  withRecoveryObservers(s);
  s.evidence.recovery.cases[1].wire.upgrade.trace_id = id(20);
  assert.throws(
    () => outageTraceSelection(s.evidence, s.found),
    /duplicate.*connection/u,
  );
});
for (const [label, change] of [
  [
    "missing actual cancel trace",
    (s) => {
      s.found.messages.splice(1, 1);
    },
  ],
  [
    "foreign connection",
    (s) => {
      s.found.messages[1].spans[0].references[0].traceID = id(99);
    },
  ],
  [
    "duplicate message",
    (s) => {
      s.found.messages.push(s.found.messages[0]);
    },
  ],
  [
    "invented HTTP trace",
    (s) => {
      s.evidence.http[0].trace_id = "invalid";
    },
  ],
  [
    "unknown message on same connection",
    (s) => {
      s.found.messages[1].spans[0].tags[1].value = "session/list";
    },
  ],
])
  test(`outage raw scope rejects ${label}`, () => {
    const s = sample();
    change(s);
    assert.throws(() => outageTraceSelection(s.evidence, s.found));
  });

function archiveHarness(
  t,
  change = () => {},
  inspectAuthority = () => ({ status: "passed", fixture: true }),
  inspectRejections,
  recoveryInspectors = {},
) {
  const fixture = sample();
  fixture.evidence.observed_at_ms = Date.now() - 1000;
  const root = mkdtempSync(join(temporaryStorageRoot(), "outage-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = new Set(),
    searched = [],
    gatewayRounds = [],
    serverRounds = [],
    closeRounds = [],
    deleteRounds = [],
    windows = [];
  let searchFailure;
  change(fixture, {
    missing,
    gatewayRounds,
    serverRounds,
    closeRounds,
    deleteRounds,
    failSearch: (name) => (searchFailure = name),
  });
  const fallback = (traceID) => ({
    ...structuredClone(fixture.found.messages[0]),
    traceID,
    spans: [
      {
        ...structuredClone(fixture.found.messages[0].spans[0]),
        traceID,
        references: [],
      },
    ],
  });
  const archive = () =>
    collectOutageTraceArchive(
      "http://unused.invalid",
      fixture.evidence,
      ["private-canary"],
      {
        signal: AbortSignal.timeout(10000),
        directory: root,
        inspectAuthority,
        inspectRejections,
        inspectFeed: () => ({ status: "passed", owned_error_spans: [] }),
        inspectStreams: () => ({ status: "passed", owned_error_spans: [] }),
        inspectDiagnostics: () => ({ status: "passed" }),
        ...recoveryInspectors,
        wait: async () => {},
        search: async (_base, query, options) => {
          windows.push({ now: options.now, lookback: query.get("lookback") });
          const tags = JSON.parse(query.get("tags"));
          const name =
            query.get("operation") === "HTTP GET /status"
              ? "health"
              : query.get("operation") === "agent_ui.acp.close"
                ? "close"
                : query.get("operation") === "HTTP DELETE /v1/acp"
                  ? "deletion"
                  : query.get("operation") === "HTTP POST identity-service"
                    ? "feedAttempts"
                    : query.get("operation")
                      ? "refresh"
                      : query.get("service") === "edge-gateway"
                        ? "messages"
                        : tags["rpc.method"] === "list_session_revocations"
                          ? "feed"
                          : "jwks";
          searched.push(name);
          if (name === "feedAttempts")
            assert.deepEqual(tags, {
              "span.kind": "client",
              "http.request.method": "POST",
              "server.address": "identity-service",
            });
          if (name === "jwks")
            assert.deepEqual(tags, {
              "http.route": "/rpc/identity/jwks",
              "http.request.method": "GET",
              "span.kind": "server",
            });
          if (name === searchFailure) throw new Error(`${name} search failed`);
          if (name === "close" && closeRounds.length)
            return closeRounds.shift();
          if (name === "deletion" && deleteRounds.length)
            return deleteRounds.shift();
          return name === "feedAttempts" && gatewayRounds.length
            ? gatewayRounds.shift()
            : name === "feed" && serverRounds.length
              ? serverRounds.shift()
              : fixture.found[name];
        },
        collect: (base, expected, secrets, options) =>
          collectResolveTraceEvidence(base, expected, secrets, {
            ...options,
            attempts: 3,
            wait: async () => {},
            request: async (url) => {
              const traceID = url.split("/").at(-1);
              if (missing.has(traceID))
                return new Response("", { status: 404 });
              const trace =
                fixture.traces?.get(traceID) ??
                fixture.found.messages.find(
                  (item) => item.traceID === traceID,
                ) ??
                fallback(traceID);
              return Response.json({ data: [trace] });
            },
          }),
      },
    );
  return { root, archive, searched, windows };
}

function withOutageChat(s) {
  const f = workspaceOutageFixture("shared");
  s.traces = f.traces;
  const evidence = s.evidence;
  Object.assign(evidence, {
    agent_id: f.expected.agentId,
    session_id: f.expected.sessionId,
    run_id: f.expected.runId,
    settings: { resolveTTLMS: 10000 },
    cancel_at: f.expected.cancelAt,
    business_window: { run_id: f.expected.runId },
    model_cancelled: { state: { requests: f.expected.requests, errors: [] } },
    audit: f.expected.audit,
  });
  evidence.model_observations.push(evidence.model_cancelled);
  evidence.http.push(
    {
      label: "outage-prompt",
      method: "POST",
      path: "/api/app/workspace/v1/agents/agent/sessions/session/prompts",
      trace_id: f.trace.traceID,
      status: 202,
      set_cookie_count: 0,
      body: { acceptance: "bridge" },
    },
    evidence.audit,
  );
  return f;
}

function withHeldRuntime(s) {
  const f = runtimeCancellationBusinessFixture();
  withBridgeClose(s);
  Object.assign(s.evidence, f.evidence, {
    business_window: { run_id: f.evidence.run_id },
    model_observations: [f.evidence.model_started, f.evidence.model_cancelled],
  });
  delete s.evidence.wire;
  delete s.evidence.prep_wire;
  for (const [id, trace] of f.collection.traces) s.traces.set(id, trace);
  return f;
}

test("rev4 archive runs the complete single-model Runtime cancellation consumer after raw capture", async (t) => {
  let f;
  const h = archiveHarness(t, (s) => {
    f = withHeldRuntime(s);
  });
  const report = await h.archive(),
    gate = report.owning_gates.cancellation;
  assert.equal(gate.status, "passed");
  assert.equal(gate.provider_requests, 1);
  assert.equal(gate.runtime_calls, 1);
  assert.equal(gate.owned_error_spans.length, 6);
  assert.equal(gate.transport_receipts.length, 2);
  assert.equal(gate.business.runtime_quiescent, true);
  assert.equal(gate.timing.status, "timing_proved_business_admission_pending");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(h.root, "outage-traces", `${f.trace.traceID}.json`)),
    ),
    f.trace,
  );
  assert.equal(
    report.reports.find((r) => r.trace_id === f.trace.traceID).settled_read,
    undefined,
  );
});

for (const mode of [
  "passed",
  "pending",
  "throw",
  "missing claims",
  "missing receipts",
])
  test(`rev4 cancellation collector awaits and preserves full owning result: ${mode}`, async (t) => {
    let called = 0,
      delivered;
    const h = archiveHarness(t, withHeldRuntime, undefined, undefined, {
      async inspectRuntimeCancellation(evidence, collection, secrets) {
        called++;
        await Promise.resolve();
        assert.deepEqual(secrets, ["private-canary"]);
        assert(collection.traces.has(evidence.prompt.trace_id));
        assert(collection.traces.has(evidence.cancel.trace_id));
        for (const id of collection.archivedTraceIDs)
          assert(existsSync(join(h.root, "outage-traces", `${id}.json`)));
        if (mode === "throw")
          throw new Error("runtime cancellation owning failure");
        delivered = {
          status: mode === "pending" ? "pending" : "passed",
          trace_id: evidence.prompt.trace_id,
          owned_error_spans: [],
          otel_error_spans: [],
          transport_receipts: [],
          metadata_receipts: [],
          business: { runtime_quiescent: true },
          timing: { fixture: true },
        };
        if (mode === "missing claims") delete delivered.owned_error_spans;
        if (mode === "missing receipts") delete delivered.transport_receipts;
        return delivered;
      },
    });
    if (mode === "passed") await h.archive();
    else await assert.rejects(h.archive(), AggregateError);
    assert.equal(called, 1);
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(
      report.owning_gates.cancellation.status,
      mode === "passed" ? "passed" : "pending",
    );
    if (mode === "passed")
      assert.deepEqual(report.owning_gates.cancellation, delivered);
    else assert.equal(report.status, "archive_failed");
    assert(existsSync(join(h.root, "outage-traces", `${"a".repeat(32)}.json`)));
  });

test("unknown outage revision is rejected without falling back to legacy cancellation or losing raw sources", async (t) => {
  const h = archiveHarness(t, (s) => {
    withOutageChat(s);
    s.evidence.policy_revision = 99;
  });
  await assert.rejects(h.archive(), AggregateError);
  const report = JSON.parse(
    readFileSync(join(h.root, "outage-trace-archive.json")),
  );
  assert.equal(report.owning_gates.cancellation.status, "pending");
  assert(
    report.failures.some((message) =>
      /unsupported outage policy/u.test(message),
    ),
  );
  assert(existsSync(join(h.root, "outage-traces", `${"a".repeat(32)}.json`)));
});

function withBridgeClose(s) {
  s.evidence.policy_revision = 4;
  const sourceId = id(71),
    closeId = id(70);
  const ui = "1111111111111111",
    root = "2222222222222222",
    deletion = "3333333333333333";
  const span = (
    traceID,
    spanID,
    processID,
    operationName,
    tags,
    references = [],
  ) => ({
    traceID,
    spanID,
    processID,
    operationName,
    startTime: 10,
    duration: 10,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    references,
    logs: [],
  });
  const source = {
    traceID: sourceId,
    processes: { ui: { serviceName: "agent-ui" } },
    spans: [
      span(sourceId, ui, "ui", "agent_ui.http.request", {
        "span.kind": "server",
      }),
    ],
  };
  const close = {
    traceID: closeId,
    processes: {
      ui: { serviceName: "agent-ui" },
      acp: { serviceName: "agent-acp-service" },
    },
    spans: [
      span(
        closeId,
        root,
        "ui",
        "agent_ui.acp.close",
        {
          "span.kind": "internal",
          "antnest.ui.acp.close.trigger": "transport_failure",
          "antnest.ui.acp.close.outcome": "failed",
          error: true,
        },
        [{ refType: "FOLLOWS_FROM", traceID: sourceId, spanID: ui }],
      ),
      span(
        closeId,
        deletion,
        "acp",
        "HTTP DELETE /v1/acp",
        {
          "span.kind": "server",
          "http.request.method": "DELETE",
          "http.route": "/v1/acp",
          "antnest.listener": "workspace",
          "http.response.status_code": 401,
          error: true,
        },
        [{ refType: "CHILD_OF", traceID: closeId, spanID: root }],
      ),
    ],
  };
  s.found.close = [close];
  s.found.deletion = [close];
  s.traces = new Map([
    [closeId, close],
    [sourceId, source],
  ]);
  const clock = outageClockFixture();
  s.evidence.acp_clock_probe = clock.evidence.acp_clock_probe;
  s.found.health = clock.clockSearches.found;
  for (const trace of s.found.health) s.traces.set(trace.traceID, trace);
  return { close, source, sourceId, closeId };
}

test("Bridge outage archives failed close and DELETE with their actual initialization source", async (t) => {
  const h = archiveHarness(t, withBridgeClose);
  const report = await h.archive();
  assert.equal(
    report.cleanup_capture.status,
    "captured_owning_admission_pending",
  );
  assert.equal(report.strict_trace, "failed");
  for (const n of [1, 70, 71])
    assert(existsSync(join(h.root, "outage-traces", `${id(n)}.json`)));
  const saved = JSON.parse(
    readFileSync(join(h.root, "outage-traces", `${id(70)}.json`)),
  );
  assert.equal(
    saved.spans[1].tags.find((tag) => tag.key === "http.response.status_code")
      .value,
    401,
  );
  const search = JSON.parse(
    readFileSync(join(h.root, "outage-trace-search.private.json")),
  );
  assert.equal(search.close_searches.length, 3);
  assert.equal(search.delete_searches.length, 3);
  assert.equal(
    new Set(h.windows.map((value) => JSON.stringify(value))).size,
    1,
  );
});

test("Bridge outage waits for late close inventory and late raw warnings", async (t) => {
  const h = archiveHarness(t, (s, controls) => {
    const { close } = withBridgeClose(s);
    const early = structuredClone(close);
    close.warnings = ["late diagnostic"];
    controls.closeRounds.push([], [early], [close], [close], [close]);
  });
  const report = await h.archive();
  assert.equal(
    report.cleanup_capture.status,
    "captured_owning_admission_pending",
  );
  assert.equal(h.searched.filter((name) => name === "close").length, 5);
  const saved = JSON.parse(
    readFileSync(join(h.root, "outage-traces", `${id(70)}.json`)),
  );
  assert.deepEqual(saved.warnings, ["late diagnostic"]);
  assert.equal(report.strict_trace, "failed");
});

test("Bridge stream inspector receives the independent cleanup inventories and all rounds", async (t) => {
  let observed = false;
  const h = archiveHarness(
    t,
    (s) => {
      withOutageChat(s);
      const existing = new Map(s.traces);
      withBridgeClose(s);
      for (const [id, trace] of existing) s.traces.set(id, trace);
      s.evidence.recovery_window = {};
    },
    undefined,
    undefined,
    {
      // This test owns stream-inventory delivery; cancellation has a separate
      // full-consumer archive fixture above.
      inspectRuntimeCancellation: () => ({
        status: "passed",
        owned_error_spans: [],
        otel_error_spans: [],
        transport_receipts: [],
        metadata_receipts: [],
      }),
      inspectRecovery: () => ({ status: "passed" }),
      inspectRecoveryBudgets: () => ({ status: "passed" }),
      inspectRecoveryHTTP: () => ({ status: "passed" }),
      inspectStreams(_evidence, collection) {
        const saved = JSON.parse(
          readFileSync(join(h.root, "outage-trace-search.private.json")),
        );
        assert(
          collection.cleanupSearches,
          "owning stream cleanup search missing",
        );
        assert.deepEqual(collection.cleanupSearches.found, saved.cleanup_found);
        assert.deepEqual(
          collection.cleanupSearches.rounds.close,
          saved.close_searches,
        );
        assert.deepEqual(
          collection.cleanupSearches.rounds.deletion,
          saved.delete_searches,
        );
        assert.deepEqual(collection.cleanupSearches.errors, []);
        assert.equal(collection.cleanupSearches.now, saved.now);
        assert.equal(collection.cleanupSearches.lookback, saved.lookback);
        assert(collection.clockSearches, "owning stream health search missing");
        assert.deepEqual(collection.clockSearches, saved.clock_searches);
        assert.equal(collection.clockSearches.rounds.length, 3);
        for (const trace of collection.clockSearches.found) {
          assert(collection.archivedTraceIDs.has(trace.traceID));
          assert.deepEqual(collection.traces.get(trace.traceID), trace);
        }
        observed = true;
        return { status: "passed", owned_error_spans: [] };
      },
    },
  );
  await h.archive();
  assert(observed);
});

test("a failed health search still archives independently known HTTP and owner traces", async (t) => {
  const h = archiveHarness(t, (s, controls) => {
    withBridgeClose(s);
    controls.failSearch("health");
  });
  await assert.rejects(h.archive, /archive failed/);
  for (const n of [1, 70, 71])
    assert(existsSync(join(h.root, "outage-traces", id(n) + ".json")));
  const saved = JSON.parse(
    readFileSync(join(h.root, "outage-trace-search.private.json")),
  );
  assert.match(saved.clock_searches.errors[0], /health search failed/);
});

function completedBridgeClose(s) {
  const fixture = withBridgeClose(s);
  const [close, deletion] = fixture.close.spans;
  close.tags.find(
    (field) => field.key === "antnest.ui.acp.close.outcome",
  ).value = "closed";
  deletion.tags.find(
    (field) => field.key === "http.response.status_code",
  ).value = 202;
  for (const span of fixture.close.spans)
    span.tags = span.tags.filter((field) => field.key !== "error");
  return fixture;
}

for (const missing of [true, false]) {
  test(`Bridge outage rejects a closed owner with ${missing ? "missing" : "duplicate"} DELETE evidence`, async (t) => {
    const h = archiveHarness(t, (s) => {
      const { close } = completedBridgeClose(s);
      if (missing) {
        close.spans.pop();
        s.found.deletion = [];
      } else {
        close.spans.push({
          ...structuredClone(close.spans[1]),
          spanID: "4444444444444444",
        });
      }
    });
    await assert.rejects(h.archive(), AggregateError);
    for (const n of [1, 70, 71])
      assert(existsSync(join(h.root, "outage-traces", `${id(n)}.json`)));
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(report.cleanup_capture.status, "failed");
    assert(
      report.failures.some((value) =>
        value.includes("closed owner requires one complete DELETE receipt"),
      ),
    );
  });
}

test("Bridge outage waits beyond an empty DELETE index for a closed owner's receipt", async (t) => {
  const h = archiveHarness(t, (s, controls) => {
    const { close } = completedBridgeClose(s);
    controls.deleteRounds.push([], [], [], [close], [close], [close]);
  });
  const report = await h.archive();
  assert.equal(
    report.cleanup_capture.status,
    "captured_owning_admission_pending",
  );
  assert.equal(h.searched.filter((name) => name === "deletion").length, 6);
});

for (const outcome of ["failed", "no_target"]) {
  test(`Bridge outage preserves ${outcome} close without inventing a DELETE receipt`, async (t) => {
    const h = archiveHarness(t, (s) => {
      const { close } = withBridgeClose(s);
      close.spans[0].tags.find(
        (field) => field.key === "antnest.ui.acp.close.outcome",
      ).value = outcome;
      close.spans.pop();
      s.found.deletion = [];
    });
    const report = await h.archive();
    assert.equal(
      report.cleanup_capture.status,
      "captured_owning_admission_pending",
    );
    assert.deepEqual(report.cleanup_capture.delete_span_ids, []);
  });
}

for (const failed of ["close", "deletion"]) {
  test(`Bridge outage retains known and peer cleanup sources when ${failed} search fails`, async (t) => {
    const h = archiveHarness(t, (s, controls) => {
      withBridgeClose(s);
      controls.failSearch(failed);
    });
    await assert.rejects(h.archive(), AggregateError);
    for (const n of [1, 70, 71])
      assert(existsSync(join(h.root, "outage-traces", `${id(n)}.json`)));
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(report.cleanup_capture.status, "failed");
    assert(
      report.failures.some((value) =>
        value.includes(`${failed} search failed`),
      ),
    );
  });
}

for (const [name, change] of [
  [
    "missing initialization Link",
    ({ close }) => {
      close.spans[0].references = [];
    },
  ],
  [
    "wrong initialization span",
    ({ source }) => {
      source.spans[0].operationName = "unrelated";
    },
  ],
  [
    "DELETE missing parent",
    ({ close }) => {
      close.spans[1].references[0].spanID = "ffffffffffffffff";
    },
  ],
]) {
  test(`Bridge outage rejects ${name} without dropping known HTTP evidence`, async (t) => {
    const h = archiveHarness(t, (s) => {
      change(withBridgeClose(s));
    });
    await assert.rejects(h.archive(), AggregateError);
    assert(existsSync(join(h.root, "outage-traces", `${id(1)}.json`)));
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(report.cleanup_capture.status, "failed");
  });
}

test("recovery inventory failure still archives independently known observers", async (t) => {
  const h = archiveHarness(t, (s) => {
    withRecoveryObservers(s);
    s.found.messages.pop();
    s.evidence.recovery.cases.push({
      name: "partial",
      stream: { trace_id: id(40) },
    });
  });
  await assert.rejects(h.archive(), AggregateError);
  for (const n of [20, 21, 30, 31, 40])
    assert(existsSync(join(h.root, "outage-traces", `${id(n)}.json`)));
});

for (const mode of ["passed", "throws", "pending"])
  test(`feed owning gate ${mode} preserves complete search and raw diagnostics`, async (t) => {
    let observed = false;
    const claims = [
      {
        trace_id: id(11),
        span_id: "1234567890abcdef",
        reason: "identity-feed-stopped",
      },
    ];
    const h = archiveHarness(
      t,
      (s) => withOutageChat(s),
      undefined,
      undefined,
      {
        inspectFeed(evidence, collection, secrets) {
          assert(evidence.business_window);
          assert.deepEqual(secrets, ["private-canary"]);
          assert(collection.traces.size > 0);
          for (const traceID of collection.traces.keys())
            assert(collection.archivedTraceIDs.has(traceID));
          assert.equal(collection.feedSearch.feed_attempt_searches.length, 3);
          const savedSearch = JSON.parse(
            readFileSync(join(h.root, "outage-trace-search.private.json")),
          );
          assert.deepEqual(
            collection.feedSearch.feed_server_searches,
            savedSearch.feed_server_searches,
            "owning feed inspector must receive the archived SERVER rounds",
          );
          assert.deepEqual(
            collection.feedSearch.feed_server_searches.map((round) =>
              round.map((t) => t.traceID),
            ),
            [[id(9)], [id(9)], [id(9)]],
          );
          assert.deepEqual(
            collection.feedSearch.found.feed.map((t) => t.traceID),
            [id(9)],
          );
          assert.deepEqual(
            collection.feedSearch.feed_attempt_searches
              .at(-1)
              .map((t) => t.traceID),
            [id(9), id(11)],
          );
          assert(Number.isSafeInteger(collection.feedSearch.now));
          assert.match(collection.feedSearch.lookback, /^[0-9]+ms$/u);
          observed = true;
          if (mode === "throws")
            throw new Error("wrong feed failure ownership");
          return { status: mode, owned_error_spans: claims };
        },
      },
    );
    if (mode === "passed") await h.archive();
    else await assert.rejects(h.archive(), AggregateError);
    assert(observed, "feed inspector was not invoked");
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(
      report.owning_gates.feed.status,
      mode === "passed" ? "passed" : "pending",
    );
    assert.equal(report.owning_gates.cancellation.status, "passed");
    assert.equal(report.strict_trace, "failed");
    if (mode === "passed")
      assert.deepEqual(report.owning_gates.feed.owned_error_spans, claims);
    else assert.equal(report.status, "archive_failed");
    assert(existsSync(join(h.root, "outage-traces", `${id(11)}.json`)));
  });

test("outage archive runs HTTP rejection gate against archived sources", async (t) => {
  let observed = false;
  const h = archiveHarness(
    t,
    (s) => {
      withOutageChat(s);
      s.evidence.rejections = { fixture: true };
    },
    undefined,
    (evidence, collection) => {
      assert(evidence.rejections.fixture);
      assert(collection.traces.size > 0);
      for (const id of collection.traces.keys())
        assert(collection.archivedTraceIDs.has(id));
      observed = true;
      return { status: "passed" };
    },
  );
  const result = await h.archive();
  assert(observed);
  assert.equal(result.owning_gates.http_rejections.status, "passed");
});

test("HTTP rejection gate failure preserves raw archive and strict failure", async (t) => {
  const h = archiveHarness(
    t,
    (s) => {
      withOutageChat(s);
      s.evidence.rejections = { fixture: true };
    },
    undefined,
    () => {
      throw new Error("wrong actual outage HTTP response");
    },
  );
  await assert.rejects(h.archive(), AggregateError);
  const report = JSON.parse(
    readFileSync(join(h.root, "outage-trace-archive.json")),
  );
  assert.equal(report.status, "archive_failed");
  assert.equal(report.owning_gates.http_rejections.status, "pending");
  assert.equal(report.owning_gates.cancellation.status, "passed");
  assert(
    report.failures.some((line) =>
      line.includes("wrong actual outage HTTP response"),
    ),
  );
  assert(existsSync(join(h.root, "outage-traces", `${id(1)}.json`)));
});

for (const failed of [false, true])
  test(`recovery HTTP gate ${failed ? "retains failure" : "checks archived sources"}`, async (t) => {
    let observed = false;
    const h = archiveHarness(
      t,
      (s) => {
        withOutageChat(s);
        s.evidence.recovery_window = { status: "passed" };
      },
      undefined,
      undefined,
      {
        inspectRecovery: () => ({ status: "passed" }),
        inspectRecoveryBudgets: () => ({ status: "passed" }),
        inspectRecoveryHTTP(evidence, collection, secrets) {
          assert(evidence.recovery_window);
          assert.deepEqual(secrets, ["private-canary"]);
          assert(collection.traces.size > 0);
          for (const id of collection.traces.keys())
            assert(collection.archivedTraceIDs.has(id));
          observed = true;
          if (failed) throw new Error("wrong recovery HTTP transaction");
          return { status: "passed", owned_error_spans: [] };
        },
      },
    );
    if (failed) await assert.rejects(h.archive(), AggregateError);
    else await h.archive();
    assert(observed, "recovery HTTP inspector was not invoked");
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(
      report.owning_gates.recovery_http.status,
      failed ? "pending" : "passed",
    );
    assert.equal(report.owning_gates.recovery_runs.status, "passed");
    assert.equal(report.owning_gates.cancellation.status, "passed");
    assert.equal(report.strict_trace, "failed");
    if (failed) {
      assert.equal(report.status, "archive_failed");
      assert(
        report.failures.some((line) =>
          line.includes("wrong recovery HTTP transaction"),
        ),
      );
    }
    assert(existsSync(join(h.root, "outage-traces", `${id(1)}.json`)));
  });

for (const mode of ["passed", "throws", "pending", "missing-claims"])
  test(`stream gate ${mode} preserves raw archive and exact claims`, async (t) => {
    let called = false;
    const claims = [
      {
        trace_id: id(11),
        span_id: "1234567890abcdef",
        reason: "public-sse-revoked-handler",
      },
    ];
    const h = archiveHarness(
      t,
      (s) => {
        withOutageChat(s);
        s.evidence.recovery_window = { status: "passed" };
      },
      undefined,
      undefined,
      {
        inspectRecovery: () => ({ status: "passed" }),
        inspectRecoveryBudgets: () => ({ status: "passed" }),
        inspectRecoveryHTTP: () => ({
          status: "passed",
          owned_error_spans: [],
        }),
        async inspectStreams(evidence, collection, secrets) {
          assert(evidence.recovery_window);
          assert.deepEqual(secrets, ["private-canary"]);
          assert(collection.traces.size > 0);
          for (const traceID of collection.traces.keys())
            assert(collection.archivedTraceIDs.has(traceID));
          await Promise.resolve();
          called = true;
          if (mode === "throws") throw new Error("wrong stream ownership");
          if (mode === "missing-claims") return { status: "passed" };
          return { status: mode, owned_error_spans: claims };
        },
      },
    );
    if (mode === "passed") await h.archive();
    else await assert.rejects(h.archive(), AggregateError);
    assert(called, "stream inspector not awaited");
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(
      report.owning_gates.stream.status,
      mode === "passed" ? "passed" : "pending",
    );
    assert.equal(report.owning_gates.cancellation.status, "passed");
    assert.equal(report.strict_trace, "failed");
    if (mode === "passed")
      assert.deepEqual(report.owning_gates.stream.owned_error_spans, claims);
    else assert.equal(report.status, "archive_failed");
    assert(existsSync(join(h.root, "outage-traces", `${id(11)}.json`)));
  });

for (const mode of ["passed", "throws", "pending"])
  test(`complete diagnostic gate ${mode} retains raw failure`, async (t) => {
    let called = false;
    const h = archiveHarness(
      t,
      (s) => {
        withOutageChat(s);
        s.evidence.recovery_window = { status: "passed" };
      },
      undefined,
      undefined,
      {
        inspectRecovery: () => ({ status: "passed", owned_error_spans: [] }),
        inspectRecoveryBudgets: () => ({ status: "passed" }),
        inspectRecoveryHTTP: () => ({
          status: "passed",
          owned_error_spans: [],
        }),
        async inspectDiagnostics(collection, gates, secrets) {
          called = true;
          assert.deepEqual(secrets, ["private-canary"]);
          assert(collection.traces.size > 0);
          assert.equal(gates.stream.status, "passed");
          assert.equal(gates.feed.status, "passed");
          assert.equal(gates.cancellation.owned_error_spans.length, 2);
          if (mode === "throws") throw new Error("unowned source error");
          return { status: mode };
        },
      },
    );
    if (mode === "passed") await h.archive();
    else await assert.rejects(h.archive(), AggregateError);
    assert(called);
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(
      report.diagnostics.status,
      mode === "passed" ? "passed" : "pending",
    );
    assert.equal(report.strict_trace, "failed");
    assert.equal(
      report.status,
      mode === "passed" ? "owning_admission_passed" : "archive_failed",
    );
    assert(existsSync(join(h.root, "outage-traces", `${id(11)}.json`)));
  });

test("outage archive invokes the owning cancellation inspector with actual model and audit observations", async (t) => {
  const h = archiveHarness(t, withOutageChat);
  const result = await h.archive();
  assert.equal(result.owning_gates.cancellation.status, "passed");
  assert.equal(result.owning_gates.authority.status, "passed");
  assert.equal(result.owning_gates.cancellation.trace_id, "a".repeat(32));
  assert.equal(
    result.reports.find((r) => r.trace_id === "a".repeat(32)).settled_read,
    true,
  );
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.status, "raw_closures_archived_owning_admission_pending");
});

for (const [label, change, message] of [
  [
    "wrong actual Run terminal",
    (_s, f) => setTag(f.run, "run.tool_effect_state", "unknown"),
    /tool_effect_state/u,
  ],
  [
    "wrong actual prompt trace",
    (s) => {
      s.evidence.http.find((r) => r.label === "outage-prompt").trace_id = id(1);
    },
    /prompt Trace/u,
  ],
  [
    "missing model completion observation",
    (s) => {
      delete s.evidence.model_cancelled;
    },
    /model observation/u,
  ],
  [
    "detached audit observation",
    (s) => {
      s.evidence.audit = { ...s.evidence.audit, status: 503 };
    },
    /audit observation/u,
  ],
])
  test(`outage archive rejects ${label} but still retains independent raw traces`, async (t) => {
    const h = archiveHarness(t, (s) => {
      const f = withOutageChat(s);
      change(s, f);
    });
    await assert.rejects(h.archive(), (error) => {
      assert(error instanceof AggregateError);
      assert(
        error.errors.some((e) => message.test(e.message)),
        error.message,
      );
      return true;
    });
    for (const traceID of [id(1), "a".repeat(32)])
      assert(existsSync(join(h.root, "outage-traces", `${traceID}.json`)));
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json")),
    );
    assert.equal(report.status, "archive_failed");
    assert.equal(report.owning_gates.cancellation.status, "pending");
  });

test("outage archive uses the actual JWKS HTTP route and retains complete raw closures", async (t) => {
  const h = archiveHarness(t);
  const result = await h.archive();
  assert.equal(result.status, "raw_closures_archived_owning_admission_pending");
  assert.deepEqual(
    result.archived_trace_ids,
    [1, 2, 3, 4, 5, 6, 7, 9, 10, 11].map(id),
  );
  assert.deepEqual(h.searched, [
    "messages",
    "feed",
    "feedAttempts",
    "feed",
    "feedAttempts",
    "feed",
    "feedAttempts",
    "jwks",
    "refresh",
  ]);
});
function successfulFeedSearch(traceID) {
  return {
    traceID,
    processes: { edge: { serviceName: "edge-gateway" } },
    spans: [
      {
        processID: "edge",
        operationName: "HTTP POST identity-service",
        tags: Object.entries({
          "span.kind": "client",
          "http.request.method": "POST",
          "http.response.status_code": 200,
          "server.address": "identity-service",
          "rpc.method": "list_session_revocations",
        }).map(([key, value]) => ({ key, value })),
      },
    ],
  };
}
test("feed SERVER indexing converges after three unchanged incomplete SERVER rounds", async (t) => {
  const h = archiveHarness(t, (s, { serverRounds }) => {
    withOutageChat(s);
    s.found.feedAttempts[0] = successfulFeedSearch(id(9));
    serverRounds.push([], [], []);
  });
  const report = await h.archive();
  assert.equal(report.owning_gates.authority.status, "passed");
  assert.equal(h.searched.filter((n) => n === "feed").length, 6);
  assert.equal(h.searched.filter((n) => n === "feedAttempts").length, 6);
  assert.equal(new Set(h.windows.map((w) => JSON.stringify(w))).size, 1);
  const raw = JSON.parse(
    readFileSync(join(h.root, "outage-trace-search.private.json")),
  );
  assert.equal(raw.feed_server_searches.length, 6);
  assert.equal(raw.feed_attempt_searches.length, 6);
  assert.deepEqual(raw.feed_server_searches.slice(0, 3), [[], [], []]);
  assert.deepEqual(raw.found.feed, [{ traceID: id(9) }]);
});
test("permanently missing successful feed SERVER cannot converge and retains its CLIENT", async (t) => {
  const h = archiveHarness(t, (s) => {
    withOutageChat(s);
    s.found.feed = [{ traceID: id(11) }];
    s.found.feedAttempts[0] = successfulFeedSearch(id(9));
  });
  await assert.rejects(h.archive(), AggregateError);
  assert.equal(h.searched.filter((n) => n === "feed").length, 20);
  assert.equal(h.searched.filter((n) => n === "feedAttempts").length, 20);
  assert(existsSync(join(h.root, "outage-traces", `${id(9)}.json`)));
});
test("changing SERVER inventory cannot reuse CLIENT stability or exceed twenty paired rounds", async (t) => {
  const h = archiveHarness(t, (s, { serverRounds }) => {
    withOutageChat(s);
    serverRounds.push(
      ...Array.from({ length: 20 }, (_, i) =>
        i % 2 ? [{ traceID: id(9) }] : [{ traceID: id(11) }],
      ),
    );
  });
  await assert.rejects(h.archive(), AggregateError);
  assert.equal(h.searched.filter((n) => n === "feed").length, 20);
  assert.equal(h.searched.filter((n) => n === "feedAttempts").length, 20);
  const raw = JSON.parse(
    readFileSync(join(h.root, "outage-trace-search.private.json")),
  );
  assert.equal(raw.feed_server_searches.length, 20);
  for (const traceID of [id(9), id(11)])
    assert(existsSync(join(h.root, "outage-traces", `${traceID}.json`)));
});
test("Gateway attempt search converges after a receiving feed SERVER is indexed first", async (t) => {
  const h = archiveHarness(t, (s, { gatewayRounds }) => {
    withOutageChat(s);
    gatewayRounds.push([{ traceID: id(11) }]);
  });
  const report = await h.archive();
  assert.equal(report.owning_gates.authority.status, "passed");
  assert.equal(h.searched.filter((n) => n === "feedAttempts").length, 4);
  const raw = JSON.parse(
    readFileSync(join(h.root, "outage-trace-search.private.json")),
  );
  assert.equal(raw.feed_attempt_searches.length, 4);
  assert.deepEqual(raw.feed_attempt_searches[0], [{ traceID: id(11) }]);
});
test("permanently incomplete Gateway attempt search retains evidence and fails admission", async (t) => {
  const h = archiveHarness(t, (s) => {
    withOutageChat(s);
    s.found.feedAttempts = [{ traceID: id(11) }];
  });
  await assert.rejects(h.archive(), AggregateError);
  const report = JSON.parse(
    readFileSync(join(h.root, "outage-trace-archive.json")),
  );
  assert.equal(report.owning_gates.authority.status, "pending");
  assert(existsSync(join(h.root, "outage-traces", `${id(9)}.json`)));
});

test("completed outage requires the real authority gate and keeps raw sources after rejection", async (t) => {
  const h = archiveHarness(t, withOutageChat, inspectOutageAuthority);
  await assert.rejects(h.archive(), AggregateError);
  const report = JSON.parse(
    readFileSync(join(h.root, "outage-trace-archive.json")),
  );
  assert.equal(report.owning_gates.cancellation.status, "passed");
  assert.equal(report.owning_gates.authority.status, "pending");
  assert.equal(report.status, "archive_failed");
  assert(existsSync(join(h.root, "outage-traces", `${id(11)}.json`)));
});

test("saturated Gateway search cannot mark authority passed", async (t) => {
  const h = archiveHarness(t, (s) => {
    withOutageChat(s);
    s.found.feedAttempts = Array.from({ length: 500 }, () => ({
      traceID: id(11),
    }));
  });
  await assert.rejects(h.archive(), AggregateError);
  const report = JSON.parse(
    readFileSync(join(h.root, "outage-trace-archive.json")),
  );
  assert.equal(report.owning_gates.authority.status, "pending");
  assert(existsSync(join(h.root, "outage-traces", `${id(11)}.json`)));
});

for (const [label, change, expected] of [
  [
    "foreign search credential",
    (s) => {
      s.found.messages[3].private = "private-canary";
    },
    /secret credential/,
  ],
  [
    "missing cancel inventory",
    (s) => {
      s.found.messages.splice(1, 1);
    },
    /inventory differs/,
  ],
  ["failed feed search", (_s, h) => h.failSearch("feed"), /feed search failed/],
  [
    "failed Gateway attempt search",
    (_s, h) => h.failSearch("feedAttempts"),
    /feedAttempts search failed/,
  ],
  [
    "missing JWKS",
    (s) => {
      s.found.jwks = [];
    },
    /JWKS raw traces missing/,
  ],
  ["one absent closure", (_s, h) => h.missing.add(id(1)), /not exported/],
])
  test(`outage archive preserves independent evidence after ${label}`, async (t) => {
    const h = archiveHarness(t, change);
    await assert.rejects(h.archive(), (error) => {
      assert(error instanceof AggregateError);
      assert(error.errors.some((item) => expected.test(item.message)));
      return true;
    });
    for (const n of [2, 3, 4, 5])
      assert(
        existsSync(join(h.root, "outage-traces", `${id(n)}.json`)),
        `known Trace ${n} was not archived`,
      );
    const report = JSON.parse(
      readFileSync(join(h.root, "outage-trace-archive.json"), "utf8"),
    );
    assert.equal(report.status, "archive_failed");
    assert.equal(report.strict_trace, "failed");
    assert(report.failures.length);
    assert(existsSync(join(h.root, "outage-trace-search.private.json")));
    if (label === "foreign search credential")
      assert(
        readFileSync(
          join(h.root, "outage-trace-search.private.json"),
          "utf8",
        ).includes("private-canary"),
      );
  });
