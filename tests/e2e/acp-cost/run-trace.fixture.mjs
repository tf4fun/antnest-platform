import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nativeTraceFixture } from "../acp-multimodal/private-trace.fixture.mjs";

const source = (name) =>
  readFileSync(
    new URL(
      `../../../services/agent-acp-service/src/adapters/postgres/${name}.ts`,
      import.meta.url,
    ),
    "utf8",
  );
const normalize = (sql) => sql.replace(/\s+/gu, " ").trim();
const actualQuery = (name, prefix) => {
  const matches = [...source(name).matchAll(/`([^`]+)`|"([^"\n]+)"/gu)]
    .map((match) => match[1] ?? match[2])
    .filter((sql) => normalize(sql).startsWith(prefix));
  assert.equal(matches.length, 1, `${name}: ${prefix}`);
  return matches[0];
};
const events = source("run-event-repository");
const sessions = source("session-repository");
const quoted = [...events.matchAll(/"((?:SELECT|UPDATE) [^"\n]+)"/gu)].map(
  (match) => match[1],
);
const query = (prefix) => {
  const matches = quoted.filter((sql) => sql.startsWith(prefix));
  assert.equal(matches.length, 1);
  return matches[0];
};
const lock = [
  query("SELECT session_id FROM runs"),
  query("SELECT last_message_sequence"),
  actualQuery(
    "run-event-repository",
    "SELECT session_id, state, organization_id, agent_id, execution_owner_registration_id,",
  ),
];
const insert = events.match(
  /`(INSERT INTO session_messages\([^`]*?\$8\))`/u,
)[1];
const update = query(
  "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
);
const storedUsage = query(
  "SELECT run_id, session_id, kind, visible, payload, created_at FROM session_messages",
);
const previousUsage = query(
  "SELECT payload FROM session_messages WHERE session_id",
);
const sessionRead = sessions.match(/public async get\([\s\S]*?`([^`]+)`/u)[1];
const outputRead = sessions.match(
  /public async readOutput\([\s\S]*?`([^`]+)`/u,
)[1];
const configurationRead = source("session-configuration").match(
  /"(SELECT configuration,[^"]+)"/u,
)[1];
const mcpRevisionRead = actualQuery(
  "session-repository",
  "SELECT encrypted_sources, nonce",
);
const temporaryReference = source("temporary-skills").match(
  /const storedReference = `([^`]+)`/u,
)[1];
const temporaryRead = (method) =>
  source("temporary-skills")
    .match(
      new RegExp(`public async ${method}\\([\\s\\S]*?\x60([^\x60]+)\x60`, "u"),
    )[1]
    .replace("${storedReference}", temporaryReference);
const admissionReads = [
  sessionRead,
  mcpRevisionRead,
  temporaryRead("forAgent"),
  actualQuery("run-repository", "SELECT id, organization_id"),
  actualQuery("execution-repository", "SELECT EXISTS ("),
];
const intentQueries = [
  "BEGIN",
  actualQuery(
    "run-repository",
    "SELECT organization_id, agent_id, state, client_mcp_revision_id, configuration, append_version",
  ),
  actualQuery(
    "run-repository",
    "SELECT id FROM runs WHERE session_id = $1 AND state IN ('admitting', 'running') LIMIT 1",
  ),
  actualQuery("run-repository", "INSERT INTO runs("),
  actualQuery("run-repository", "UPDATE acp_sessions SET append_version"),
  "COMMIT",
];
const environmentInsert = actualQuery(
  "run-repository",
  "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) SELECT $1, session_id, id, $2, 'environment_change'",
);
const acceptanceQueries = [
  "BEGIN",
  actualQuery("run-repository", "SELECT session_id FROM runs WHERE id"),
  actualQuery(
    "run-repository",
    "SELECT organization_id, agent_id, state, last_message_sequence",
  ),
  actualQuery(
    "run-repository",
    "SELECT session_id, organization_id, agent_id, client_mcp_revision_id, state, cancel_requested_at",
  ),
  actualQuery(
    "run-repository",
    "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) SELECT pending_user_message_id, session_id, id, $2, 'user_message'",
  ),
  actualQuery("run-repository", "UPDATE runs SET state = 'running'"),
  actualQuery(
    "run-repository",
    "UPDATE acp_sessions SET last_execution_revision",
  ),
  "COMMIT",
];
const contextReads = [
  actualQuery(
    "context-repository",
    "SELECT ratio_p95 FROM model_token_calibration",
  ),
  actualQuery("context-repository", "SELECT through_sequence, summary"),
  actualQuery("context-repository", "SELECT id,sequence,kind,payload"),
  actualQuery("context-repository", "SELECT sequence, kind, payload"),
  actualQuery("context-repository", "SELECT payload FROM session_messages"),
];
const checkpointInsert = actualQuery(
  "context-repository",
  "INSERT INTO context_checkpoints(",
);

export function costRunTraceFixture({
  version = 1,
  http = false,
  sameSpan = false,
  action = "estimated",
  model = "priced-model",
  environmentChange = true,
  checkpoint = false,
} = {}) {
  const f = nativeTraceFixture({ version, http, sameSpan });
  const { trace, expected } = f;
  Object.assign(expected, {
    outcome: "succeeded",
    inputSessionID: expected.sessionId,
    phase: `v${version}-${http ? "http" : "ws"}:${action}`,
  });
  const admission = f.add(
    "admission",
    f.request.spanID,
    "acp.session.prompt",
    undefined,
    2100,
    {
      "span.kind": "internal",
      "agent.id": expected.agentId,
      "antnest.agent.id": expected.agentId,
      "session.id": expected.sessionId,
      "antnest.session.id": expected.sessionId,
      "antnest.operation.phase": "admit",
    },
  );
  admission.duration = 800;
  f.run.references[0].spanID = admission.spanID;
  f.set(f.model, "model.name", model);
  Object.assign(f.requests[0], { phase: expected.phase, model });
  f.model.duration = 9000;
  f.transaction.startTime = 12000;
  f.transaction.duration = 2000;
  trace.spans = trace.spans.filter(
    (span) => span !== f.insert && span !== f.outputRead,
  );
  const sql = (id, owner, text, time) =>
    f.add(id, owner.spanID, text.trim().split(/\s/u)[0], undefined, time, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": text.trim().split(/\s/u)[0],
      "db.query.text": text,
    });
  const admissionQueries = admissionReads.map((text, index) =>
    sql(`admission-read-${index}`, admission, text, 2110 + index * 10),
  );
  const transaction = (id, time, queries) => {
    const span = f.add(
      id,
      admission.spanID,
      "postgresql transaction",
      undefined,
      time,
      {
        "span.kind": "internal",
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      },
    );
    span.duration = 150;
    return {
      span,
      queries: queries.map((text, index) =>
        sql(`${id}-${index}`, span, text, time + 10 + index * 10),
      ),
    };
  };
  const intent = transaction("intent", 2200, intentQueries);
  const accepted = [...acceptanceQueries];
  if (environmentChange) accepted.splice(4, 0, environmentInsert);
  const acceptance = transaction("acceptance", 2400, accepted);
  const context = contextReads.map((text, index) =>
    sql(`context-${index}`, f.run, text, 8000 + index * 100),
  );
  const savedCheckpoint = checkpoint
    ? sql("checkpoint", f.run, checkpointInsert, 8500)
    : undefined;
  const temporaryCleanupRead = sql(
    "temporary-run",
    f.run,
    temporaryRead("forRun"),
    19920,
  );
  const catalogRevisionRead = sql(
    "catalog-mcp",
    f.information.list,
    mcpRevisionRead,
    f.information.list.startTime + 10,
  );
  let readiness, readyQuery;
  if (http) {
    readiness = f.add(
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
  const reply = ["BEGIN", ...lock, storedUsage, insert, update, "COMMIT"].map(
    (text, index) =>
      sql(`reply-${index}`, f.transaction, text, 12100 + index * 100),
  );
  const usageTransaction = f.add(
    "usage-transaction",
    f.run.spanID,
    "postgresql transaction",
    undefined,
    19100,
    {
      "span.kind": "internal",
      "db.system.name": "postgresql",
      "antnest.transaction.outcome": "committed",
    },
  );
  usageTransaction.duration = 800;
  const usage = [
    "BEGIN",
    ...lock,
    storedUsage,
    previousUsage,
    insert,
    update,
    "COMMIT",
  ].map((text, index) =>
    sql(`usage-${index}`, usageTransaction, text, 19110 + index * 50),
  );
  f.output.startTime = 14500;
  f.output.duration = 1000;
  f.set(f.output, "agent.id", expected.agentId);
  f.set(f.output, "session.id", expected.sessionId);
  const output = [sessionRead, outputRead, sessionRead, configurationRead].map(
    (text, index) =>
      sql(`output-${index}`, f.output, text, 14600 + index * 100),
  );
  return {
    ...f,
    admission,
    admissionQueries,
    intent,
    acceptance,
    context,
    checkpoint: savedCheckpoint,
    temporaryCleanupRead,
    catalogRevisionRead,
    readiness,
    readyQuery,
    reply,
    usageTransaction,
    usage,
    outputQueries: output,
    insert: reply[5],
    outputRead: output[1],
  };
}
