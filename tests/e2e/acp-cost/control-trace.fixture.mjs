import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import {
  privateHTTPFixture,
  privateHTTPRejectionFixture,
} from "../acp-commands/trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";

const repository = readFileSync(
  new URL(
    "../../../services/agent-acp-service/src/adapters/postgres/session-repository.ts",
    import.meta.url,
  ),
  "utf8",
);
const statements = [...repository.matchAll(/`([^`]+)`/gu)].map(
  (match) => match[1],
);
const matches = statements.filter(
  (text) =>
    text.trim().startsWith("SELECT id, organization_id") &&
    text.trim().endsWith("FROM acp_sessions WHERE id = $1"),
);
assert.equal(matches.length, 1);
const sessionRead = matches[0];

export function costControlTraceFixture({
  version = 1,
  http = false,
  sameSpan = false,
  method = "initialize",
  catalog = false,
} = {}) {
  const initialize = method === "initialize";
  const rejection =
    method === "session/new" ? "access_denied" : "session_access_denied";
  const f = initialize
    ? http
      ? privateHTTPFixture("request", { method, sameSpan })
      : privateBoundaryFixture(requestFixture(method), { version })
    : http
      ? privateHTTPRejectionFixture(rejection, { method, sameSpan })
      : privatePlanRequestFixture({ version, method, denial: rejection });
  const { trace, expected, request } = f;
  const add = (...args) => {
    const processes = { ...trace.processes };
    const span = f.add(...args);
    Object.assign(trace.processes, processes);
    return span;
  };
  Object.assign(expected, {
    kind: "request",
    version,
    protocolVersion: version,
    inputSessionID: initialize || method === "session/new" ? null : "session",
    sessionId: initialize || method === "session/new" ? undefined : "session",
    outcome: initialize ? "succeeded" : "rejected",
    ...(initialize ? {} : { rejection }),
  });
  setTag(request, "antnest.session.id", expected.sessionId);
  request.startTime = 2000;
  request.duration = 30000;
  const sql = (id, owner, query, time) =>
    add(id, owner.spanID, "SELECT", undefined, time, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
      "db.query.text": query,
    });
  let authorization;
  if (f.application) {
    f.application.startTime = 3000;
    f.application.duration = 10000;
    for (const event of f.application.logs) event.timestamp = 12000;
    setTag(f.application, "agent.id", expected.agentId);
    setTag(f.application, "session.id", expected.inputSessionID ?? undefined);
    if (rejection === "session_access_denied")
      authorization = sql("authorization", f.application, sessionRead, 4000);
  }
  let readiness, readyQuery;
  if (http) {
    if (!sameSpan) {
      f.receiver.startTime = 1000;
      f.receiver.duration = 1000;
    }
    readiness = add(
      "ready",
      f.receiver.spanID,
      "postgres.ready",
      undefined,
      f.receiver.startTime + 20,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
      },
    );
    readiness.duration = 50;
    readyQuery = sql(
      "ready-query",
      readiness,
      "SELECT 1",
      readiness.startTime + 10,
    );
  }
  if (initialize) {
    const info = {
      name: "antnest-agent-acp-service",
      title: "Antnest Agent",
      version: "0.1.0",
    };
    expected.initializationResult =
      version === 1
        ? {
            protocolVersion: 1,
            agentInfo: info,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {},
              mcpCapabilities: {},
              sessionCapabilities: {
                list: {},
                delete: {},
                fork: {},
                resume: {},
                close: {},
              },
            },
            _meta: {
              "antnest.dev/skill-commands": { version: 1, commands: [] },
            },
          }
        : {
            protocolVersion: 2,
            info,
            capabilities: { session: { delete: {}, fork: {}, prompt: {} } },
          };
  }
  let catalogProof;
  if (catalog) {
    const offset = trace.spans.length;
    catalogProof = addCompletedRead(trace, request, "http", expected.agentId, {
      preserveRequest: true,
      runtimeOutcome: "success",
      clientOutcome: "success",
    });
    const delta = 2500 - catalogProof.read.startTime;
    for (const span of trace.spans.slice(offset)) {
      span.startTime += delta;
      for (const event of span.logs ?? []) event.timestamp += delta;
    }
  }
  return {
    ...f,
    add,
    set: setTag,
    authorization,
    readiness,
    readyQuery,
    catalog: catalogProof,
    requests: [],
  };
}
