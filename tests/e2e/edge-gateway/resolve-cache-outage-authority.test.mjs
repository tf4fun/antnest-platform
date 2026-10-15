import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageAuthority } from "./resolve-cache-outage-authority.mjs";
import { authorityFixture } from "./resolve-cache-outage-authority-fixtures.mjs";
import {
  resolvePrefix,
  setTag,
  addResolveRPC,
} from "../observability/gateway-resolution-fixtures.mjs";

const check = (f) => inspectOutageAuthority(f.evidence, f, ["private-canary"]);

test("Bridge authority uses actual UI admission and private ACP initialization without a retired WSS scope", () => {
  const f = authorityFixture(4);
  const before = structuredClone([...f.traces]);
  const result = check(f);
  assert.equal(result.status, "passed");
  assert.deepEqual(
    result.prewarm.map((r) => r.profile),
    ["console", "workspace"],
  );
  assert.equal(Object.hasOwn(result, "original_wss"), false);
  assert.equal(
    result.original_bridge.source_trace_id,
    f.fixtures.workspaceSource.trace.traceID,
  );
  assert.equal(
    result.original_bridge.initialization_span_id,
    f.fixtures.workspaceSource.initialize.spanID,
  );
  assert.equal(result.original_bridge.ui_receiver_span_id, "receiver");
  assert.equal(
    result.original_bridge.conservative_deadline,
    result.prewarm.find((r) => r.profile === "workspace").conservative_deadline,
  );
  assert.equal(result.original_sse.trace_id, f.fixtures.sse.trace.traceID);
  assert(result.remaining_at_restart_ms > 0);
  assert.deepEqual([...f.traces], before);
});

test("historical authority cannot accept Bridge transport metadata", () => {
  const f = authorityFixture();
  f.evidence.transport = "http-sse";
  assert.throws(() => check(f), /revision 4/u);
});

test("Bridge authority cannot carry a retired WSS admission", () => {
  const f = authorityFixture(4);
  f.evidence.wire = authorityFixture().evidence.wire;
  assert.throws(() => check(f), /retired WSS/u);
});

for (const [name, mutate, reason] of [
  [
    "retired state URL",
    (f) => {
      f.evidence.http.find(
        (r) => r.label === "fresh-consumer-agent-ready",
      ).path = "/api/app/agents/agent/state";
    },
    /view/u,
  ],
  [
    "retired WSS transport",
    (f) => {
      f.evidence.transport = "wss";
    },
    /http-sse/u,
  ],
  [
    "direct Gateway-to-ACP chain",
    (f) => {
      f.fixtures.workspaceSource.initialize.references[0].spanID = "upstream";
    },
    /initialization.*UI/u,
  ],
  [
    "different Agent initialization",
    (f) =>
      setTag(
        f.fixtures.workspaceSource.initialize,
        "antnest.agent.id",
        "other",
      ),
    /Agent/u,
  ],
  [
    "missing private initialize",
    (f) => {
      const p = f.fixtures.workspaceSource;
      p.trace.spans = p.trace.spans.filter((s) => s !== p.initialize);
    },
    /initialization/u,
  ],
  [
    "different ACP method",
    (f) =>
      setTag(
        f.fixtures.workspaceSource.initialize,
        "rpc.method",
        "session/list",
      ),
    /initialization/u,
  ],
  [
    "failed private initialize",
    (f) =>
      setTag(
        f.fixtures.workspaceSource.initialize,
        "http.response.status_code",
        403,
      ),
    undefined,
  ],
  [
    "wrong view Agent",
    (f) => {
      f.evidence.http.find(
        (r) => r.label === "fresh-consumer-agent-ready",
      ).body.agentId = "other";
    },
    /Agent/u,
  ],
  [
    "missing source Identity SQL",
    (f) => {
      const p = f.fixtures.workspaceSource;
      p.trace.spans = p.trace.spans.filter((s) => s.spanID !== "sql");
    },
    undefined,
  ],
  [
    "wrong cache origin",
    (f) =>
      setTag(
        f.fixtures.workspaceHit.decision,
        resolvePrefix + "snapshot_age_ms",
        500,
      ),
    /origin/u,
  ],
  [
    "missing archived UI source",
    (f) => f.archivedTraceIDs.delete(f.fixtures.workspaceSource.trace.traceID),
    /archived/u,
  ],
  [
    "expired original workspace authority",
    (f) =>
      setTag(
        f.fixtures.workspaceHit.decision,
        resolvePrefix + "valid_for_ms",
        5000,
      ),
    /authority deadline/u,
  ],
  [
    "expired original SSE authority",
    (f) =>
      setTag(f.fixtures.sse.decision, resolvePrefix + "valid_for_ms", 5000),
    /original SSE/u,
  ],
])
  test(`Bridge authority rejects ${name}`, () => {
    const f = authorityFixture(4);
    mutate(f);
    assert.throws(() => check(f), reason);
  });

test("Bridge SSE later revalidation cannot extend its original authority", () => {
  const f = authorityFixture(4),
    before = check(f),
    p = f.fixtures.sse;
  const later = structuredClone(p.decision);
  later.spanID = "later-revalidation";
  later.startTime = 5010000;
  later.duration = 5000;
  setTag(later, resolvePrefix + "source", "rpc");
  for (const key of ["snapshot_age_ms", "proof_age_ms", "valid_for_ms"])
    setTag(later, resolvePrefix + key, undefined);
  p.trace.spans.push(later);
  p.root.duration = 6000000;
  addResolveRPC(p.trace, "-later", 5011000);
  assert.equal(check(f).conservative_deadline, before.conservative_deadline);
  setTag(p.decision, resolvePrefix + "valid_for_ms", 5000);
  assert.throws(() => check(f), /original SSE/u);
});
for (const surface of ["connection", "sse"]) {
  const revalidate = (f) => {
    const fixture = f.fixtures[surface],
      d = structuredClone(fixture.decision);
    Object.assign(d, {
      spanID: "revalidation",
      startTime: 5010000,
      duration: 5000,
    });
    setTag(d, resolvePrefix + "source", "rpc");
    for (const field of ["snapshot_age_ms", "proof_age_ms", "valid_for_ms"])
      setTag(d, resolvePrefix + field, undefined);
    fixture.trace.spans.push(d);
    fixture.root.duration = 6000000;
    addResolveRPC(fixture.trace, "-later", 5011000);
  };
  test(`${surface} original authority ignores a later successful guard revalidation without renewing budget`, () => {
    const f = authorityFixture(),
      before = check(f);
    revalidate(f);
    const after = check(f);
    assert.equal(after.conservative_deadline, before.conservative_deadline);
    assert.equal(
      after.original_wss.conservative_deadline,
      before.original_wss.conservative_deadline,
    );
    assert.equal(
      after.original_sse.conservative_deadline,
      before.original_sse.conservative_deadline,
    );
  });
  test(`${surface} cannot replace its initial admission with later guard revalidation`, () => {
    const f = authorityFixture();
    revalidate(f);
    f.fixtures[surface].trace.spans = f.fixtures[surface].trace.spans.filter(
      (s) => s !== f.fixtures[surface].decision,
    );
    assert.throws(() => check(f));
  });
}
test("authority rejects different dispatch credentials even without Set-Cookie", () => {
  const f = authorityFixture();
  f.evidence.http.at(-1).credential_scope =
    "33333333-3333-4333-8333-333333333333";
  assert.throws(() => check(f), /credential/u);
});
test("authority rejects incomplete Gateway feed attempt inventory", () => {
  const f = authorityFixture();
  delete f.feedAttemptTraceIDs;
  assert.throws(() => check(f), /attempt inventory/u);
});
test("authority rejects a raw process-owned attempt omitted from search inventory", () => {
  const f = authorityFixture();
  const trace = structuredClone(f.fixtures.feed.trace);
  trace.traceID = "e".repeat(32);
  trace.spans = [trace.spans[0]];
  Object.assign(trace.spans[0], {
    traceID: trace.traceID,
    startTime: 950020,
    duration: 10,
  });
  f.traces.set(trace.traceID, trace);
  f.archivedTraceIDs.add(trace.traceID);
  assert.throws(() => check(f), /attempt inventory/u);
});
test("authority cannot skip a Gateway-only failed feed attempt to select a later empty page", () => {
  const f = authorityFixture();
  const trace = structuredClone(f.fixtures.feed.trace);
  trace.traceID = "e".repeat(32);
  trace.spans = [trace.spans[0]];
  Object.assign(trace.spans[0], {
    traceID: trace.traceID,
    startTime: 950020,
    duration: 10,
  });
  setTag(trace.spans[0], "http.response.status_code", undefined);
  setTag(trace.spans[0], "error", true);
  f.traces.set(trace.traceID, trace);
  f.archivedTraceIDs.add(trace.traceID);
  f.feedAttemptTraceIDs.add(trace.traceID);
  assert.throws(() => check(f), /failed request or SQL/u);
});
test("authority rejects an ambiguous same-profile Resolve origin", () => {
  const f = authorityFixture();
  const trace = structuredClone(f.fixtures.consoleSource.trace);
  trace.traceID = "e".repeat(32);
  for (const s of trace.spans) {
    s.traceID = trace.traceID;
    for (const r of s.references) r.traceID = trace.traceID;
  }
  f.traces.set(trace.traceID, trace);
  f.archivedTraceIDs.add(trace.traceID);
  assert.throws(() => check(f), /ambiguous/u);
});
test("authority requires the preceding feed attempt rather than assuming first poll", () => {
  const f = authorityFixture(),
    id = f.fixtures.previousFeed.trace.traceID;
  f.traces.delete(id);
  f.archivedTraceIDs.delete(id);
  f.feedAttemptTraceIDs.delete(id);
  assert.throws(() => check(f), /preceding/u);
});
test("one proof instant must follow the preceding attempt and precede the current CLIENT", () => {
  const f = authorityFixture();
  f.fixtures.previousFeed.trace.spans[0].duration = 100060;
  for (const key of ["consoleHit", "workspaceHit", "list"])
    f.fixtures[key].decision.duration = 100;
  assert.throws(() => check(f), /serial|proof/u);
});
function backgroundRefreshFixture() {
  const f = authorityFixture(),
    trace = structuredClone(f.fixtures.consoleSource.trace);
  trace.traceID = "e".repeat(32);
  trace.spans = trace.spans.filter((s) =>
    ["root", "resolve-client", "resolve-server", "sql"].includes(s.spanID),
  );
  for (const s of trace.spans) {
    s.traceID = trace.traceID;
    for (const r of s.references) r.traceID = trace.traceID;
  }
  const root = trace.spans[0];
  root.startTime = 1010000;
  root.operationName = "gateway.identity.resolve.refresh";
  setTag(root, "span.kind", "internal");
  setTag(root, resolvePrefix + "profile", "console");
  root.references = [
    {
      refType: "FOLLOWS_FROM",
      traceID: f.fixtures.consoleHit.trace.traceID,
      spanID: "decision",
    },
  ];
  // A separate earlier trigger leaves the observed hit unchanged.
  const trigger = structuredClone(f.fixtures.consoleHit.trace);
  trigger.traceID = "d".repeat(32);
  for (const s of trigger.spans) {
    s.traceID = trigger.traceID;
    s.startTime -= 591000;
    for (const r of s.references) r.traceID = trigger.traceID;
  }
  root.references[0].traceID = trigger.traceID;
  f.traces.set(trigger.traceID, trigger);
  f.archivedTraceIDs.add(trigger.traceID);
  f.traces.set(trace.traceID, trace);
  f.archivedTraceIDs.add(trace.traceID);
  return { f, trace };
}
test("background Resolve minting also participates in origin ambiguity", () => {
  assert.throws(() => check(backgroundRefreshFixture().f), /ambiguous/u);
});
test("later background minting cannot make an earlier original snapshot ambiguous", () => {
  const { f, trace } = backgroundRefreshFixture();
  for (const s of trace.spans) s.startTime += 2000;
  assert.equal(check(f).status, "passed");
});
test("SSE admission keeps final lifecycle ERROR raw and strict failure for its separate owner", () => {
  const f = authorityFixture();
  setTag(f.fixtures.sse.root, "error", true);
  setTag(f.fixtures.sse.upstream, "error", true);
  setTag(
    f.fixtures.sse.trace.spans.find((s) => s.spanID === "receiver"),
    "error",
    true,
  );
  const before = JSON.stringify(f.fixtures.sse.trace),
    report = check(f);
  assert.equal(report.status, "passed");
  assert.equal(report.strict_trace, "failed");
  assert.equal(report.error_spans, 3);
  assert.equal(JSON.stringify(f.fixtures.sse.trace), before);
});
test("original CCT and three warm profiles cover the whole stop using send-time bounds", () => {
  const f = authorityFixture(),
    before = JSON.stringify([...f.traces]);
  const report = check(f);
  assert.equal(report.status, "passed");
  assert.equal(report.prewarm.length, 3);
  assert.equal(report.conservative_deadline, 10950);
  assert.equal(report.remaining_at_restart_ms, 4250);
  assert.equal(report.original_wss.conservative_deadline, 11010.5);
  assert.equal(report.original_sse.conservative_deadline, 11000.5);
  assert.equal(report.feed_trace_ids[0], f.fixtures.feed.trace.traceID);
  assert.equal(JSON.stringify([...f.traces]), before);
});

for (const [label, change] of [
  [
    "foreign SSE credential",
    (f) => {
      f.evidence.stream.credential_scope =
        "33333333-3333-4333-8333-333333333333";
    },
  ],
  [
    "missing SSE observation",
    (f) => {
      delete f.evidence.stream;
    },
  ],
  [
    "wrong SSE path",
    (f) => {
      f.evidence.stream.path = "/another";
    },
  ],
  [
    "wrong SSE profile",
    (f) => {
      setTag(f.fixtures.sse.decision, resolvePrefix + "profile", "console");
    },
  ],
  [
    "SSE from later snapshot",
    (f) => {
      setTag(f.fixtures.sse.decision, resolvePrefix + "snapshot_age_ms", 1);
    },
  ],
  [
    "original SSE expired before restart",
    (f) => {
      setTag(f.fixtures.sse.decision, resolvePrefix + "valid_for_ms", 4000);
    },
  ],
  [
    "deadline equality",
    (f) => {
      f.evidence.identity.restart_started_at = 10950;
    },
  ],
  [
    "receive time extending send budget",
    (f) => {
      f.evidence.identity.restart_started_at = 10951;
    },
  ],
  [
    "late prewarm response",
    (f) => {
      f.evidence.http.find((r) => r.label === "warm-console-audit").at = 6701;
    },
  ],
  [
    "missing observation",
    (f) => {
      f.evidence.http.pop();
    },
  ],
  [
    "different Agent path",
    (f) => {
      f.evidence.http.at(-1).path =
        "/api/app/workspace/v1/agents/another/sessions/session/view";
    },
  ],
  [
    "different profile",
    (f) => {
      setTag(
        f.fixtures.consoleHit.decision,
        resolvePrefix + "profile",
        "workspace",
      );
    },
  ],
  [
    "failed cache decision",
    (f) => {
      setTag(
        f.fixtures.consoleHit.decision,
        resolvePrefix + "outcome",
        "unavailable",
      );
    },
  ],
  [
    "missing proof age",
    (f) => {
      setTag(
        f.fixtures.consoleHit.decision,
        resolvePrefix + "proof_age_ms",
        undefined,
      );
    },
  ],
  [
    "expired feed proof",
    (f) => {
      setTag(
        f.fixtures.consoleHit.decision,
        resolvePrefix + "proof_age_ms",
        10000,
      );
    },
  ],
  [
    "reset snapshot origin",
    (f) => {
      setTag(
        f.fixtures.consoleHit.decision,
        resolvePrefix + "snapshot_age_ms",
        1,
      );
    },
  ],
  [
    "later CCT substituted for original handshake",
    (f) => {
      setTag(
        f.fixtures.initialize.decision,
        resolvePrefix + "snapshot_age_ms",
        1,
      );
    },
  ],
  [
    "foreign prep connection",
    (f) => {
      f.fixtures.initialize.root.references[0].traceID = "f".repeat(32);
    },
  ],
  [
    "wrong handshake root link",
    (f) => {
      f.fixtures.initialize.root.references[0].spanID = "upstream";
    },
  ],
  [
    "wrong ACP request ID",
    (f) => {
      setTag(
        f.fixtures.list.trace.spans.find((s) => s.spanID === "request"),
        "antnest.request.id",
        "foreign",
      );
    },
  ],
  [
    "wrong ACP Agent",
    (f) => {
      setTag(
        f.fixtures.list.trace.spans.find((s) => s.spanID === "request"),
        "antnest.agent.id",
        "foreign",
      );
    },
  ],
  [
    "failed actual wire response",
    (f) => {
      f.evidence.wire.frames[3].raw = JSON.stringify({
        id: 1,
        error: { code: -32000 },
      });
    },
  ],
  [
    "credential renewal during prewarm",
    (f) => {
      f.evidence.http.at(-1).set_cookie_count = 2;
    },
  ],
  [
    "unarchived minting source",
    (f) => {
      f.archivedTraceIDs.delete(f.fixtures.connection.trace.traceID);
    },
  ],
  [
    "failed Resolve SQL under HTTP 200",
    (f) => {
      setTag(
        f.fixtures.consoleSource.trace.spans.find((s) => s.spanID === "sql"),
        "error",
        true,
      );
    },
  ],
  [
    "failed receiving service",
    (f) => {
      setTag(
        f.fixtures.consoleHit.trace.spans.find((s) => s.spanID === "receiver"),
        "http.response.status_code",
        503,
      );
    },
  ],
  [
    "nonempty terminal feed page",
    (f) => {
      setTag(f.fixtures.feed.trace.spans[2], "pgx.rows_affected", 1);
    },
  ],
  [
    "full feed page",
    (f) => {
      setTag(f.fixtures.feed.trace.spans[2], "pgx.rows_affected", 500);
    },
  ],
  [
    "wrong feed SQL",
    (f) => {
      setTag(f.fixtures.feed.trace.spans[2], "db.query.text", "SELECT 1");
    },
  ],
  [
    "missing feed SQL",
    (f) => {
      f.fixtures.feed.trace.spans.pop();
    },
  ],
  [
    "failed feed SQL",
    (f) => {
      setTag(f.fixtures.feed.trace.spans[2], "error", true);
    },
  ],
  [
    "proof anchored at feed completion",
    (f) => {
      for (const s of f.fixtures.feed.trace.spans) s.startTime -= 2000;
    },
  ],
  [
    "feed completed after admission",
    (f) => {
      f.fixtures.feed.trace.spans[0].duration = 1000000;
    },
  ],
  [
    "missing raw parent",
    (f) => {
      f.fixtures.consoleHit.trace.spans.find(
        (s) => s.spanID === "receiver",
      ).references[0].spanID = "missing";
    },
  ],
  [
    "secret in retained closure",
    (f) => {
      f.fixtures.consoleHit.trace.warnings = ["private-canary"];
    },
  ],
])
  test(`outage authority rejects ${label}`, () => {
    const f = authorityFixture();
    change(f);
    assert.throws(() => check(f));
  });
