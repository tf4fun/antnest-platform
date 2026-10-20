import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { privateHTTPFixture } from "../acp-commands/trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";

const source = (name) =>
  readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const statements = [
  ...new Set(
    [...source("session-repository").matchAll(/`([^`]+)`|"([^"\n]+)"/gu)].map(
      (match) => match[1] ?? match[2],
    ),
  ),
];
const query = (prefix, suffix = "") => {
  const matches = statements.filter(
    (sql) =>
      normalize(sql).startsWith(prefix) && normalize(sql).endsWith(suffix),
  );
  assert.equal(matches.length, 1, prefix + " / " + suffix);
  return matches[0];
};
const sessionRead = query(
  "SELECT id, organization_id",
  "FROM acp_sessions WHERE id = $1",
);
const sessionLock = query(
  "SELECT id, organization_id",
  "FROM acp_sessions WHERE id = $1 FOR UPDATE",
);
const outputRead = query("SELECT s.last_message_sequence AS sequence");
const configurationRead = source("session-configuration").match(
  /"(SELECT configuration,[^"]+)"/u,
)[1];
const mcpRead = query("SELECT encrypted_sources, nonce");
const mcpInsert = query("INSERT INTO client_mcp_revisions(");
const mcpPointer = query(
  "UPDATE acp_sessions SET client_mcp_revision_id = $2 WHERE id = $1",
);
const newQueries = [
  "BEGIN",
  query(
    "INSERT INTO acp_sessions( id, principal_id, agent_id, cwd, state, client_mcp_revision_id",
  ),
  mcpInsert,
  mcpPointer,
  "COMMIT",
];
const replayQueries = ["BEGIN", sessionLock, mcpRead, "COMMIT"];
const forkQueries = [
  "BEGIN",
  sessionLock,
  query("SELECT 1 FROM runs"),
  query(
    "INSERT INTO acp_sessions( id, principal_id, agent_id, cwd, state, title",
  ),
  mcpInsert,
  query(
    "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at, context_excluded",
  ),
  query("INSERT INTO context_checkpoints("),
  query("UPDATE acp_sessions SET configuration = source.configuration"),
  mcpPointer,
  "COMMIT",
];

export function costSessionTraceFixture({
  version = 1,
  http = false,
  sameSpan = false,
  method = "session/new",
  outputReads,
  catalog = false,
  modelSelection = "agent_default",
} = {}) {
  const f = http
    ? privateHTTPFixture("request", { method, sameSpan })
    : privatePlanRequestFixture({ version, method });
  const { trace, expected, request } = f;
  const add = (...args) => {
    const resources = { ...trace.processes };
    const span = f.add(...args);
    Object.assign(trace.processes, resources);
    return span;
  };
  const creating = method === "session/new",
    forking = method === "session/fork";
  outputReads ??= version === 2 && (creating || forking) ? 2 : 1;
  const target = creating
    ? "new-session"
    : forking
      ? "forked-session"
      : "session";
  Object.assign(expected, {
    kind: "request",
    outcome: "succeeded",
    version,
    protocolVersion: version,
    inputSessionID: creating ? null : "session",
    sessionId: target,
  });
  setTag(request, "antnest.session.id", target);
  request.startTime = 2000;
  request.duration = 30000;
  const application =
    f.application ?? add("application", request.spanID, "application");
  application.operationName = `acp.session.${creating ? "new" : forking ? "fork" : "resume"}`;
  application.startTime = 3000;
  application.duration = 12000;
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "agent.id": expected.agentId,
    "antnest.agent.id": expected.agentId,
    "session.id": expected.inputSessionID ?? undefined,
    "antnest.session.id": expected.inputSessionID ?? undefined,
  }))
    setTag(application, key, value);
  const sql = (id, owner, text, time) =>
    add(id, owner.spanID, text.trim().split(/\s/u)[0], undefined, time, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": text.trim().split(/\s/u)[0],
      "db.query.text": text,
    });
  const queries = [],
    direct = [];
  if (!creating)
    direct.push(sql("authorization", application, sessionRead, 3500));
  const transaction = add(
    "transaction",
    application.spanID,
    "postgresql transaction",
    undefined,
    4000,
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    },
  );
  transaction.duration = 6000;
  for (const [index, text] of (creating
    ? newQueries
    : forking
      ? forkQueries
      : replayQueries
  ).entries())
    queries.push(sql(`tx-${index}`, transaction, text, 4100 + index * 500));
  if (!creating && !forking)
    direct.push(sql("replay-snapshot", application, outputRead, 11000));
  const outputs = [];
  const scoped = (id, name, time) =>
    add(id, request.spanID, name, undefined, time, {
      "span.kind": "internal",
      "agent.id": expected.agentId,
      "antnest.agent.id": expected.agentId,
      "session.id": target,
      "antnest.session.id": target,
      ...(name === "acp.session.output"
        ? { "antnest.operation.phase": "read" }
        : {}),
    });
  for (let index = 0; index < outputReads; index++) {
    const output = scoped(
      `output-${index}`,
      "acp.session.output",
      16000 + index * 2000,
    );
    output.duration = 1000;
    outputs.push({
      application: output,
      queries: [sessionRead, outputRead, sessionRead, configurationRead].map(
        (text, offset) =>
          sql(
            `output-${index}-${offset}`,
            output,
            text,
            output.startTime + 100 + offset * 150,
          ),
      ),
    });
  }
  const configuration = scoped(
    "configuration",
    "acp.session.get_configuration",
    23000,
  );
  configuration.duration = 1000;
  const configurationQueries = [sessionRead, configurationRead].map(
    (text, index) =>
      sql(`configuration-${index}`, configuration, text, 23100 + index * 100),
  );
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
      { "span.kind": "internal", "db.system.name": "postgresql" },
    );
    readiness.duration = 50;
    readyQuery = sql(
      "ready-sql",
      readiness,
      "SELECT 1",
      readiness.startTime + 10,
    );
  }
  let catalogProof;
  if (catalog) {
    const start = trace.spans.length;
    catalogProof = addCompletedRead(trace, request, "http", expected.agentId, {
      preserveRequest: true,
      runtimeOutcome: "success",
      clientOutcome: "success",
    });
    const delta = 25000 - catalogProof.read.startTime;
    for (const span of trace.spans.slice(start)) {
      span.startTime += delta;
      for (const event of span.logs ?? []) event.timestamp += delta;
    }
  }
  expected.requestReceipt = {
    requestId: expected.requestId,
    params: {
      cwd: "/workspace",
      mcpServers: [],
      ...(!creating ? { sessionId: expected.inputSessionID } : {}),
      ...(method === "session/resume" ? { replayFrom: { type: "start" } } : {}),
    },
    result: {
      ...(creating || forking ? { sessionId: target } : {}),
      configOptions: [
        {
          [version === 1 ? "id" : "configId"]: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: modelSelection,
          options: [
            {
              [version === 1 ? "group" : "groupId"]: "agent",
              name: "Agent",
              options: [{ value: "agent_default", name: "Agent default" }],
            },
            {
              [version === 1 ? "group" : "groupId"]: "Cost provider",
              name: "Cost provider",
              options: [{ value: "profile:cost-priced", name: "Cost priced" }],
            },
          ],
        },
        {
          [version === 1 ? "id" : "configId"]: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent_default",
          options: [
            { value: "agent_default", name: "Agent default: default" },
            { value: "default", name: "Default" },
          ],
        },
      ],
      ...(version === 1
        ? {
            modes: {
              currentModeId: "default",
              availableModes: [{ id: "default", name: "Default" }],
            },
          }
        : {}),
    },
  };
  return {
    ...f,
    add,
    set: setTag,
    application,
    transaction,
    direct,
    queries,
    outputs,
    configuration,
    configurationQueries,
    readiness,
    readyQuery,
    catalog: catalogProof,
    requests: [],
  };
}
