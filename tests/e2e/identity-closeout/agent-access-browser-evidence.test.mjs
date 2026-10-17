import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeSessionCauseFixture,
  moveSessionTrace,
} from "./bridge-session-cause-fixtures.mjs";
import { sessionTraceBase } from "./bridge-session-trace-fixtures.mjs";
import { offboardingFixture } from "./offboarding-trace-fixture.mjs";
import { inspectOffboardingTrace } from "./offboarding-evidence.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { failureDiagnostic } from "./session-rejection-trace-fixtures.mjs";

const url = new URL("./agent-access-browser-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function inspect(f) {
  assert.equal(
    typeof implementation.inspectMembershipBrowserClosure,
    "function",
  );
  return implementation.inspectMembershipBrowserClosure(
    f.trace,
    f.expected,
    [],
    f.collection,
  );
}
function fixture(normal = true, terminal = !normal) {
  const f = bridgeSessionCauseFixture("revoked", { terminal });
  f.expected.principal.membership_id = "member-b";
  const raw = offboardingFixture();
  raw.trace = JSON.parse(
    JSON.stringify(raw.trace).replaceAll("agent-test", "agent-1"),
  );
  raw.expected.agentID = "agent-1";
  moveSessionTrace(
    raw.trace,
    f.expected.cause.traceID,
    (sessionTraceBase + 1200) * 1000,
  );
  raw.expected.sourceID = raw.trace.traceID;
  const root = raw.trace.spans.find((s) => s.spanID === "gateway");
  const console = raw.trace.spans.find((s) => s.spanID === "console");
  const identity = raw.trace.spans.find((s) => s.spanID === "controller");
  setTag(root, "http.response.status_code", 200);
  setTag(
    console,
    "http.route",
    "/api/admin/directory/memberships/{membership_id}",
  );
  setTag(console, "http.response.status_code", 200);
  setTag(identity, "http.route", "/rpc/identity/update-membership");
  setTag(identity, "rpc.method", "update_membership");
  for (const p of Object.values(raw.trace.processes)) {
    const other = Object.values(f.trace.processes).find(
      (o) => o.serviceName === p.serviceName,
    );
    if (other) p.tags = structuredClone(other.tags);
  }
  f.collection.traces.set(raw.trace.traceID, raw.trace);
  Object.assign(f.expected.cause, {
    kind: "membership_deactivated",
    path: "/api/admin/directory/memberships/member-b",
    method: "POST",
    status: 200,
    actor: {
      organization_id: "org",
      user_id: "admin-b",
      organization_role: "admin",
      system_role: "user",
    },
    target: structuredClone(f.expected.principal),
    body: { membership: { id: "member-b", user_id: "user", active: false } },
  });
  delete f.expected.cause.principal;
  delete f.expected.cause.credentialScope;
  f.expected.offboarding = inspectOffboardingTrace(
    [raw.trace],
    raw.expected,
    [],
  );
  if (normal) {
    for (const span of [f.root, f.upstream]) {
      span.tags = span.tags.filter(
        ({ key }) => !/^(error|otel\.status|antnest\.error)/u.test(key),
      );
      span.logs = [];
    }
    f.expected.closure.kind = "remote-end";
    f.ui.logs = [
      {
        timestamp: f.ui.startTime + f.ui.duration,
        fields: Object.entries({
          event: "antnest.stream.termination",
          reason: "access_denied",
          source: "agent-execution-state",
          "antnest.organization.id": "org",
          "antnest.principal.id": "user",
          "antnest.agent.id": "agent-1",
        }).map(([key, value]) => ({ key, value })),
      },
    ];
  }
  return { ...f, raw, identity, mutationRoot: root };
}

function feedFixture(typedCause = true) {
  const f = fixture(false, false);
  f.feed = {
    timestamp: f.upstream.startTime + f.upstream.duration - 1000,
    fields: Object.entries({
      event: "antnest.stream.termination",
      source: "identity-session-feed",
      reason: "session_revoked",
      "antnest.revocation.reason": "membership_deactivated",
      "antnest.revocation.sequence": 23,
      "antnest.revocation.trace_id": f.raw.trace.traceID,
      "antnest.revocation.span_id": f.identity.spanID,
      "antnest.organization.id": "org",
      "antnest.principal.id": "user",
      "antnest.membership.id": "member-b",
      "antnest.agent.id": "agent-1",
    }).map(([key, value]) => ({ key, value })),
  };
  f.root.logs.push(f.feed);
  if (typedCause)
    f.upstream.logs[0].fields.find(
      ({ key }) => key === "antnest.error.cause_types",
    ).value = '["*browserstream.feedTerminationCause","*errors.errorString"]';
  return f;
}

for (const typed of [false, true])
  test(`actual Membership feed termination retains the original errors (typed cause: ${typed})`, () => {
    const f = feedFixture(typed),
      before = structuredClone([...f.collection.traces]);
    const report = inspect(f);
    assert.equal(report.authorizationCauseVerified, true);
    assert.equal(report.cause_proof.feed_sequence, 23);
    assert.equal(report.cause_proof.feed_source_span_id, f.identity.spanID);
    assert.deepEqual([...f.collection.traces], before);
  });

for (const [name, mutate] of [
  [
    "missing feed",
    (f) => {
      f.root.logs.pop();
    },
  ],
  [
    "duplicate feed",
    (f) => {
      f.root.logs.push(structuredClone(f.feed));
    },
  ],
  [
    "foreign mutation",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.trace_id").value =
        "a".repeat(32);
    },
  ],
  [
    "wrong mutation ancestor",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.span_id").value =
        f.mutationRoot.spanID;
    },
  ],
  [
    "missing source",
    (f) => {
      f.feed.fields = f.feed.fields.filter(
        (v) => v.key !== "antnest.revocation.span_id",
      );
    },
  ],
  [
    "unknown reason",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.reason").value =
        "unknown";
    },
  ],
  [
    "foreign membership",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.membership.id").value =
        "foreign";
    },
  ],
  [
    "foreign organization",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.organization.id").value =
        "foreign";
    },
  ],
  [
    "foreign user",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.principal.id").value =
        "foreign";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.agent.id").value = "foreign";
    },
  ],
  [
    "invalid sequence",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.sequence").value =
        0;
    },
  ],
  [
    "early event",
    (f) => {
      f.feed.timestamp = f.root.startTime;
    },
  ],
  [
    "feed before same-process mutation",
    (f) => {
      f.feed.timestamp = f.mutationRoot.startTime - 1;
    },
  ],
  [
    "late event",
    (f) => {
      f.feed.timestamp = f.root.startTime + f.root.duration + 1;
    },
  ],
  [
    "feed after upstream read failure",
    (f) => {
      f.feed.timestamp = f.upstream.logs[0].timestamp + 1;
    },
  ],
  [
    "extra payload",
    (f) => {
      f.feed.fields.push({ key: "private.sid", value: "must-not-export" });
    },
  ],
  [
    "unrelated error cause",
    (f) => {
      f.upstream.logs[0].fields.find(
        (v) => v.key === "antnest.error.cause_types",
      ).value = '["*net.OpError"]';
    },
  ],
])
  test("Membership feed witness rejects " + name, () => {
    const f = feedFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

function with403(f) {
  const trace = structuredClone(f.trace);
  const root = trace.spans.find((s) => s.spanID === f.root.spanID);
  const upstream = trace.spans.find((s) => s.spanID === f.upstream.spanID);
  const ui = trace.spans.find((s) => s.spanID === f.ui.spanID);
  root.duration = 200000;
  upstream.duration = 150000;
  ui.duration = 100000;
  for (const span of [root, upstream, ui]) {
    span.logs = [];
    setTag(span, "http.request.method", "POST");
    setTag(span, "http.response.status_code", 403);
  }
  upstream.operationName = "HTTP POST agent-ui";
  failureDiagnostic(upstream, "403", "HTTP status 403");
  trace.processes.acp = {
    serviceName: "agent-acp-service",
    tags: Object.entries({
      "host.name": "acp-host",
      "process.pid": 3,
      "service.instance.id": "acp-instance",
      "telemetry.sdk.language": "nodejs",
    }).map(([key, value]) => ({ key, value })),
  };
  const add = (
    spanID,
    operationName,
    parent,
    start,
    duration,
    tags,
    logs = [],
  ) => {
    const span = {
      traceID: trace.traceID,
      spanID,
      processID: "acp",
      operationName,
      startTime: ui.startTime + start,
      duration,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      logs,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
      ],
    };
    trace.spans.push(span);
    return span;
  };
  const server = add("execution", "HTTP GET unmatched", ui, 1000, 50000, {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "unmatched",
    "http.response.status_code": 403,
    "antnest.listener": "workspace",
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": "read_workspace_execution",
    "error.type": "DomainError",
    "antnest.operation.phase": "workspace.bridge_observation",
    "antnest.outcome": "rejected",
    "antnest.error.code": "access_denied",
    "error.code": "access_denied",
  });
  server.logs = [
    {
      timestamp: server.startTime + 40000,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": "workspace.bridge_observation",
        "antnest.error.type": "DomainError",
        "antnest.error.code": "access_denied",
        "antnest.error.message": "Agent access was denied",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          {
            type: "DomainError",
            code: "access_denied",
            message: "Agent access was denied",
          },
        ]),
        "antnest.operation.phase": "workspace.bridge_observation",
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  const ready = add("ready", "postgres.ready", server, 2000, 4000, {
    "span.kind": "internal",
    "db.system.name": "postgresql",
  });
  const sql = add("readiness-query", "SELECT", ready, 3000, 1000, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.namespace": "antnest_agent_acp",
    "db.query.text": "SELECT 1",
  });
  moveSessionTrace(
    trace,
    f.expected.denial.traceID,
    (sessionTraceBase + 3350) * 1000,
  );
  Object.assign(f.expected.denial, {
    status: 403,
    code: "access_denied",
    body: {
      code: "access_denied",
      message: "Agent access denied",
      retryable: false,
      recovery: "none",
      requestId: "00000000-0000-4000-8000-000000000021",
    },
  });
  f.collection.traces.set(trace.traceID, trace);
  f.denied = { trace, root, upstream, ui, server, ready, sql };
  return f;
}
test("Membership 403 binds original POST to actual ACP denial and only its readiness query", () => {
  const f = with403(fixture()),
    before = structuredClone([...f.collection.traces]);
  const report = inspect(f);
  assert.equal(report.denial.status, 403);
  assert.equal(report.denial.acp_server_span_id, f.denied.server.spanID);
  assert.equal(report.denial.scope_source, "original-browser-receipt");
  assert.deepEqual([...f.collection.traces], before);
});
for (const [name, mutate] of [
  [
    "wrong original method",
    (f) => {
      f.expected.denial.method = "GET";
    },
  ],
  [
    "readiness after rejection",
    (f) => {
      f.denied.ready.startTime = f.denied.server.logs[0].timestamp + 2000;
      f.denied.sql.startTime = f.denied.ready.startTime + 1000;
    },
  ],
  [
    "wrong body",
    (f) => {
      f.expected.denial.body.retryable = true;
    },
  ],
  [
    "unarchived denial",
    (f) => {
      f.collection.archivedTraceIDs.delete(f.expected.denial.traceID);
    },
  ],
  [
    "UI failure",
    (f) => {
      setTag(f.denied.ui, "otel.status_code", "ERROR");
    },
  ],
  [
    "ACP 503",
    (f) => {
      setTag(f.denied.server, "http.response.status_code", 503);
    },
  ],
  [
    "other ACP route",
    (f) => {
      setTag(f.denied.server, "rpc.method", "read_workspace_intent");
    },
  ],
  [
    "missing original error",
    (f) => {
      f.denied.server.logs = [];
    },
  ],
  [
    "unrelated error",
    (f) => {
      f.denied.server.logs[0].fields.find(
        (v) => v.key === "antnest.error.code",
      ).value = "internal_error";
    },
  ],
  [
    "detached ACP",
    (f) => {
      f.denied.server.references[0].spanID = f.denied.root.spanID;
    },
  ],
  [
    "missing readiness",
    (f) => {
      f.denied.trace.spans = f.denied.trace.spans.filter(
        (s) => s !== f.denied.ready,
      );
    },
  ],
  [
    "business SQL",
    (f) => {
      setTag(f.denied.sql, "db.query.text", "INSERT INTO runs VALUES ($1)");
    },
  ],
  [
    "unowned execution",
    (f) => {
      f.denied.trace.spans.push({
        ...structuredClone(f.denied.sql),
        spanID: "unexpected-run",
        operationName: "run.create",
      });
    },
  ],
  [
    "extra transport error",
    (f) => {
      f.denied.upstream.logs = [
        {
          timestamp: f.denied.upstream.startTime,
          fields: [{ key: "event", value: "antnest.error" }],
        },
      ];
    },
  ],
])
  test("Membership 403 evidence rejects " + name, () => {
    const f = with403(fixture());
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
for (const normal of [true, false])
  test(
    "Membership browser closure binds existing offboarding and real denial: " +
      (normal ? "UI EOF" : "Gateway revocation"),
    () => {
      const f = fixture(normal),
        before = structuredClone([...f.collection.traces]);
      const result = inspect(f);
      assert.equal(result.authorizationCauseVerified, true);
      assert.equal(result.cause_proof.kind, "membership_deactivated");
      assert.equal(result.denial.status, 401);
      assert.equal(result.private_owner_close_verified, false);
      assert.deepEqual([...f.collection.traces], before);
    },
  );
test("an unrelated transport abort cannot prove Membership retirement", () => {
  const f = fixture(false, false);
  assert.throws(() => inspect(f));
});
test("Membership collector joins actual HTTP sources and archives the mutation and original denial", async (t) => {
  const f = fixture();
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-membership-browser-"),
  );
  const requests = [];
  const server = createServer((request, response) => {
    const id = request.url.split("/").at(-1);
    requests.push(id);
    const trace = f.collection.traces.get(id);
    response.writeHead(trace ? 200 : 404, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({ data: trace ? [trace] : [] }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const [report] = await implementation.collectMembershipBrowserClosures(
    `http://127.0.0.1:${server.address().port}`,
    [f.expected],
    [],
    { directory, wait: async () => {}, attempts: 4 },
  );
  assert.equal(report.authorizationCauseVerified, true);
  assert.equal(report.denial.status, 401);
  for (const id of [
    f.trace.traceID,
    f.expected.cause.traceID,
    f.expected.denial.traceID,
  ])
    assert(requests.filter((actual) => actual === id).length >= 3);
  const files = await readdir(directory, { recursive: true });
  for (const id of [
    f.trace.traceID,
    f.expected.cause.traceID,
    f.expected.denial.traceID,
  ])
    assert(
      files.some((name) => name.endsWith(id + ".json")),
      "original HTTP source was not archived",
    );
});
for (const [name, mutate] of [
  [
    "wrong target Membership",
    (f) => {
      f.expected.cause.target.membership_id = "other";
    },
  ],
  [
    "wrong target User",
    (f) => {
      f.expected.cause.body.membership.user_id = "other";
    },
  ],
  [
    "wrong actor Organization",
    (f) => {
      f.expected.cause.actor.organization_id = "other";
    },
  ],
  [
    "restored membership",
    (f) => {
      f.expected.cause.body.membership.active = true;
    },
  ],
  [
    "wrong mutation route",
    (f) => {
      setTag(f.identity, "http.route", "/rpc/identity/revoke-access-token");
    },
  ],
  [
    "unarchived mutation",
    (f) => {
      f.collection.archivedTraceIDs.delete(f.raw.trace.traceID);
    },
  ],
  [
    "forged offboarding report",
    (f) => {
      f.expected.offboarding.request_id = "another";
    },
  ],
  [
    "missing actual Disable",
    (f) => {
      f.raw.trace.spans = f.raw.trace.spans.filter(
        (s) => s.spanID !== "schedule",
      );
    },
  ],
  [
    "different denial credential",
    (f) => {
      f.expected.denial.credentialScope = "other";
    },
  ],
  [
    "denial before closure",
    (f) => {
      f.expected.denial.startedMono = 0;
    },
  ],
  [
    "mutation after closure",
    (f) => {
      f.expected.cause.startedMono = f.expected.closure.at + 1;
    },
  ],
  [
    "mutation after denial",
    (f) => {
      f.expected.cause.completedMono = f.expected.denial.startedMono + 1;
    },
  ],
  [
    "missing UI witness",
    (f) => {
      f.ui.logs = [];
    },
  ],
  [
    "duplicate UI witness",
    (f) => {
      f.ui.logs.push(structuredClone(f.ui.logs[0]));
    },
  ],
  [
    "foreign UI Agent",
    (f) => {
      f.ui.logs[0].fields.find((v) => v.key === "antnest.agent.id").value =
        "other";
    },
  ],
  [
    "UI witness outside span",
    (f) => {
      f.ui.logs[0].timestamp = f.ui.startTime - 1;
    },
  ],
  [
    "normal close without EOF",
    (f) => {
      f.expected.closure.kind = "transport-end";
    },
  ],
  [
    "UI internal error",
    (f) => {
      setTag(f.ui, "otel.status_code", "ERROR");
    },
  ],
  [
    "unrelated Gateway error",
    (f) => {
      setTag(f.root, "error.type", "database_error");
    },
  ],
])
  test("Membership browser gate refuses " + name, () => {
    const f = fixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });
