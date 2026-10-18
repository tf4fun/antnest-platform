import assert from "node:assert/strict";
import { createRequire } from "node:module";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { applicationServices } from "./deployment.mjs";
import {
  assertStopped,
  assertReadyExecutionState,
} from "./shutdown-evidence.mjs";
import {
  tag,
  traceTopology,
  owningServerTopology,
} from "../observability/trace-tree.mjs";
import { privateACPProcessIdentity } from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { collectPrivateRestoreTrace } from "./restore-private-trace.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const validateState = new Ajv2020({ strict: false }).compile(schema);
const path = "/rpc/agent-acp/watch-agent-execution-state";
const reason = "shutdown-private-state-process-shutdown";
const reasons = new Set([reason]);
export const shutdownPrivateWatchOutcome = (results) =>
  privateACPStrictOutcome(results, reasons);

// Re-read the original bytes independently of the live observer's parsed view.
export function assertShutdownPrivateWatchReceipt(
  receipt,
  expected,
  remote = true,
) {
  assert.equal(receipt.agentId, expected.agentID);
  assert.deepEqual(receipt.principal, expected.principal);
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof receipt.principal[field] === "string" && receipt.principal[field],
    );
  assert.match(receipt.session_digest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.session_digest, expected.session_digest);
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.path, path);
  assert.deepEqual(receipt.request_body, {});
  assert.equal(receipt.traceID, expected.traceID);
  assert.equal(receipt.clientSpanID, expected.clientSpanID);
  assert.match(receipt.traceID, /^[a-f0-9]{32}$/u);
  assert.match(receipt.clientSpanID, /^[a-f0-9]{16}$/u);
  assert.equal(receipt.status, 200);
  assert(/^text\/event-stream(?:\s*;|$)/iu.test(receipt.content_type));
  if (receipt.response_trace_id != null)
    assert.equal(receipt.response_trace_id, receipt.traceID);
  assert.equal(receipt.joined, true);
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.body_outcome, remote ? "eof" : "cancelled");
  const raw = Buffer.from(receipt.raw_body_base64, "base64");
  assert.equal(raw.toString("base64"), receipt.raw_body_base64);
  assert.equal(raw.length, receipt.body_bytes);
  assert(raw.length > 0 && raw.length <= 1024 * 1024);
  const parts = new TextDecoder("utf-8", { fatal: true })
    .decode(raw)
    .split(/\r?\n\r?\n/u);
  assert.equal(parts.pop(), "", "incomplete original state watch frame");
  const events = [],
    terminal = [];
  for (const part of parts) {
    assert.equal(
      terminal.length,
      0,
      "event after terminal state watch envelope",
    );
    const match =
      /^event: (workspace_state|workspace_error)\r?\ndata: ([^\r\n]*)$/u.exec(
        part,
      );
    assert(match, "unexpected original state watch frame");
    const value = JSON.parse(match[2]);
    if (match[1] === "workspace_state") {
      assert(
        validateState(value),
        "invalid complete original state watch schema",
      );
      assert.equal(value.agent_id, expected.agentID);
      events.push(value);
    } else {
      assert(events.length > 0, "terminal state without initial delivery");
      assert.deepEqual(value, {
        code: "execution_state_unavailable",
        message: "Agent execution state is unavailable",
        retryable: true,
      });
      terminal.push(value);
    }
  }
  assert(events.length > 0 && events.length < 100);
  assertReadyExecutionState(events[0], expected.agentID);
  assert.deepEqual(receipt.events, events);
  assert.deepEqual(receipt.terminal_events, terminal);
  assert.equal(receipt.closure.kind, remote ? "transport-end" : "local-close");
  assert.equal(receipt.closure.traceID, receipt.traceID);
  assert.equal(receipt.closure.clientSpanID, receipt.clientSpanID);
  assert.equal(receipt.closure.receivedEvents, events.length);
  assert(Number.isSafeInteger(receipt.closure.observedAt));
  return events;
}

export function shutdownACPStop(expected) {
  const { stop, stopWindow: window } = expected;
  assert(
    stop &&
      [stop.liveAt, stop.startedAt, stop.completedAt].every(
        Number.isSafeInteger,
      ),
  );
  assert(
    stop.liveAt >= 0 &&
      stop.liveAt <= stop.startedAt &&
      stop.startedAt <= stop.completedAt,
  );
  assert.equal(window.start, stop.startedAt - 1000);
  assert.equal(window.end, stop.completedAt + 1000);
  assert.deepEqual(
    stop.before.map((row) => row.name).toSorted(),
    [...applicationServices, "temporal", "postgres"].toSorted(),
  );
  assertStopped(stop.project, stop.before, stop.after);
  const before = stop.before.find((row) => row.name === "agent-acp-service"),
    after = stop.after.find((row) => row.name === "agent-acp-service");
  assert(typeof before.hostname === "string" && before.hostname);
  assert.equal(after.hostname, before.hostname);
  assert.deepEqual(
    before.process,
    { pid: 1, hostname: before.hostname, argv: ["node", "dist/main.js"] },
    "original ACP namespace process receipt required",
  );
  const finished = Date.parse(after.finished);
  assert(
    finished >= window.start && finished <= window.end,
    "ACP stop outside observed maintenance",
  );
  return {
    before,
    after,
    finished,
    identity: [before.hostname, 1, `${before.hostname}:1`],
  };
}

function remove(fields, allowed) {
  assert.equal(
    new Set(fields.map((field) => field.key)).size,
    fields.length,
    "duplicate Shutdown diagnostic field",
  );
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(
      fields.find((field) => field.key === key)?.value,
      value,
      "contradictory Shutdown diagnostic field",
    );
  return fields.filter((field) => !Object.hasOwn(allowed, field.key));
}
function shutdownView(server) {
  assert.equal(server.logs?.length, 1, "one original Shutdown Error required");
  const event = server.logs[0],
    fields = Object.fromEntries(
      event.fields.map((field) => [field.key, field.value]),
    );
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= server.startTime &&
      event.timestamp <= server.startTime + server.duration,
    "Shutdown diagnostic outside owning span",
  );
  const types = fields["antnest.error.cause_types"],
    causes = fields["antnest.error.causes"];
  assert.deepEqual(typeof types === "string" ? JSON.parse(types) : types, []);
  assert.equal(typeof causes, "string");
  assert.deepEqual(JSON.parse(causes), [
    { type: "Error", message: "Error: unregistered message omitted" },
  ]);
  assert(
    tag(server, "error") === true ||
      tag(server, "otel.status_code") === "ERROR",
    "original Shutdown error status missing",
  );
  return {
    ...server,
    tags: remove(server.tags, {
      ...(tag(server, "error") !== undefined ? { error: true } : {}),
      ...(tag(server, "otel.status_code") !== undefined
        ? { "otel.status_code": "ERROR" }
        : {}),
      "error.type": "Error",
      "antnest.outcome": "error",
      "antnest.operation.phase": "agent.execution_state",
      "antnest.stream.termination": "process-shutdown",
    }),
    logs: [
      {
        ...event,
        fields: remove(event.fields, {
          event: "antnest.error",
          "antnest.error.stage": "agent.execution_state",
          "antnest.operation.phase": "agent.execution_state",
          "antnest.error.type": "Error",
          "antnest.error.message": "Error: unregistered message omitted",
          "antnest.error.cause_types": types,
          "antnest.error.causes": causes,
        }),
      },
    ],
  };
}

export function inspectShutdownPrivateWatchTrace(
  trace,
  expected,
  secrets = [],
  options = {},
) {
  assert.equal(expected.kind, "private_state_watch");
  assert.equal(trace.traceID, expected.traceID);
  const sources = resolveTraceSources(trace, secrets, options);
  assert.equal(
    sources.length,
    1,
    "private watch has unexpected source dependencies",
  );
  assertShutdownPrivateWatchReceipt(expected.receipt, expected);
  assert.deepEqual(expected.closure, expected.receipt.closure);
  const stop = shutdownACPStop(expected),
    tree = traceTopology(trace);
  const { closure, stopWindow: window } = expected;
  assert(
    closure.observedAt >= expected.stop.startedAt &&
      closure.observedAt <= window.end,
    "remote private closure outside actual stop",
  );
  const roots = trace.spans.filter((span) => tree.parent(span) === undefined);
  assert.equal(roots.length, 1, "one actual exported watch CLIENT required");
  const readinessRows = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === "postgres.ready",
  );
  assert.equal(
    readinessRows.length,
    1,
    "one actual ACP readiness check required",
  );
  const [readiness] = readinessRows;
  const owner = tree.parent(readiness);
  assert.equal(tag(readiness, "span.kind"), "internal");
  assert.equal(tag(readiness, "db.system.name"), "postgresql");
  assert.equal(tag(readiness, "db.query.text"), undefined);
  for (const field of [
    ...(readiness.tags ?? []),
    ...(readiness.logs ?? []).flatMap((event) => event.fields ?? []),
  ])
    assert(
      !["pgx.query.parameters", "db.connection_string"].includes(field.key) &&
        !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
          field.key,
        ),
      "readiness SQL parameters/results or connection string captured",
    );
  assert.equal(tree.service(owner), "agent-acp-service");
  assert.equal(tag(owner, "span.kind"), "server");
  assert.equal(tag(owner, "http.route"), path);
  const readySQL = trace.spans.filter(
    (span) =>
      tag(span, "db.query.text") !== undefined &&
      tree.chain(span).includes(readiness),
  );
  assert.equal(readySQL.length, 1, "readiness must own its original SELECT");
  assert.equal(readySQL[0].operationName, "SELECT");
  assert.equal(tag(readySQL[0], "db.query.text").trim(), "SELECT 1");
  // The owning service's dependency check intentionally wraps its driver call.
  // Elide only this proven readiness wrapper in a validation view; the original
  // raw ancestry, spans and diagnostics remain unchanged and are checked below.
  const databaseView = {
    ...trace,
    spans: trace.spans
      .filter((span) => span !== readiness)
      .map((span) =>
        tree.parent(span) === readiness
          ? {
              ...span,
              references: span.references.map((ref) =>
                ref.refType === "CHILD_OF"
                  ? { ...ref, spanID: owner.spanID }
                  : ref,
              ),
            }
          : span,
      ),
  };
  const { server, client, database } = owningServerTopology(databaseView, {
    service: "agent-acp-service",
    route: path,
    method: "POST",
    rpcMethod: "watch_agent_execution_state",
    clientService: "antnest-private-acp-client",
    clientSpanID: expected.clientSpanID,
    status: 200,
  });
  assert.equal(roots[0], client);
  assert.equal(client.operationName, "HTTP POST agent-acp-workspace");
  assert.equal(tag(client, "antnest.protocol.version"), "v1");
  assert.equal(tag(client, "http.response.status_code"), 200);
  assert.equal(
    tag(client, "http.response.body.size"),
    expected.receipt.body_bytes,
  );
  assert.equal(tag(client, "antnest.outcome"), "eof");
  assert.equal(tag(client, "antnest.http.body.outcome"), "eof");
  assert.equal(server.operationName, "HTTP POST " + path);
  for (const [key, value] of Object.entries({
    "rpc.service": "agent-acp",
    "rpc.system.name": "json-over-http",
    "antnest.listener": "workspace",
    "antnest.agent.id": expected.agentID,
    "antnest.organization.id": expected.principal.organization_id,
  }))
    assert.equal(tag(server, key), value);
  const serverEnd = (server.startTime + server.duration) / 1000;
  assert(
    server.duration > 0 && serverEnd >= window.start && serverEnd <= window.end,
    "private watch did not finish in maintenance window",
  );
  const view = shutdownView(server);
  for (const span of trace.spans) {
    assert(
      Number.isFinite(span.startTime) &&
        Number.isFinite(span.duration) &&
        span.duration >= 0,
    );
    assert(
      tree.chain(span).includes(client),
      "detached private state dependency",
    );
    assert.deepEqual(
      span.references ?? [],
      span === client
        ? []
        : [
            {
              refType: "CHILD_OF",
              traceID: trace.traceID,
              spanID: tree.parent(span).spanID,
            },
          ],
    );
    if (span !== client) {
      assert.equal(tree.service(span), "agent-acp-service");
      assert.deepEqual(
        privateACPProcessIdentity(trace, span),
        stop.identity,
        "watch belongs to another ACP process",
      );
      assert(
        (span.startTime + span.duration) / 1000 <= stop.finished + 1,
        "work outlived stopped ACP process",
      );
      if (span !== server) {
        assert(tree.chain(span).includes(server));
        assert.equal(
          tag(span, "db.system.name"),
          "postgresql",
          "unaccounted private watch activity",
        );
      }
    }
    assertSessionSuccess(
      span === server ? view : span,
      span === client
        ? { "antnest.outcome": "eof", "antnest.http.body.outcome": "eof" }
        : {},
    );
  }
  const report = {
    owned_error_spans: [
      { trace_id: trace.traceID, span_id: server.spanID, reason },
    ],
  };
  return {
    ...resolveTraceDiagnostics(trace, sources),
    ...privateACPDiagnosticInventory(sources, [report], reasons),
    topology: "passed",
    kind: expected.kind,
    trace_id: trace.traceID,
    client_span_id: client.spanID,
    agent_id: expected.agentID,
    server_span_id: server.spanID,
    database_spans: database.length,
    stop_window_verified: true,
    remote_closure_verified: true,
    closure: structuredClone(closure),
  };
}

export async function collectShutdownPrivateWatchTrace(
  base,
  expected,
  options = {},
) {
  const { flush, secrets = [], ...collection } = options;
  assert.equal(
    typeof flush,
    "function",
    "actual private CLIENT flush required",
  );
  await flush();
  const attempts = collection.attempts ?? 40;
  assert(Number.isSafeInteger(attempts) && attempts >= 3);
  const [result] = await collectResolveTraceEvidence(
    base,
    [expected],
    secrets,
    { ...collection, attempts, inspect: inspectShutdownPrivateWatchTrace },
  );
  return result;
}
export function collectPrivateShutdownTrace(base, expected, options) {
  if (expected.kind === "private_state_watch")
    return collectShutdownPrivateWatchTrace(base, expected, options);
  assert(
    ["initialize", "session/new", "session/load"].includes(expected.method),
  );
  assert.equal(expected.kind, "request");
  return collectPrivateRestoreTrace(base, expected, options);
}
