import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectOrganizationRead,
  inspectEmptySessionFeed,
  assertOrganizationTimeline,
  inspectOrganizationRefresh,
  assertDisplayFeedCoverage,
  selectSessionFeedRequests,
} from "./organization-freshness.mjs";
import {
  resolutionFixture,
  setTag,
  sharedResolutionFixture,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

function displayFixture(surface = "bootstrap", source = "cache") {
  const f = resolutionFixture(source);
  const route = {
    session: "/api/session",
    bootstrap: "/api/app/workspace/v1/{path...}",
    ssr: "/workspace/{path...}",
  }[surface];
  setTag(f.root, "http.route", route);
  setTag(
    f.decision,
    "antnest.identity.resolve.profile",
    surface === "session" ? "session" : "workspace",
  );
  if (surface === "session")
    f.trace.spans = f.trace.spans.filter((s) => s !== f.upstream);
  else {
    setTag(f.upstream, "http.response.status_code", 200);
    setTag(f.upstream, "server.address", "agent-ui");
    f.trace.processes.ui = { serviceName: "agent-ui" };
    f.trace.spans.push({
      ...structuredClone(f.upstream),
      spanID: "ui-server",
      processID: "ui",
      operationName: "agent_ui.http.request",
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: f.upstream.spanID,
        },
      ],
      tags: fields({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route":
          surface === "ssr" ? "/workspace/" : "/api/app/workspace/v1/*",
        "http.response.status_code": 200,
      }),
    });
  }
  return {
    ...f,
    expected: { traceID: f.trace.traceID, surface, ttlMS: 10000 },
  };
}

test("session, bootstrap and SSR require their real Gateway admission and Node forwarding", () => {
  for (const surface of ["session", "bootstrap", "ssr"])
    for (const source of ["rpc", "cache"]) {
      const f = displayFixture(surface, source);
      const result = inspectOrganizationRead(f.trace, f.expected, [], f);
      assert.equal(result.source, source);
      assert.equal(result.surface, surface);
      assert.equal(result.root_started_us, f.root.startTime);
      if (source === "cache") {
        assert.equal(result.snapshot_age_ms, 2000.125);
        assert.equal(result.proof_age_ms, 125.5);
      }
    }
});

for (const [name, mutate] of [
  ["wrong route", (f) => setTag(f.root, "http.route", "/api/admin/account")],
  [
    "wrong profile",
    (f) => setTag(f.decision, "antnest.identity.resolve.profile", "console"),
  ],
  [
    "failed forwarding",
    (f) => setTag(f.upstream, "http.response.status_code", 503),
  ],
  [
    "missing Node receiver",
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "ui-server");
    },
  ],
  [
    "wrong Node route",
    (f) => setTag(f.trace.spans.at(-1), "http.route", "/status"),
  ],
  [
    "hidden source failure",
    (f) =>
      setTag(
        f.trace.spans.find((s) => s.spanID === "sql"),
        "otel.status_code",
        "ERROR",
      ),
  ],
  [
    "expired snapshot",
    (f) => {
      setTag(f.decision, "antnest.identity.resolve.source", "cache");
      setTag(f.decision, "antnest.identity.resolve.snapshot_age_ms", 10000);
      setTag(f.decision, "antnest.identity.resolve.proof_age_ms", 10);
      setTag(f.decision, "antnest.identity.resolve.valid_for_ms", 1);
    },
  ],
])
  test(`display trace rejects ${name}`, () => {
    const f = displayFixture("bootstrap", "rpc");
    mutate(f);
    assert.throws(() => inspectOrganizationRead(f.trace, f.expected, [], f));
  });

test("raw clock warnings remain a strict failure without discarding valid business evidence", () => {
  const f = displayFixture();
  f.trace.warnings = ["clock skew adjustment"];
  assert.equal(
    inspectOrganizationRead(f.trace, f.expected, [], f).strict_trace,
    "failed",
  );
});

function feedFixture() {
  const f = resolutionFixture("rpc");
  const client = f.trace.spans.find((s) => s.spanID === "resolve-client");
  const server = f.trace.spans.find((s) => s.spanID === "resolve-server");
  const sql = f.trace.spans.find((s) => s.spanID === "sql");
  client.references = [];
  setTag(client, "rpc.method", "list_session_revocations");
  setTag(server, "http.route", "/rpc/identity/list-session-revocations");
  setTag(server, "rpc.method", "list_session_revocations");
  setTag(
    sql,
    "db.query.text",
    "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2",
  );
  setTag(sql, "pgx.rows_affected", 0);
  f.trace.spans = [client, server, sql];
  return { trace: f.trace, client, server, sql };
}

test("feed search selects the exact Identity SERVER independent of CLIENT-first ordering", () => {
  for (const reorder of [false, true]) {
    const f = feedFixture();
    if (reorder) f.trace.spans.reverse();
    assert.deepEqual(
      selectSessionFeedRequests(
        [f.trace],
        f.client.startTime,
        f.client.startTime,
      ),
      [{ traceID: f.trace.traceID }],
    );
    assert.deepEqual(
      selectSessionFeedRequests(
        [f.trace],
        f.client.startTime + 1,
        f.client.startTime + 2,
      ),
      [],
    );
  }
});

for (const [name, mutate] of [
  [
    "missing CLIENT",
    (f) => {
      f.trace.spans = f.trace.spans.filter((span) => span !== f.client);
    },
  ],
  [
    "duplicate SERVER",
    (f) =>
      f.trace.spans.push({ ...structuredClone(f.server), spanID: "duplicate" }),
  ],
  [
    "foreign service",
    (f) => {
      f.trace.processes[f.server.processID].serviceName = "foreign";
    },
  ],
  ["wrong route", (f) => setTag(f.server, "http.route", "/other")],
  ["wrong method", (f) => setTag(f.server, "http.request.method", "GET")],
  ["wrong RPC", (f) => setTag(f.server, "rpc.method", "resolve")],
  [
    "foreign CLIENT",
    (f) => {
      f.trace.processes[f.client.processID].serviceName = "foreign";
    },
  ],
  ["wrong CLIENT RPC", (f) => setTag(f.client, "rpc.method", "resolve")],
])
  test(`feed selection rejects ${name}`, () => {
    const f = feedFixture();
    mutate(f);
    assert.throws(() =>
      selectSessionFeedRequests([f.trace], 0, Number.MAX_SAFE_INTEGER),
    );
  });

test("healthy empty feed evidence comes from the actual process-owned RPC and zero-row SELECT", () => {
  const f = feedFixture();
  const result = inspectEmptySessionFeed(
    f.trace,
    { traceID: f.trace.traceID },
    [],
  );
  assert.equal(result.rows, 0);
  assert.equal(result.started_us, f.client.startTime);
  assert.equal(result.completed_us, f.client.startTime + f.client.duration);
});

for (const [name, mutate] of [
  ["nonempty page", (f) => setTag(f.sql, "pgx.rows_affected", 1)],
  ["missing row count", (f) => setTag(f.sql, "pgx.rows_affected", undefined)],
  ["wrong table", (f) => setTag(f.sql, "db.query.text", "SELECT $1")],
  ["failed RPC", (f) => setTag(f.server, "http.response.status_code", 503)],
  ["SQL failure", (f) => setTag(f.sql, "otel.status_code", "ERROR")],
  [
    "detached SQL",
    (f) => {
      f.sql.references = [];
    },
  ],
])
  test(`empty-feed evidence rejects ${name}`, () => {
    const f = feedFixture();
    mutate(f);
    assert.throws(() =>
      inspectEmptySessionFeed(f.trace, { traceID: f.trace.traceID }, []),
    );
  });

function timeline() {
  const result = {
    ttlMS: 10000,
    renameStartedMS: 200,
    renameCommittedMS: 300,
    reads: [],
    resolutions: [],
  };
  let id = 0;
  const add = (surface, mode, phase, startedMS, snapshot, source, age) => {
    const traceID = (++id).toString(16).padStart(32, "0");
    result.reads.push({
      surface,
      mode,
      phase,
      startedMS,
      completedMS: startedMS + 10,
      traceID,
      snapshot,
    });
    result.resolutions.push({
      trace_id: traceID,
      surface,
      source,
      root_started_us: startedMS * 1000,
      root_completed_us: (startedMS + 10) * 1000,
      decision_started_us: startedMS * 1000,
      decision_completed_us: (startedMS + 1) * 1000,
      ...(source === "rpc"
        ? { rpc_client_started_us: startedMS * 1000 + 1000 }
        : {}),
      ...(source === "cache"
        ? { snapshot_age_ms: age, proof_age_ms: 5, valid_for_ms: 10000 - age }
        : {}),
    });
  };
  for (const surface of ["session", "bootstrap", "ssr"])
    for (const mode of ["continuous", "expiry"]) {
      add(surface, mode, "warm", 0, "original", "rpc");
      add(surface, mode, "before-rename", 50, "original", "cache", 50);
      add(surface, mode, "before-rename", 100, "original", "cache", 100);
      if (mode === "continuous") {
        add(surface, mode, "after-rename", 400, "original", "cache", 400);
        add(surface, mode, "after-rename", 5500, "original", "cache", 5500);
        add(surface, mode, "after-rename", 6500, "renamed", "cache", 1000);
      }
      add(
        surface,
        mode,
        "expired",
        10400,
        "renamed",
        mode === "expiry" ? "rpc" : "cache",
        4900,
      );
    }
  return result;
}

test("rename admission permits half-TTL refresh and reports next-read plus response latency", () => {
  const result = assertOrganizationTimeline(timeline());
  assert.equal(result.surfaces.length, 6);
  for (const item of result.surfaces) {
    assert.equal(item.expiry_read_delay_ms, 100);
    assert.equal(item.expiry_response_latency_ms, 10);
    assert.equal(item.expiry_visible_after_commit_ms, 10110);
  }
});

for (const [name, mutate] of [
  [
    "missing surface",
    (f) => {
      f.reads = f.reads.filter((r) => r.surface !== "ssr");
    },
  ],
  [
    "stale post-expiry result",
    (f) => {
      f.reads.find((r) => r.phase === "expired").snapshot = "original";
    },
  ],
  [
    "no actual hits",
    (f) => {
      f.resolutions
        .filter((r) => r.source === "cache")
        .forEach((r) => {
          r.source = "rpc";
        });
    },
  ],
  [
    "quiet scope refreshed early",
    (f) => {
      f.reads.find(
        (r) => r.mode === "expiry" && r.phase === "before-rename",
      ).startedMS = 6000;
    },
  ],
  [
    "cache hit renewed old snapshot",
    (f) => {
      f.resolutions.find((r) => r.snapshot_age_ms === 5500).snapshot_age_ms =
        10;
    },
  ],
  [
    "expired read still used old entry",
    (f) => {
      const r = f.reads.find(
        (r) => r.mode === "expiry" && r.phase === "expired",
      );
      f.resolutions.find((s) => s.trace_id === r.traceID).source = "cache";
    },
  ],
  [
    "duplicate trace identity",
    (f) => {
      f.reads[1].traceID = f.reads[0].traceID;
    },
  ],
  [
    "missing source evidence",
    (f) => {
      f.resolutions.pop();
    },
  ],
])
  test(`rename admission rejects ${name}`, () => {
    const f = timeline();
    mutate(f);
    assert.throws(() => assertOrganizationTimeline(f));
  });

test("an old read admitted before the deadline may finish after it", () => {
  const f = timeline();
  const r = f.reads.find(
    (r) =>
      r.mode === "continuous" &&
      r.phase === "after-rename" &&
      r.startedMS === 5500,
  );
  r.completedMS = 10350;
  // The next read on this same sequential scope follows completion.
  const later = f.reads.find(
    (s) => s.surface === r.surface && s.mode === r.mode && s.startedMS === 6500,
  );
  later.startedMS = 10360;
  later.completedMS = 10370;
  assert.doesNotThrow(() => assertOrganizationTimeline(f));
});

test("all old cache ages cannot drift together within a wider warm response", () => {
  const f = timeline();
  for (const read of f.reads.filter((r) => r.snapshot === "original")) {
    const resolution = f.resolutions.find((r) => r.trace_id === read.traceID);
    if (resolution.source === "cache") resolution.snapshot_age_ms -= 5;
  }
  assert.throws(() => assertOrganizationTimeline(f), /renewed/);
});

test("a refresh must own real Resolve work and link the exact observed display hit", () => {
  const f = sharedResolutionFixture(true);
  const trigger = f.traces.get("c".repeat(32));
  const decision = trigger.spans.find((s) => s.spanID === "decision");
  setTag(decision, "antnest.identity.resolve.snapshot_age_ms", 5500);
  setTag(decision, "antnest.identity.resolve.valid_for_ms", 4500);
  const expected = {
    traceID: f.origin.trace.traceID,
    profile: "workspace",
    triggerTraceID: trigger.traceID,
    triggerDecisionID: decision.spanID,
    ttlMS: 10000,
  };
  assert.equal(
    inspectOrganizationRefresh(f.origin.trace, expected, [], f)
      .trigger_trace_id,
    trigger.traceID,
  );
  assert.throws(() =>
    inspectOrganizationRefresh(
      f.origin.trace,
      { ...expected, triggerDecisionID: "other" },
      [],
      f,
    ),
  );
  const missingSQL = structuredClone(f);
  missingSQL.origin.trace.spans = missingSQL.origin.trace.spans.filter(
    (s) => s.spanID !== "sql",
  );
  missingSQL.traces.set(
    missingSQL.origin.trace.traceID,
    missingSQL.origin.trace,
  );
  assert.throws(
    () =>
      inspectOrganizationRefresh(
        missingSQL.origin.trace,
        expected,
        [],
        missingSQL,
      ),
    /zero PostgreSQL/,
  );
  setTag(
    f.origin.trace.spans.find((s) => s.spanID === "sql"),
    "error",
    true,
  );
  assert.throws(() =>
    inspectOrganizationRefresh(f.origin.trace, expected, [], f),
  );
});

test("feed coverage requires observed empty RPCs and advancing proof through the read window", () => {
  const hits = [1000, 3000, 6000, 11000].map((ms) => ({
    source: "cache",
    decision_started_us: ms * 1000,
    decision_completed_us: ms * 1000 + 10,
    proof_age_ms: 100,
  }));
  const feeds = Array.from({ length: 12 }, (_, index) => ({
    rows: 0,
    started_us: index * 1000000 + 900000,
    completed_us: index * 1000000 + 901000,
  }));
  assert.equal(assertDisplayFeedCoverage(hits, feeds, 10000).empty_pages, 12);
  assert.throws(() =>
    assertDisplayFeedCoverage(hits, feeds.slice(0, 3), 10000),
  );
  assert.throws(() =>
    assertDisplayFeedCoverage(
      hits,
      feeds.filter((_, i) => i < 3 || i > 7),
      10000,
    ),
  );
  assert.throws(() =>
    assertDisplayFeedCoverage(
      hits.map((r) => ({ ...r, proof_age_ms: r.decision_started_us / 1000 })),
      feeds,
      10000,
    ),
  );
});
