import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { notificationTraceFixture } from "../identity-closeout/private-acp-notification.fixture.mjs";
import { set } from "./trace.fixture.mjs";

const source = (name) =>
  readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
function query(name, prefix, suffix = "") {
  const normalize = (text) => text.replace(/\s+/gu, " ").trim();
  const candidates = [...source(name).matchAll(/`([^`]+)`|"([^"\n]+)"/gu)]
    .map((match) => match[1] ?? match[2])
    .filter(
      (text) =>
        normalize(text).startsWith(prefix) && normalize(text).endsWith(suffix),
    );
  assert.equal(candidates.length, 1);
  return candidates[0];
}
const sessionRead = query(
  "session-repository",
  "SELECT id, organization_id",
  "FROM acp_sessions WHERE id = $1",
);
const temporarySource = source("temporary-skills");
const temporaryRead = temporarySource
  .match(/public async forAgent\([\s\S]*?`([^`]+)`/u)[1]
  .replace(
    "${storedReference}",
    temporarySource.match(/const storedReference = `([^`]+)`/u)[1],
  );
const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));
function builders(f) {
  const add = (id, parent, operationName, startTime, duration, tags = {}) => {
    const span = {
      spanID: id,
      traceID: f.trace.traceID,
      processID: (f.request ?? f.root).processID,
      operationName,
      startTime,
      duration,
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: parent.spanID,
        },
      ],
      tags: fields(tags),
      logs: [],
    };
    f.trace.spans.push(span);
    return span;
  };
  const sql = (id, parent, text, startTime) => {
    const operation = text.trim().split(/\s/u)[0];
    return add(id, parent, operation, startTime, 100, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": operation,
      "db.query.text": text,
    });
  };
  return { ...f, add, sql, set };
}

export function barrierTraceFixture(version = 1) {
  const f = builders(
    privatePlanRequestFixture({ version, method: "session/prompt" }),
  );
  Object.assign(f.expected, {
    kind: "request",
    outcome: "rejected",
    rejection: "runtime_barrier_required",
    rejectionReceipt: {
      rpcCode: -32020,
      code: "runtime_barrier_required",
      retryable: false,
    },
  });
  Object.assign(f.request, { startTime: 2000, duration: 14000, logs: [] });
  Object.assign(f.application, { startTime: 3000, duration: 12000 });
  const code = "runtime_barrier_required",
    message = "Operation reported runtime_barrier_required";
  for (const [key, value] of Object.entries({
    "error.type": "DomainError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.session.prompt",
    "error.code": code,
    "antnest.error.code": code,
  }))
    set(f.application, key, value);
  f.application.logs = [
    {
      timestamp: 14000,
      fields: fields({
        event: "antnest.error",
        "antnest.error.stage": "acp.session.prompt",
        "antnest.operation.phase": "acp.session.prompt",
        "antnest.error.type": "DomainError",
        "antnest.error.code": code,
        "antnest.error.message": message,
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "DomainError", code, message },
        ]),
      }),
    },
  ];
  for (const [key, value] of Object.entries({
    "error.type": "RequestError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.dispatch",
    "error.code": "-32020",
    "antnest.error.code": "-32020",
    "rpc.response.status_code": -32020,
    "antnest.error.origin_trace_id": f.trace.traceID,
    "antnest.error.origin_span_id": f.application.spanID,
  }))
    set(f.request, key, value);
  const queries = [
    sessionRead,
    query("session-repository", "SELECT encrypted_sources, nonce"),
    temporaryRead,
    query("run-repository", "SELECT id, organization_id"),
    query("execution-repository", "SELECT EXISTS ("),
  ];
  f.queries = queries.map((text, index) =>
    f.sql(`read-${index}`, f.application, text, 4000 + index * 1500),
  );
  return f;
}

export async function cancelTraceFixture(t, version = 1) {
  const f = builders(await notificationTraceFixture(t, version));
  Object.assign(f.root, { startTime: 2000, duration: 18000, logs: [] });
  f.application = f.add(
    "cancel-application",
    f.root,
    "acp.session.cancel",
    3000,
    16000,
    {
      "span.kind": "internal",
      "agent.id": "agent",
      "antnest.agent.id": "agent",
      "session.id": "session",
      "antnest.session.id": "session",
      "antnest.outcome": "ok",
    },
  );
  f.authorization = f.sql("authorization", f.application, sessionRead, 4000);
  f.transaction = f.add(
    "cancel-transaction",
    f.application,
    "postgresql transaction",
    6000,
    9000,
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    },
  );
  const queries = [
    "BEGIN",
    query(
      "session-repository",
      "SELECT id, organization_id",
      "FROM acp_sessions WHERE id = $1 FOR UPDATE",
    ),
    query(
      "session-repository",
      "UPDATE runs SET cancel_requested_at",
      "WHERE session_id = $1 AND state IN ('admitting', 'running')",
    ),
    "COMMIT",
  ];
  f.queries = queries.map((text, index) =>
    f.sql(`transaction-${index}`, f.transaction, text, 7000 + index * 1500),
  );
  return f;
}
