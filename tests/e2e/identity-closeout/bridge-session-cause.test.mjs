import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeSessionCauseFixture,
  moveSessionTrace,
} from "./bridge-session-cause-fixtures.mjs";
import { sessionTraceBase } from "./bridge-session-trace-fixtures.mjs";
import {
  sessionRejectionFixture,
  failureDiagnostic,
} from "./session-rejection-trace-fixtures.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import {
  addReadEndpointObservation,
  assertReadEndpointObservations,
} from "../observability/runtime-information-timing-fixture.mjs";
import {
  addResolveRPC,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

const url = new URL("./bridge-session-cause.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (f) => {
  assert.equal(typeof implementation.inspectBridgeSessionClosure, "function");
  return implementation.inspectBridgeSessionClosure(
    f.trace,
    f.expected,
    ["PRIVATE-SESSION-CAUSE-CANARY"],
    f.collection,
  );
};

function logoutFeedFixture() {
  const f = bridgeSessionCauseFixture();
  f.expected.principal.membership_id = "membership";
  f.feed = {
    timestamp: f.upstream.logs[0].timestamp - 1000,
    fields: Object.entries({
      event: "antnest.stream.termination",
      source: "identity-session-feed",
      reason: "session_revoked",
      "antnest.revocation.reason": "session_revoked",
      "antnest.revocation.sequence": 12,
      "antnest.revocation.trace_id": f.mutation.trace.traceID,
      "antnest.revocation.span_id": f.mutation.server.spanID,
      "antnest.organization.id": f.expected.principal.organization_id,
      "antnest.principal.id": f.expected.principal.user_id,
      "antnest.membership.id": "membership",
      "antnest.agent.id": f.expected.agentId,
    }).map(([key, value]) => ({ key, value })),
  };
  f.root.logs.push(f.feed);
  f.upstream.logs[0].fields.find(
    (v) => v.key === "antnest.error.cause_types",
  ).value = '["*browserstream.feedTerminationCause","*errors.errorString"]';
  return f;
}
test("Session logout binds the winning feed to its original committed mutation", () => {
  const f = logoutFeedFixture(),
    before = structuredClone([...f.collection.traces]);
  const result = inspect(f);
  assert.equal(result.authorizationCauseVerified, true);
  assert.equal(result.cause_proof.feed_sequence, 12);
  assert.equal(
    result.cause_proof.feed_source_span_id,
    f.mutation.server.spanID,
  );
  assert.deepEqual([...f.collection.traces], before);
});
for (const [name, mutate] of [
  [
    "wrong source",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.span_id").value =
        f.mutation.root.spanID;
    },
  ],
  [
    "different reason",
    (f) => {
      f.feed.fields.find((v) => v.key === "antnest.revocation.reason").value =
        "membership_deactivated";
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
    "before mutation",
    (f) => {
      f.feed.timestamp = f.mutation.root.startTime - 1;
    },
  ],
  [
    "after original failure",
    (f) => {
      f.feed.timestamp = f.upstream.logs[0].timestamp + 1;
    },
  ],
  [
    "unproved typed cause",
    (f) => {
      f.root.logs.pop();
    },
  ],
])
  test("Session feed rejects " + name, () => {
    const f = logoutFeedFixture();
    inspect(f);
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const [key, value] of [
  ["http.response.status_code", 500],
  ["http.status_code", "500"],
  ["http.status_code", 202],
  ...["ERROR", "WARN", "FATAL"].map((value) => ["level", value]),
])
  test(`Session cause rejects unowned successful UI event ${key}=${JSON.stringify(value)}`, () => {
    const f = bridgeSessionCauseFixture();
    inspect(f);
    (f.ui.logs ??= []).push({
      timestamp: f.ui.startTime + 1,
      fields: [{ key, value }],
    });
    const before = JSON.stringify([...f.collection.traces]);
    assert.throws(() => inspect(f));
    assert.equal(JSON.stringify([...f.collection.traces]), before);
  });

function sessionRead(
  method = "initialize",
  runtimeOutcome = "success",
  shape = method === "initialize" ? "http" : "queued",
) {
  const f = bridgeSessionCauseFixture();
  const request = {
    traceID: f.trace.traceID,
    spanID: "metadata-request",
    processID: "acp",
    operationName: shape === "http" ? "HTTP POST /v1/acp" : "acp " + method,
    startTime: f.ui.startTime + 1000,
    duration: 100,
    references: [
      { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: f.ui.spanID },
    ],
    tags: Object.entries({
      "span.kind": "server",
      "rpc.system.name": "jsonrpc",
      "rpc.service": "acp",
      "rpc.method": method,
      "antnest.protocol.version": "v1",
      "antnest.agent.id": f.expected.agentId,
      "antnest.request.id": "metadata-request",
      ...(shape === "http"
        ? {
            "http.request.method": "POST",
            "http.route": "/v1/acp",
            "http.response.status_code": 200,
            "antnest.listener": "workspace",
          }
        : {}),
      ...(method === "session/load"
        ? { "antnest.session.id": f.expected.sessionId }
        : {}),
    }).map(([key, value]) => ({ key, value })),
    logs: [],
  };
  let receiver = request;
  if (shape === "queued") {
    // The SDK may acknowledge POST before dispatching the queued RPC. Its
    // injected metadata retains that original HTTP receiver as the parent.
    receiver = {
      ...structuredClone(request),
      spanID: "metadata-http-receiver",
      operationName: "HTTP POST /v1/acp",
      startTime: request.startTime - 100,
      duration: 50,
      tags: Object.entries({
        "span.kind": "server",
        "antnest.listener": "workspace",
        "http.request.method": "POST",
        "http.route": "/v1/acp",
        "http.response.status_code": 202,
      }).map(([key, value]) => ({ key, value })),
    };
    request.references[0].spanID = receiver.spanID;
    f.trace.spans.push(receiver);
  }
  f.trace.spans.push(request);
  const read = addCompletedRead(f.trace, request, "http", f.expected.agentId, {
    preserveRequest: true,
    runtimeOutcome,
  });
  return { ...f, metadata: { ...read, receiver } };
}
for (const method of ["initialize", "session/load"])
  test(
    "Session preserves original " +
      method +
      " endpoint observations without changing diagnostics",
    () => {
      const f = sessionRead(method),
        baseline = inspect(f);
      const expected = addReadEndpointObservation(f.trace, f.metadata.read);
      const raw = structuredClone(f.trace);
      assertReadEndpointObservations(inspect(f), [expected], baseline);
      assert.deepEqual(f.trace, raw);
    },
  );
for (const method of ["initialize", "session/load"])
  for (const runtimeOutcome of ["success", "canceled"])
    for (const shape of ["http", "queued"])
      test(`Session binds ${shape} ${method} ${runtimeOutcome} Runtime read to its parsed receipt and owned close`, () => {
        const f = sessionRead(method, runtimeOutcome, shape),
          before = structuredClone(f.trace);
        const result = inspect(f);
        assert.equal(result.authorizationCauseVerified, true);
        assert(
          result.neutral_diagnostics.some(
            (row) => row.span_id === f.metadata.client.spanID,
          ),
        );
        assert.deepEqual(f.trace, before);
      });
for (const [name, mutate] of [
  [
    "wrong load Session",
    (f) => setTag(f.metadata.root, "antnest.session.id", "other"),
  ],
  [
    "wrong load Agent",
    (f) => setTag(f.metadata.root, "antnest.agent.id", "other"),
  ],
  [
    "foreign UI parent",
    (f) => {
      f.metadata.root.references[0].spanID = f.root.spanID;
    },
  ],
  [
    "failed parsed read with successful load",
    (f) =>
      setTag(f.metadata.read, "antnest.mcp.resource_read.outcome", "failed"),
  ],
  [
    "caller cancelled during close",
    (f) => setTag(f.metadata.read, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "unjoined close",
    (f) => {
      f.metadata.read.logs.pop();
    },
  ],
])
  test("Session read rejects " + name, () => {
    const f = sessionRead("session/load");
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const shape of ["http", "queued"])
  for (const method of ["initialize", "session/load"])
    for (const [name, mutate] of [
      [
        "wrong HTTP method",
        (f) => setTag(f.metadata.receiver, "http.request.method", "GET"),
      ],
      [
        "wrong HTTP route",
        (f) => setTag(f.metadata.receiver, "http.route", "/v2/acp"),
      ],
      [
        "wrong HTTP status",
        (f) =>
          setTag(
            f.metadata.receiver,
            "http.response.status_code",
            shape === "http" ? 202 : 200,
          ),
      ],
      [
        "wrong listener",
        (f) => setTag(f.metadata.receiver, "antnest.listener", "control"),
      ],
      [
        "missing listener",
        (f) => setTag(f.metadata.receiver, "antnest.listener", undefined),
      ],
      [
        "wrong RPC system",
        (f) => setTag(f.metadata.root, "rpc.system.name", "other"),
      ],
      [
        "wrong RPC service",
        (f) => setTag(f.metadata.root, "rpc.service", "other"),
      ],
      [
        "wrong protocol",
        (f) => setTag(f.metadata.root, "antnest.protocol.version", "v2"),
      ],
      [
        "missing request ID",
        (f) => setTag(f.metadata.root, "antnest.request.id", undefined),
      ],
      [
        "arbitrary intermediate parent",
        (f) => {
          const middle = {
            ...structuredClone(f.metadata.receiver),
            spanID: "intermediate",
            operationName: "unowned",
          };
          f.trace.spans.push(middle);
          f.metadata.receiver.references[0].spanID = middle.spanID;
        },
      ],
    ])
      test(`Session ${shape} ${method} read rejects ${name}`, () => {
        const f = sessionRead(method, "success", shape);
        mutate(f);
        assert.throws(() => inspect(f));
      });

for (const shape of ["http", "queued"])
  test(`Session ${shape} load read requires its original Session`, () => {
    const f = sessionRead("session/load", "success", shape);
    setTag(f.metadata.root, "antnest.session.id", undefined);
    assert.throws(() => inspect(f));
  });

for (const [name, mutate] of [
  [
    "receiver starts after queued RPC",
    (f) => {
      f.metadata.receiver.startTime = f.metadata.root.startTime + 10000;
    },
  ],
  ...["rpc.response.status_code", "jsonrpc.error_code"].flatMap((key) => [
    [
      "failed receiver tag: " + key,
      (f) => setTag(f.metadata.receiver, key, -32020),
    ],
    [
      "failed receiver event: " + key,
      (f) => {
        f.metadata.receiver.logs.push({
          timestamp: f.metadata.receiver.startTime + 1,
          fields: [{ key, value: -32020 }],
        });
      },
    ],
  ]),
  [
    "missing HTTP receiver",
    (f) => {
      f.metadata.root.references[0].spanID = f.ui.spanID;
    },
  ],
  [
    "foreign ACP process",
    (f) => {
      f.trace.processes.otherACP = structuredClone(f.trace.processes.acp);
      f.metadata.receiver.processID = "otherACP";
    },
  ],
  ...[
    "http.request.method",
    "http.route",
    "http.response.status_code",
    "antnest.listener",
  ].map((key) => [
    "HTTP attributes on named RPC: " + key,
    (f) =>
      setTag(
        f.metadata.root,
        key,
        key === "http.response.status_code" ? 200 : "unexpected",
      ),
  ]),
])
  test("Session queued read rejects " + name, () => {
    const f = sessionRead("session/load");
    mutate(f);
    assert.throws(() => inspect(f));
  });

for (const reason of ["revoked", "unavailable", "expired"])
  for (const version of [1, 2])
    test(`Session ${reason} v${version} binds original SSE, independent cause and actual denial without changing raw diagnostics`, () => {
      const f = bridgeSessionCauseFixture(reason);
      f.expected.protocolVersion = version;
      f.root.warnings = ["original raw warning"];
      const before = JSON.stringify([...f.collection.traces]);
      const result = inspect(f);
      assert.equal(result.authorizationCauseVerified, true);
      assert.equal(result.reason, reason);
      assert.equal(result.denial.status, reason === "unavailable" ? 503 : 401);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.warning_count, 1);
      assert.equal(JSON.stringify([...f.collection.traces]), before);
    });

test("logout feed may close SSE before a terminal rejected revalidation", () => {
  const f = bridgeSessionCauseFixture();
  assert.equal(inspect(f).gateway_revalidations.length, 0);
});

test("logout also admits a real terminal401 after its committed revocation", () => {
  const f = bridgeSessionCauseFixture("revoked", { terminal: true });
  assert.equal(inspect(f).gateway_revalidations.at(-1).outcome, "rejected");
});

function admittedRevalidation() {
  const f = bridgeSessionCauseFixture();
  const rpc = addResolveRPC(f.trace, "-later", (sessionTraceBase + 500) * 1000);
  setTag(rpc.sql, "pgx.rows_affected", 1);
  setTag(
    rpc.sql,
    "db.query.text",
    f.rejection.database.tags.find((t) => t.key === "db.query.text").value,
  );
  const decision = structuredClone(f.decision);
  decision.spanID = "decision-later";
  decision.startTime = rpc.client.startTime - 1000;
  decision.duration = 5000;
  setTag(decision, "antnest.identity.resolve.source", "rpc");
  for (const key of ["snapshot_age_ms", "proof_age_ms", "valid_for_ms"])
    setTag(decision, "antnest.identity.resolve." + key, undefined);
  f.trace.spans.push(decision);
  return { ...f, rpc, later: decision };
}

test("admitted revalidation accounts for its actual RPC and successful token SELECT", () => {
  const f = admittedRevalidation();
  assert.equal(
    inspect(f).gateway_revalidations[0].rpc_client_span_id,
    f.rpc.client.spanID,
  );
});

test("shared revalidation may reuse its one actual RPC creator", () => {
  const f = admittedRevalidation();
  const shared = structuredClone(f.later);
  shared.spanID = "shared-revalidation";
  setTag(shared, "antnest.identity.resolve.source", "shared");
  setTag(
    shared,
    "antnest.identity.resolve.shared_source_state",
    "actual-client",
  );
  shared.references.push({
    refType: "FOLLOWS_FROM",
    traceID: f.trace.traceID,
    spanID: f.rpc.client.spanID,
  });
  f.trace.spans.push(shared);
  const result = inspect(f);
  assert.deepEqual(
    result.gateway_revalidations.map((r) => r.source),
    ["rpc", "shared"],
  );
  assert(
    result.gateway_revalidations.every(
      (r) => r.rpc_client_span_id === f.rpc.client.spanID,
    ),
  );
});

test("two RPC decisions cannot both create one actual revalidation CLIENT", () => {
  const f = admittedRevalidation();
  f.trace.spans.push({
    ...structuredClone(f.later),
    spanID: "duplicate-rpc-creator",
  });
  assert.throws(() => inspect(f), /multiple rpc decisions claim one CLIENT/u);
});

for (const source of ["rpc", "shared"])
  test(`successful ${source} Resolve must read the actual browser token`, () => {
    const f = admittedRevalidation();
    let sql = f.rpc.sql;
    if (source === "shared") {
      const origin = structuredClone(f.trace);
      moveSessionTrace(origin, "c".repeat(32), f.root.startTime);
      const selected = new Set([
        f.root.spanID,
        f.later.spanID,
        ...Object.values(f.rpc).map((span) => span.spanID),
      ]);
      origin.spans = origin.spans.filter((span) => selected.has(span.spanID));
      const root = origin.spans.find((span) => span.spanID === f.root.spanID);
      root.tags = root.tags.filter(
        (field) => !/^(error|otel.status_)/u.test(field.key),
      );
      root.logs = [];
      f.trace.spans = f.trace.spans.filter(
        (span) => !Object.values(f.rpc).includes(span),
      );
      setTag(f.later, "antnest.identity.resolve.source", "shared");
      setTag(
        f.later,
        "antnest.identity.resolve.shared_source_state",
        "actual-client",
      );
      f.later.references.push({
        refType: "FOLLOWS_FROM",
        traceID: origin.traceID,
        spanID: f.rpc.client.spanID,
      });
      f.collection.traces.set(origin.traceID, origin);
      f.collection.archivedTraceIDs.add(origin.traceID);
      sql = origin.spans.find((span) => span.spanID === f.rpc.sql.spanID);
    }
    assert.equal(inspect(f).authorizationCauseVerified, true);
    setTag(sql, "db.query.text", "SELECT 1");
    assert.throws(() => inspect(f), /token SELECT/u);
  });

test("terminal token SELECT cannot hide an unrelated cancellation diagnostic", () => {
  const f = bridgeSessionCauseFixture("revoked", { terminal: true });
  setTag(f.terminal.sql, "antnest.cancellation.type", "UnexpectedCancellation");
  assert.throws(() => inspect(f));
});

test("client and runner wall clocks cannot redefine the Identity outage interval", () => {
  const f = bridgeSessionCauseFixture("unavailable");
  for (const transition of f.expected.identityTransitions) {
    transition.deployment.command_observation.started_at_ms += 300000;
    transition.deployment.command_observation.returned_at_ms += 300000;
  }
  f.expected.startedAt += 300000;
  f.expected.closedAt += 300000;
  f.expected.checkpoint.observed_at_ms += 300000;
  f.expected.closure.observed_at_ms += 300000;
  f.expected.denial.startedAt += 300000;
  f.expected.denial.completedAt += 300000;
  assert.equal(inspect(f).authorizationCauseVerified, true);
});

test("Session outage accepts the actual five-second shared Resolve timeout cap", () => {
  const f = bridgeSessionCauseFixture("unavailable");
  for (const span of [f.terminal.client, f.rejection.client])
    setTag(span, "antnest.request.timeout_ms", 5000);
  assert.equal(inspect(f).authorizationCauseVerified, true);
});

function sharedDeadlineCleanupFixture() {
  const f = bridgeSessionCauseFixture("unavailable");
  const { source, sourceRoot, sourceClient, sourceDecision } =
    sessionRejectionFixture(503, true);
  const decision = f.terminal.decision;
  moveSessionTrace(
    source,
    "c".repeat(32),
    decision.startTime + decision.duration - 1011000,
  );
  source.processes = structuredClone(f.trace.processes);
  setTag(sourceClient, "antnest.request.timeout_ms", 1000);
  const completed = decision.startTime + decision.duration + 250000;
  sourceClient.duration = completed - sourceClient.startTime;
  failureDiagnostic(
    sourceClient,
    "deadline_exceeded",
    "Request deadline exceeded",
    ["context.deadlineExceededError"],
    "send",
  );
  sourceDecision.duration = completed + 1000 - sourceDecision.startTime;
  sourceRoot.duration = completed + 2000 - sourceRoot.startTime;
  failureDiagnostic(
    sourceRoot,
    "deadline_exceeded",
    "Request deadline exceeded",
    ["context.deadlineExceededError"],
    "request",
  );
  f.trace.spans = f.trace.spans.filter((span) => span !== f.terminal.client);
  setTag(decision, "antnest.identity.resolve.source", "shared");
  setTag(
    decision,
    "antnest.identity.resolve.shared_source_state",
    "actual-client",
  );
  setTag(decision, "antnest.identity.resolve.cancel_kind", "shared-deadline");
  decision.references.push({
    refType: "FOLLOWS_FROM",
    traceID: source.traceID,
    spanID: sourceClient.spanID,
  });
  f.collection.traces.set(source.traceID, source);
  f.collection.archivedTraceIDs.add(source.traceID);
  f.shared = {
    trace: source,
    root: sourceRoot,
    decision: sourceDecision,
    client: sourceClient,
  };
  return f;
}

test("Session shared deadline releases its waiter before the actual transport finishes cleanup", () => {
  const f = sharedDeadlineCleanupFixture();
  const original = structuredClone(f.collection.traces);
  const checked = inspect(f);
  assert.equal(checked.authorizationCauseVerified, true);
  const resolution = checked.gateway_revalidations.find(
    (record) => record.decision_span_id === f.terminal.decision.spanID,
  );
  assert.equal(resolution.admission, false);
  assert.equal(resolution.source_trace_id, f.shared.trace.traceID);
  assert.equal(resolution.rpc_client_span_id, f.shared.client.spanID);
  assert.deepEqual(f.collection.traces, original);
});

test("Session ordinary RPC still requires completion before its decision", () => {
  const f = bridgeSessionCauseFixture("unavailable");
  const client = f.terminal.client;
  client.duration =
    f.terminal.decision.startTime +
    f.terminal.decision.duration +
    250000 -
    client.startTime;
  client.logs[0].timestamp = client.startTime + client.duration;
  assert.throws(() => inspect(f), /actual failed workspace CLIENT/u);
});

for (const [name, change] of [
  [
    "missing shared deadline",
    (f) =>
      setTag(
        f.terminal.decision,
        "antnest.identity.resolve.cancel_kind",
        undefined,
      ),
  ],
  [
    "ordinary RPC",
    (f) =>
      setTag(f.terminal.decision, "antnest.identity.resolve.source", "rpc"),
  ],
  [
    "unfinished CLIENT",
    (f) => {
      delete f.shared.client.duration;
    },
  ],
  [
    "CLIENT not yet started",
    (f) => {
      const end = f.shared.client.startTime + f.shared.client.duration;
      f.shared.client.startTime =
        f.terminal.decision.startTime + f.terminal.decision.duration + 1000;
      f.shared.client.duration = end - f.shared.client.startTime;
    },
  ],
  [
    "ordinary cancellation",
    (f) =>
      failureDiagnostic(
        f.shared.client,
        "cancelled",
        "Request was cancelled",
        ["*errors.errorString"],
        "send",
      ),
  ],
  [
    "successful CLIENT",
    (f) => {
      f.shared.client.tags = f.shared.client.tags.filter(
        (tag) => !/^(error|otel.status_)/u.test(tag.key),
      );
      f.shared.client.logs = [];
      setTag(f.shared.client, "http.response.status_code", 200);
    },
  ],
  [
    "unarchived source",
    (f) => f.collection.archivedTraceIDs.delete(f.shared.trace.traceID),
  ],
  [
    "different process",
    (f) => {
      f.shared.trace.processes.edge.tags.find(
        (tag) => tag.key === "service.instance.id",
      ).value = "other";
    },
  ],
  [
    "outside independently stopped interval",
    (f) => {
      f.shared.client.duration += 5000000;
      f.shared.root.duration += 5000000;
      f.shared.decision.duration += 5000000;
      f.shared.client.logs[0].timestamp += 5000000;
      f.shared.root.logs[0].timestamp += 5000000;
    },
  ],
])
  test(`Session shared deadline still rejects ${name}`, () => {
    const f = sharedDeadlineCleanupFixture();
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "different denial Cookie",
    (f) =>
      (f.expected.denial.credentialScope =
        "00000000-0000-4000-8000-000000000008"),
  ],
  [
    "denial before observed close",
    (f) => (f.expected.denial.startedMono = f.expected.closure.at - 1),
  ],
  [
    "denial for another Session",
    (f) =>
      (f.expected.denial.path = f.expected.denial.path.replace(
        "session-1",
        "session-2",
      )),
  ],
  [
    "unarchived denial",
    (f) => f.collection.archivedTraceIDs.delete(f.expected.denial.traceID),
  ],
  [
    "reused stream as denial",
    (f) => (f.expected.denial.traceID = f.expected.traceID),
  ],
  ["cached denial", (f) => (f.expected.denial.noStore = false)],
  ["denial Cookie write", (f) => (f.expected.denial.setCookieCount = 1)],
  [
    "unrelated Gateway failure",
    (f) => setTag(f.root, "antnest.error.code", "database_failed"),
  ],
  [
    "hidden Gateway transport failure",
    (f) => setTag(f.root, "http.transport.error.type", "another_failure"),
  ],
  [
    "hidden forwarding transport failure",
    (f) => setTag(f.upstream, "http.transport.error.type", "another_failure"),
  ],
  [
    "hidden denial transport failure",
    (f) =>
      setTag(f.rejection.root, "http.transport.error.type", "another_failure"),
  ],
  [
    "hidden denial request cancellation",
    (f) => setTag(f.rejection.root, "antnest.http.request_cancelled", true),
  ],
  [
    "hidden denial SQL cancellation",
    (f) =>
      setTag(
        f.rejection.database,
        "antnest.cancellation.type",
        "UnexpectedCancellation",
      ),
  ],
  ["unrelated UI failure", (f) => setTag(f.ui, "otel.status_code", 2)],
  [
    "unowned UI transport failure",
    (f) => setTag(f.ui, "http.transport.error.type", "lost"),
  ],
  [
    "contradictory successful UI result",
    (f) => setTag(f.ui, "antnest.result", "failed"),
  ],
  [
    "fabricated normal logout EOF",
    (f) => {
      for (const span of [f.root, f.upstream]) {
        span.tags = span.tags.filter(
          (t) => !/^(error|otel.status_)/u.test(t.key),
        );
        span.logs = [];
      }
      f.expected.closure.kind = "remote-end";
    },
  ],
  [
    "different logout principal",
    (f) =>
      (f.expected.cause.principal = {
        ...f.expected.principal,
        user_id: "foreign",
      }),
  ],
  [
    "different logout Cookie",
    (f) =>
      (f.expected.cause.credentialScope =
        "00000000-0000-4000-8000-000000000008"),
  ],
  [
    "logout dispatched after closure",
    (f) => (f.expected.cause.startedMono = f.expected.closure.at + 1),
  ],
  [
    "logout readback before commit",
    (f) => {
      moveSessionTrace(
        f.rejection.trace,
        f.rejection.trace.traceID,
        (sessionTraceBase + 1000) * 1000,
      );
    },
  ],
  [
    "another Identity process at readback",
    (f) => {
      f.rejection.trace.processes.identity.tags.find(
        (t) => t.key === "service.instance.id",
      ).value = "another";
    },
  ],
  [
    "private source content",
    (f) => setTag(f.ui, "unclassified", "PRIVATE-SESSION-CAUSE-CANARY"),
  ],
  [
    "an actual Gateway RPC with no Resolve decision",
    (f) => {
      const s = structuredClone(f.rejection.client);
      s.traceID = f.trace.traceID;
      s.spanID = "unclaimed-rpc";
      s.startTime = f.root.startTime + 100000;
      s.tags = s.tags.filter((t) => !/^(error|otel.status_)/u.test(t.key));
      s.logs = [];
      setTag(s, "http.response.status_code", 200);
      s.references = [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: f.root.spanID,
        },
      ];
      f.trace.spans.push(s);
    },
  ],
])
  test(`Session closure rejects ${name}`, () => {
    assert.equal(typeof implementation.inspectBridgeSessionClosure, "function");
    const f = bridgeSessionCauseFixture();
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  [
    "no terminal actual RPC",
    (f) =>
      (f.trace.spans = f.trace.spans.filter(
        (s) => !s.spanID.startsWith("terminal-"),
      )),
  ],
  [
    "hidden terminal transport diagnostic",
    (f) =>
      setTag(f.terminal.client, "http.transport.error.type", "another_failure"),
  ],
  [
    "hidden terminal decision termination",
    (f) =>
      setTag(f.terminal.decision, "antnest.stream.termination", "unrelated"),
  ],
  [
    "terminal RPC above the shared timeout cap",
    (f) => setTag(f.terminal.client, "antnest.request.timeout_ms", 5001),
  ],
  [
    "failed RPC before stop acknowledgement",
    (f) => {
      f.expected.identityTransitions[0].observation.acknowledged.at = 3900;
    },
  ],
  [
    "restart before the independent denial",
    (f) => (f.expected.identityTransitions[1].observation.requested.at = 4400),
  ],
  [
    "different deployment project",
    (f) => (f.expected.deployment.project = "antnest-stage3-e2e-9999"),
  ],
  [
    "unproved stop",
    (f) => (f.expected.identityTransitions[0].deployment.after.running = true),
  ],
  [
    "reused request nonce",
    (f) =>
      (f.expected.identityTransitions[1].deployment.request.nonce =
        f.expected.identityTransitions[0].deployment.request.nonce),
  ],
  [
    "missing raw deployment digest",
    (f) =>
      delete f.expected.identityTransitions[0].deployment.raw.before_sha256,
  ],
  [
    "another Gateway process at denial",
    (f) =>
      (f.rejection.trace.processes.edge.tags.find(
        (t) => t.key === "host.name",
      ).value = "another"),
  ],
  [
    "revalidation after failure",
    (f) => {
      const s = structuredClone(f.decision);
      s.spanID = "after-failure";
      s.startTime = f.terminal.decision.startTime + 50000;
      f.trace.spans.push(s);
    },
  ],
  [
    "unclaimed Gateway forwarding after terminal failure",
    (f) => {
      const s = structuredClone(f.upstream);
      s.spanID = "after-failure-forward";
      s.startTime = f.terminal.client.startTime + 50000;
      s.duration = 1000;
      s.tags = s.tags.filter((t) => !/^(error|otel.status_)/u.test(t.key));
      s.logs = [];
      f.trace.spans.push(s);
    },
  ],
])
  test(`Session outage rejects ${name}`, () => {
    assert.equal(typeof implementation.inspectBridgeSessionClosure, "function");
    const f = bridgeSessionCauseFixture("unavailable");
    change(f);
    assert.throws(() => inspect(f));
  });

for (const [name, change] of [
  ["missing short TTL receipt", (f) => delete f.expected.cause.transition],
  [
    "wrong short token TTL",
    (f) => (f.expected.cause.transition.deployment.after.token_ttl = "12h"),
  ],
  [
    "short login before deployment",
    (f) =>
      (f.expected.cause.transition.observation.acknowledged.at =
        f.expected.checkpoint.stream.started_at + 1),
  ],
  [
    "original Cookie issued before rebuild acknowledgement",
    (f) => (f.expected.checkpoint.issuance.startedMono = 50),
  ],
  [
    "login response after original SSE dispatch",
    (f) => (f.expected.checkpoint.issuance.completedMono = 1500),
  ],
  [
    "missing original login receipt",
    (f) => delete f.expected.checkpoint.issuance,
  ],
  [
    "login completed before dispatch",
    (f) => (f.expected.checkpoint.issuance.completedMono = 600),
  ],
  [
    "invalid original login Trace",
    (f) => (f.expected.checkpoint.issuance.traceID = "missing"),
  ],
  [
    "uncollected original login",
    (f) => (f.expected.checkpoint.issuance.traceID = "9".repeat(32)),
  ],
  [
    "unarchived original login",
    (f) => f.collection.archivedTraceIDs.delete(f.login.trace.traceID),
  ],
  [
    "unrelated collected login ID",
    (f) => (f.expected.checkpoint.issuance.traceID = f.expected.denial.traceID),
  ],
  [
    "wrong login route",
    (f) => setTag(f.login.root, "http.route", "/api/session"),
  ],
  [
    "wrong Identity login RPC",
    (f) => setTag(f.login.server, "rpc.method", "resolve_access_token"),
  ],
  [
    "failed original login",
    (f) => setTag(f.login.server, "http.response.status_code", 401),
  ],
  [
    "login from another Gateway process",
    (f) =>
      (f.login.trace.processes.edge.tags.find(
        (tag) => tag.key === "host.name",
      ).value = "foreign"),
  ],
  [
    "login before actual rebuild",
    (f) =>
      moveSessionTrace(
        f.login.trace,
        f.login.trace.traceID,
        (sessionTraceBase - 1000) * 1000,
      ),
  ],
  [
    "login after original SSE",
    (f) =>
      moveSessionTrace(
        f.login.trace,
        f.login.trace.traceID,
        (sessionTraceBase + 100) * 1000,
      ),
  ],
  [
    "missing actual token issue",
    (f) =>
      (f.login.trace.spans = f.login.trace.spans.filter(
        (span) => span !== f.login.insert,
      )),
  ],
  [
    "uncommitted token issue",
    (f) =>
      (f.login.trace.spans = f.login.trace.spans.filter(
        (span) => span !== f.login.commit,
      )),
  ],
  [
    "unrelated login failure diagnostic",
    (f) =>
      setTag(
        f.login.insert,
        "antnest.cancellation.type",
        "UnexpectedCancellation",
      ),
  ],
  [
    "POST before the original authority and cache deadline",
    (f) => (f.expected.denial.startedMono = f.expected.closure.at + 1),
  ],
  [
    "refusal SQL before original expiry",
    (f) => {
      const sql = f.rejection.trace.spans.find((s) => s.spanID === "sql");
      sql.startTime = (f.expected.checkpoint.expiresAt - 1) * 1000;
    },
  ],
])
  test(`Session absolute expiry rejects ${name}`, () => {
    assert.equal(typeof implementation.inspectBridgeSessionClosure, "function");
    const f = bridgeSessionCauseFixture("expired");
    change(f);
    assert.throws(() => inspect(f));
  });

for (const reason of ["revoked", "expired"])
  test(`Session collector archives original SSE, ${reason} cause and actual denial together`, async (t) => {
    assert.equal(typeof implementation.collectBridgeSessionClosure, "function");
    const f = bridgeSessionCauseFixture(reason);
    const directory = await mkdtemp(join(tmpdir(), "antnest-session-cause-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const requests = [];
    const request = async (url) => {
      const id = String(url).split("/").at(-1);
      requests.push(id);
      assert(
        f.collection.traces.has(id),
        "collector invented a WebSocket Trace",
      );
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ data: [f.collection.traces.get(id)] }),
      };
    };
    const result = await implementation.collectBridgeSessionClosure(
      "http://jaeger.invalid",
      f.expected,
      [],
      { directory, request, wait: async () => {}, attempts: 5 },
    );
    assert.equal(result.authorizationCauseVerified, true);
    for (const [id, trace] of f.collection.traces) {
      assert(requests.filter((actual) => actual === id).length >= 3);
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, id + ".json"), "utf8")),
        trace,
      );
    }
  });
