import { readFileSync } from "node:fs";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { privateHTTPFixture } from "../acp-commands/trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const source = (name) =>
  readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
const configuration = source("session-configuration");
const sessions = source("session-repository");
// Fixtures read owning SQL independently of the inspector's expected contract.
const update = configuration.match(/`(UPDATE acp_sessions[\s\S]*?)`/u)[1];
const insert = configuration.match(
  /`(INSERT INTO session_messages[\s\S]*?)`/u,
)[1];
const configurationRead = configuration.match(
  /"(SELECT configuration,[^"]+)"/u,
)[1];
const sessionRead = sessions.match(/public async get\([\s\S]*?`([^`]+)`/u)[1];
const list = sessions.match(/public async list\([\s\S]*?`([^`]+)`/u)[1];
const outputRead = sessions.match(
  /public async readOutput\([\s\S]*?`([^`]+)`/u,
)[1];

export function costConfigurationTraceFixture({
  version = 1,
  http = false,
  sameSpan = false,
  method = "session/set_config_option",
  outputReads = 1,
} = {}) {
  const listing = method === "session/list";
  const f = http
    ? privateHTTPFixture("request", { method, sameSpan })
    : privatePlanRequestFixture({ version, method });
  const { trace, expected, request } = f;
  const add = (...args) => {
    const processes = { ...trace.processes };
    const span = f.add(...args);
    Object.assign(trace.processes, processes);
    return span;
  };
  Object.assign(expected, {
    kind: "request",
    outcome: "succeeded",
    version,
    inputSessionID: listing ? null : "session",
    sessionId: listing ? undefined : "session",
  });
  setTag(request, "antnest.session.id", expected.sessionId);
  request.startTime = 2000;
  request.duration = 30000;
  const application =
    f.application ?? add("application", request.spanID, "application");
  application.operationName = listing
    ? "acp.session.list"
    : "acp.session.set_configuration";
  application.startTime = 3000;
  application.duration = 18000;
  for (const [key, value] of Object.entries({
    "span.kind": "internal",
    "agent.id": expected.agentId,
    "antnest.agent.id": expected.agentId,
    "session.id": expected.sessionId,
    "antnest.session.id": expected.sessionId,
  }))
    setTag(application, key, value);
  const sql = (id, parent, query, time) =>
    add(id, parent.spanID, query.trim().split(/\s/u)[0], undefined, time, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": query.trim().split(/\s/u)[0],
      "db.query.text": query,
    });
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
      "ready-sql",
      readiness,
      "SELECT 1",
      readiness.startTime + 10,
    );
  }
  let transaction;
  const queries = [];
  const outputs = [];
  if (listing) {
    queries.push(sql("list", application, list, 6000));
    expected.listSessionIds = ["observer-session"];
    expected.listReceipt = {
      requestId: expected.requestId,
      params: {},
      result: {
        sessions: [
          {
            sessionId: "observer-session",
            cwd: "/workspace",
            updatedAt: "2026-10-16T00:00:00.000Z",
          },
        ],
      },
    };
  } else {
    for (let index = 0; index < outputReads; index++) {
      const start = index === 0 ? 2100 : 22000 + index * 1500;
      const output = add(
        `output-${index}`,
        request.spanID,
        "acp.session.output",
        undefined,
        start,
        {
          "span.kind": "internal",
          "agent.id": expected.agentId,
          "antnest.agent.id": expected.agentId,
          "session.id": expected.sessionId,
          "antnest.session.id": expected.sessionId,
          "antnest.operation.phase": "read",
        },
      );
      output.duration = 600;
      outputs.push({
        application: output,
        queries: [sessionRead, outputRead, sessionRead, configurationRead].map(
          (query, offset) =>
            sql(
              `output-${index}-sql-${offset}`,
              output,
              query,
              start + 100 * (offset + 1),
            ),
        ),
      });
    }
    queries.push(sql("session-read", application, sessionRead, 4000));
    queries.push(
      sql("configuration-read", application, configurationRead, 5000),
    );
    transaction = add(
      "transaction",
      application.spanID,
      "postgresql transaction",
      undefined,
      6000,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      },
    );
    transaction.duration = 15000;
    const statements = [
      ["begin", "BEGIN"],
      ["lock-timeout", "SET LOCAL lock_timeout = '5s'"],
      ["statement-timeout", "SET LOCAL statement_timeout = '10s'"],
      ["update", update],
      ["insert", insert],
      ["commit", "COMMIT"],
    ];
    for (const [index, [id, query]] of statements.entries())
      queries.push(sql(id, transaction, query, 7000 + index * 2000));
    expected.modelSelection = "profile:priced-model";
    expected.configurationReceipt = {
      requestId: expected.requestId,
      params: {
        sessionId: expected.sessionId,
        configId: "model",
        value: expected.modelSelection,
        ...(version === 2 ? { type: "id" } : {}),
      },
      result: {
        configOptions: [
          {
            [version === 1 ? "id" : "configId"]: "model",
            name: "Model",
            type: "select",
            currentValue: expected.modelSelection,
            options: [{ value: expected.modelSelection, name: "Priced model" }],
          },
        ],
      },
    };
  }
  return {
    ...f,
    add,
    application,
    transaction,
    readiness,
    readyQuery,
    queries,
    outputs,
    requests: [],
    set: setTag,
    query: (id) => queries.find((span) => span.spanID === id),
  };
}
