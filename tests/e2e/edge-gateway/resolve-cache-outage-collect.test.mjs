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
      jwks: [{ traceID: id(10) }],
      refresh: [],
    },
  };
}
test("outage raw scope includes HTTP/SSE, both actual WSS connections, model origins, feed and JWKS", () => {
  const { evidence, found } = sample();
  assert.deepEqual(
    outageTraceSelection(evidence, found),
    [1, 2, 3, 4, 5, 6, 7, 9, 10].map(id),
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

function archiveHarness(t, change = () => {}) {
  const fixture = sample();
  fixture.evidence.observed_at_ms = Date.now() - 1000;
  const root = mkdtempSync(join(temporaryStorageRoot(), "outage-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = new Set(),
    searched = [];
  let searchFailure;
  change(fixture, { missing, failSearch: (name) => (searchFailure = name) });
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
        wait: async () => {},
        search: async (_base, query) => {
          const tags = JSON.parse(query.get("tags"));
          const name = query.get("operation")
            ? "refresh"
            : query.get("service") === "edge-gateway"
              ? "messages"
              : tags["rpc.method"] === "list_session_revocations"
                ? "feed"
                : "jwks";
          searched.push(name);
          if (name === "jwks")
            assert.deepEqual(tags, {
              "http.route": "/rpc/identity/jwks",
              "http.request.method": "GET",
              "span.kind": "server",
            });
          if (name === searchFailure) throw new Error(`${name} search failed`);
          return fixture.found[name];
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
  return { root, archive, searched };
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

test("outage archive invokes the owning cancellation inspector with actual model and audit observations", async (t) => {
  const h = archiveHarness(t, withOutageChat);
  const result = await h.archive();
  assert.equal(result.owning_gates.cancellation.status, "passed");
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
    [1, 2, 3, 4, 5, 6, 7, 9, 10].map(id),
  );
  assert.deepEqual(h.searched, ["messages", "feed", "jwks", "refresh"]);
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
