import {
  bridgeSessionTraceFixture,
  sessionTraceBase,
} from "./bridge-session-trace-fixtures.mjs";
import {
  sessionRejectionFixture,
  failureDiagnostic,
} from "./session-rejection-trace-fixtures.mjs";
import { recoveryHTTPFixture } from "../edge-gateway/resolve-cache-recovery-http-fixtures.mjs";

export function moveSessionTrace(trace, traceID, start) {
  const root = trace.spans.find(
    (s) => !s.references?.some((r) => r.refType === "CHILD_OF"),
  );
  const shift = start - root.startTime;
  const old = trace.traceID;
  trace.traceID = traceID;
  for (const span of trace.spans) {
    span.traceID = traceID;
    span.startTime += shift;
    for (const event of span.logs ?? []) event.timestamp += shift;
    for (const ref of span.references ?? [])
      if (ref.traceID === old) ref.traceID = traceID;
  }
}

export function sessionTransitionFixture() {
  const project = "antnest-stage3-e2e-1234",
    runID = "00000000-0000-4000-8000-000000000001";
  let previous;
  const transitions = [1, 2].map((step) => {
    const before = previous?.deployment.after ?? {
      container_id: "a".repeat(64),
      token_ttl: "12h",
      running: true,
      started_at: "2026-10-15T01:00:00Z",
      finished_at: "0001-01-01T00:00:00Z",
    };
    const after =
      step === 1
        ? { ...before, running: false, finished_at: "2026-10-15T01:00:01Z" }
        : {
            container_id: "b".repeat(64),
            token_ttl: "5s",
            running: true,
            started_at: "2026-10-15T01:00:02Z",
            finished_at: "0001-01-01T00:00:00Z",
          };
    const requested = step === 1 ? 2100 : 5000;
    const result = {
      deployment: {
        version: 1,
        project,
        run_id: runID,
        step,
        image_ref: `antnest/identity-service:session-${runID}`,
        image_id: "sha256:" + "d".repeat(64),
        before,
        after,
        authorization_cause_verified: false,
        request: {
          version: 1,
          project,
          run_id: runID,
          step,
          nonce: `00000000-0000-4000-8000-00000000000${step}`,
        },
        command_observation: {
          clock: "runner-wall",
          started_at_ms: step * 1000,
          returned_at_ms: step * 1000 + 100,
        },
        raw: { before_sha256: "e".repeat(64), after_sha256: "f".repeat(64) },
      },
      observation: {
        clock: "session-client",
        requested: {
          at: requested,
          observed_at_ms: sessionTraceBase + requested - 1000,
        },
        acknowledged: {
          at: requested + 100,
          observed_at_ms: sessionTraceBase + requested - 900,
        },
      },
    };
    previous = result;
    return result;
  });
  return { project, runID, transitions };
}

function resource(trace) {
  for (const process of Object.values(trace.processes)) {
    const name = process.serviceName;
    process.tags = Object.entries({
      "host.name": name + "-host",
      "process.pid": name === "edge-gateway" ? 1 : 2,
      "service.instance.id": name + "-instance",
      "telemetry.sdk.language": name === "agent-ui" ? "nodejs" : "go",
    }).map(([key, value]) => ({ key, value }));
  }
}

function originalLoginFixture() {
  const trace = {
    traceID: "8".repeat(32),
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [],
  };
  const add = (id, processID, name, start, duration, parent, tags) => {
    const span = {
      traceID: trace.traceID,
      spanID: id,
      processID,
      operationName: name,
      startTime: (sessionTraceBase + start) * 1000,
      duration: duration * 1000,
      references: parent
        ? [
            {
              refType: "CHILD_OF",
              traceID: trace.traceID,
              spanID: parent.spanID,
            },
          ]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  const root = add(
    "login-root",
    "edge",
    "HTTP POST /api/session/login",
    -250,
    100,
    undefined,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/api/session/login",
      "http.response.status_code": 200,
    },
  );
  const client = add(
    "login-client",
    "edge",
    "HTTP POST identity-service",
    -240,
    80,
    root,
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    },
  );
  const server = add(
    "login-server",
    "identity",
    "HTTP POST /rpc/identity/local-login",
    -235,
    70,
    client,
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/rpc/identity/local-login",
      "rpc.method": "local_login",
      "http.response.status_code": 200,
    },
  );
  const transaction = add(
    "login-transaction",
    "identity",
    "postgresql transaction",
    -230,
    60,
    server,
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    },
  );
  const sql = (id, operation, query, start, rows) =>
    add(id, "identity", operation, start, 1, transaction, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": operation,
      "db.query.text": query,
      "pgx.rows_affected": rows,
    });
  const begin = sql("login-begin", "BEGIN", "begin", -225, 0);
  const insert = sql(
    "login-insert",
    "INSERT",
    "INSERT INTO api_tokens ( id,token_hash,user_id,organization_id,membership_id,issued_at,expires_at, public_session_id,idle_expires_at,last_used_at,user_agent_hint ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$10) RETURNING expires_at,idle_expires_at",
    -200,
    1,
  );
  const commit = sql("login-commit", "COMMIT", "commit", -180, 0);
  return { trace, root, client, server, transaction, begin, insert, commit };
}

export function bridgeSessionCauseFixture(
  reason = "revoked",
  { terminal = reason === "unavailable" } = {},
) {
  const f = bridgeSessionTraceFixture(reason),
    base = sessionTraceBase;
  const principal = { organization_id: "org", user_id: "user" };
  const environment = sessionTransitionFixture();
  f.expected.principal = principal;
  f.expected.checkpoint.issuance = {
    startedMono: 700,
    completedMono: 900,
    traceID: "8".repeat(32),
  };
  f.expected.deployment = {
    project: environment.project,
    runID: environment.runID,
  };
  f.expected.identityTransitions = environment.transitions;
  if (reason === "expired") {
    // Issued during the real login before SSE, with the five-second TTL.
    f.expected.checkpoint.expiresAt -= 1000;
    f.expected.checkpoint.idleExpiresAt -= 1000;
    f.expected.closedAt -= 1000;
    f.expected.closure.at -= 1000;
    f.expected.closure.observed_at_ms -= 1000;
    for (const span of [f.root, f.upstream, f.ui]) span.duration -= 1000000;
    for (const key of [
      "antnest.ui.stream.delegation_expires_at_unix_ms",
      "antnest.ui.stream.delegation_remaining_ms",
    ])
      f.ui.tags.find((field) => field.key === key).value -= 1000;
    f.login = originalLoginFixture();
    f.collection.traces.set(f.login.trace.traceID, f.login.trace);
    f.collection.archivedTraceIDs.add(f.login.trace.traceID);
    // The short login happened after the independently acknowledged rebuild.
    for (const transition of environment.transitions)
      for (const point of Object.values(transition.observation))
        if (typeof point === "object") point.at -= 5000;
  }
  const rejection = sessionRejectionFixture(
    reason === "unavailable" ? 503 : 401,
  );
  const denialStart = reason === "expired" ? 18300 : 4300;
  moveSessionTrace(
    rejection.trace,
    "f".repeat(32),
    (base + denialStart - 950) * 1000,
  );
  f.expected.denial = {
    ...rejection.expected,
    traceID: rejection.trace.traceID,
    credentialScope: f.expected.credentialScope,
    startedMono: denialStart,
    completedMono: denialStart + 300,
    startedAt: base + denialStart - 1000,
    completedAt: base + denialStart - 700,
    serverDate: new Date(base + denialStart - 950).toUTCString(),
    noStore: true,
    setCookieCount: 0,
    intentId: "00000000-0000-4000-8000-000000000009",
  };
  f.collection.traces.set(rejection.trace.traceID, rejection.trace);
  f.collection.archivedTraceIDs.add(rejection.trace.traceID);
  f.rejection = rejection;
  if (reason === "revoked") {
    const mutation = recoveryHTTPFixture().parts.find(
      (p) => p.action === "logout",
    );
    moveSessionTrace(mutation.trace, "e".repeat(32), (base + 1200) * 1000);
    f.expected.cause = {
      kind: "logout",
      path: "/api/session",
      method: "DELETE",
      status: 204,
      traceID: mutation.trace.traceID,
      credentialScope: f.expected.credentialScope,
      principal,
      startedMono: 2100,
      completedMono: 2500,
      startedAt: base + 1100,
      completedAt: base + 1500,
      serverDate: new Date(base + 1200).toUTCString(),
    };
    f.collection.traces.set(mutation.trace.traceID, mutation.trace);
    f.collection.archivedTraceIDs.add(mutation.trace.traceID);
    f.mutation = mutation;
  } else if (reason === "unavailable")
    f.expected.cause = {
      kind: "identity-outage",
      transition: environment.transitions[0],
    };
  else
    f.expected.cause = {
      kind: "absolute-expiry",
      expiresAt: f.expected.checkpoint.expiresAt,
      transition: environment.transitions[1],
    };
  if (reason !== "expired") {
    failureDiagnostic(f.root, undefined, "handler_aborted");
    f.root.logs = [
      {
        timestamp: f.root.startTime + f.root.duration,
        fields: Object.entries({
          event: "antnest.error",
          "antnest.error.panic_type": "*errors.errorString",
          "antnest.error.stage": "handler",
          "error.type": "handler_aborted",
        }).map(([key, value]) => ({ key, value })),
      },
    ];
    failureDiagnostic(
      f.upstream,
      "operation_failed",
      "Operation failed; unclassified error text was not exported",
      ["*errors.errorString"],
      "read_response",
    );
  } else f.expected.closure.kind = "remote-end";
  if (terminal) {
    const failed = sessionRejectionFixture(
      reason === "unavailable" ? 503 : 401,
    );
    moveSessionTrace(failed.trace, f.trace.traceID, (base + 2400) * 1000);
    const spans = failed.trace.spans.filter((s) => s !== failed.root);
    for (const span of spans) {
      span.spanID = "terminal-" + span.spanID;
      for (const ref of span.references ?? [])
        if (ref.spanID !== failed.root.spanID)
          ref.spanID = "terminal-" + ref.spanID;
    }
    f.trace.spans.push(...spans);
    f.terminal = {
      decision: failed.decision,
      client: failed.client,
      server: failed.server,
      sql: failed.database,
    };
  }
  for (const trace of f.collection.traces.values()) resource(trace);
  return f;
}
