import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  BrowserSession,
  connect,
  rejectedUpgrade,
  until,
  assertMessageReplay,
} from "./support.mjs";
import { verifyTraces } from "../managed-mcp/trace.mjs";

const admin = new BrowserSession();
const owner = new BrowserSession();
const foreign = new BrowserSession();
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  options: "-c default_transaction_read_only=on",
  query_timeout: 10000,
});
const clients = new Set();
const agents = [];
const metrics = [];
let restarts = 0;
const modelStatus = async () => {
  const response = await fetch("http://acp-closeout-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status.errors, []);
  return status.requests;
};
const open = async (version, agent, browser) => {
  const client = await connect(version, agent, browser);
  clients.add(client);
  return client;
};
const close = (client) => {
  client.close();
  clients.delete(client);
};
async function history(session) {
  return (
    await pool.query(
      "SELECT id, sequence, kind, visible, payload FROM session_messages WHERE session_id=$1 ORDER BY sequence",
      [session],
    )
  ).rows;
}
async function snapshot() {
  const result = {};
  for (const table of [
    "acp_sessions",
    "runs",
    "tool_attempts",
    "session_messages",
    "client_mcp_revisions",
  ])
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY id`)
    ).rows;
  return result;
}
async function currentRun(session) {
  return (
    await pool.query(
      "SELECT * FROM runs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
      [session],
    )
  ).rows[0];
}
async function settled(session) {
  return until(async () => {
    const run = await currentRun(session);
    return run?.admission_finished_at ? run : false;
  }, "admission finished");
}
async function restartACP() {
  const id = ++restarts;
  await writeFile(`/checkpoints/request-${id}`, "restart ACP only\n");
  await until(
    async () => {
      try {
        await access(`/checkpoints/done-${id}`);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    "host process restart",
    90000,
  );
}
const denied = (operation, code) =>
  assert.rejects(operation, (error) => {
    assert.equal(
      error.data?.code,
      code,
      `unexpected protocol error: ${error.message}`,
    );
    return true;
  });

async function isolation(version, agent, session, ownerClient) {
  await rejectedUpgrade(version, agent, foreign);
  const beforeCalls = await modelStatus();
  for (const [target, browser] of [
    [agents[1], owner],
    [agents[2], foreign],
  ]) {
    const client = await open(version, target, browser);
    const created = await client.request("new", {
      cwd: "/workspace",
      mcpServers: [],
    });
    const listed = await client.request("list", {});
    assert(
      listed.sessions.some((item) => item.sessionId === created.sessionId),
    );
    assert(!listed.sessions.some((item) => item.sessionId === session));
    const before = await snapshot();
    for (const method of [
      version === 1 ? "load" : "resume",
      "fork",
      "close",
      "delete",
      "prompt",
    ]) {
      await denied(
        () =>
          client.request(method, {
            sessionId: session,
            cwd: "/workspace",
            mcpServers: [],
            ...(method === "prompt"
              ? { prompt: [{ type: "text", text: "unauthorized" }] }
              : {}),
            ...(version === 2 && method === "resume"
              ? { replayFrom: { type: "start" } }
              : {}),
          }),
        "session_access_denied",
      );
      assert.deepEqual(await snapshot(), before);
    }
    assert.deepEqual(client.updates, [], "foreign history leaked");
    close(client);
  }
  const revoked = await ownerClient.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const before = await snapshot();
  await admin.request(
    `/api/admin/directory/users/${owner.principal.user_id}/active`,
    { active: false },
  );
  await denied(() => ownerClient.request("list", {}), "access_denied");
  assert.deepEqual(await snapshot(), before);
  await denied(
    () =>
      ownerClient.request("prompt", {
        sessionId: revoked.sessionId,
        prompt: [{ type: "text", text: "deactivated-owner-prompt" }],
      }),
    "access_denied",
  );
  const after = await snapshot();
  for (const table of [
    "acp_sessions",
    "tool_attempts",
    "session_messages",
    "client_mcp_revisions",
  ])
    assert.deepEqual(after[table], before[table]);
  for (const run of before.runs)
    assert.deepEqual(
      after.runs.find((item) => item.id === run.id),
      run,
    );
  const rejected = after.runs.filter(
    (item) => !before.runs.some((run) => run.id === item.id),
  );
  assert.equal(
    rejected.length,
    1,
    "rejected admission must retain one intent only",
  );
  assert.equal(rejected[0].session_id, revoked.sessionId);
  assert.equal(rejected[0].state, "failed");
  assert.equal(rejected[0].error_class, "access_denied");
  for (const field of ["pending_prompt", "execution_snapshot", "admission_id"])
    assert.equal(rejected[0][field], null);
  assert.deepEqual(await modelStatus(), beforeCalls);
  await admin.request(
    `/api/admin/directory/users/${owner.principal.user_id}/active`,
    { active: true },
  );
  await owner.login("acp-owner@example.com", "acp-owner-password");
}

async function interrupted(version, agent, session, phase, effect) {
  let client = await open(version, agent, owner);
  const prompt = client
    .request("prompt", {
      sessionId: session,
      prompt: [{ type: "text", text: phase }],
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await until(
    async () =>
      (await modelStatus()).some(
        (item) => item.phase === phase && item.stage === "held",
      ),
    phase,
  );
  const run = await currentRun(session);
  assert.equal(run.state, "running");
  const attempts = (
    await pool.query(
      "SELECT * FROM tool_attempts WHERE run_id=$1 ORDER BY id",
      [run.id],
    )
  ).rows;
  assert.equal(attempts.length, effect === "settled" ? 1 : 0);
  if (effect === "settled") assert.equal(attempts[0].state, "completed");
  const messages = await history(session);
  const calls = await modelStatus();
  await restartACP();
  await prompt; // v1 is disconnected; v2 already acknowledged admission, not completion.
  close(client);
  const recovered = await currentRun(session);
  assert.equal(recovered.id, run.id);
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.terminal_class, "failed");
  assert.equal(recovered.executor_state, "quiescent");
  assert.equal(recovered.tool_effect_state, effect);
  assert.equal(recovered.error_class, "service_restarted_during_run");
  assert(recovered.admission_finished_at);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT * FROM tool_attempts WHERE run_id=$1 ORDER BY id",
        [run.id],
      )
    ).rows,
    attempts,
  );
  const preserved = await history(session);
  for (const message of messages)
    assert.deepEqual(
      preserved.find((item) => item.id === message.id),
      message,
    );
  client = await open(version, agent, owner);
  const replay = await client.replay(session, "_failed");
  assertMessageReplay(replay, preserved, version);
  assert(
    !JSON.stringify(replay).includes(`${phase} verified`),
    "invented interrupted answer",
  );
  assert.deepEqual(
    await modelStatus(),
    calls,
    "recovery or replay invoked model",
  );
  await client.prompt(
    session,
    `v${version}-after-restart-${effect === "none" ? 2 : 3}`,
  );
  await settled(session);
  close(client);
}

async function exercise(version) {
  const agent = agents[0];
  let client = await open(version, agent, owner);
  const { sessionId: session } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const phase = `v${version}-baseline`;
  await client.prompt(session, phase);
  await settled(session);
  await isolation(version, agent, session, client);
  close(client);
  client = await open(version, agent, owner);
  const first = await client.replay(session, "end_turn");
  assertMessageReplay(first, await history(session), version);
  const encoded = JSON.stringify(first);
  assert(encoded.includes(`${phase} verified`));
  assert(encoded.includes(`${phase}-tool`));
  assert(encoded.indexOf(phase) < encoded.indexOf(`${phase} verified`));
  assert.deepEqual(await client.replay(session, "end_turn"), first);
  const before = await snapshot();
  const calls = await modelStatus();
  close(client);
  const traces = await verifyTraces(
    "http://jaeger:16686",
    calls.filter((item) => item.phase === phase),
  );
  await restartACP();
  assert.deepEqual(
    await snapshot(),
    before,
    "restart mutated completed records",
  );
  client = await open(version, agent, owner);
  assert.deepEqual(await client.replay(session, "end_turn"), first);
  const loaded = await snapshot();
  for (const table of ["runs", "tool_attempts", "session_messages"])
    assert.deepEqual(loaded[table], before[table]);
  assert.equal(
    loaded.client_mcp_revisions.length,
    before.client_mcp_revisions.length + 1,
  );
  for (const revision of before.client_mcp_revisions)
    assert.deepEqual(
      loaded.client_mcp_revisions.find((item) => item.id === revision.id),
      revision,
    );
  assert.deepEqual(await modelStatus(), calls);
  await client.prompt(session, `v${version}-after-restart-1`);
  await settled(session);
  close(client);
  await interrupted(
    version,
    agent,
    session,
    `v${version}-model-blocked`,
    "none",
  );
  await interrupted(
    version,
    agent,
    session,
    `v${version}-tool-blocked`,
    "settled",
  );
  client = await open(version, agent, owner);
  await client.prompt(session, `v${version}-read-effects`);
  await settled(session);
  const run = await currentRun(session);
  const attempts = (
    await pool.query(
      "SELECT result_summary FROM tool_attempts WHERE run_id=$1",
      [run.id],
    )
  ).rows;
  assert.equal(attempts.length, 1, "effect read was not dispatched");
  const result = attempts[0].result_summary;
  for (const marker of [`v${version}-baseline`, `v${version}-tool-blocked`])
    assert.equal(
      JSON.stringify(result).split(marker).length - 1,
      1,
      `replayed effect: ${marker}`,
    );
  close(client);
  metrics.push({
    version,
    identity_isolation: true,
    owner_deactivation: true,
    restarts: 3,
    replay_without_execution: true,
    no_repeated_append: true,
    traces,
  });
}

try {
  await admin.login("stage3-admin@example.com", "stage3-admin-password");
  await admin.request("/api/admin/directory/users", {
    email: "acp-owner@example.com",
    display_name: "ACP owner",
    password: "acp-owner-password",
    role: "member",
  });
  await owner.login("acp-owner@example.com", "acp-owner-password");
  const userB = await admin.request("/api/admin/directory/users", {
    email: "acp-other@example.com",
    display_name: "ACP other owner",
    password: "acp-other-password",
    role: "member",
  });
  await foreign.login("acp-other@example.com", "acp-other-password");
  const model = await admin.request(
    "/api/admin/model-profiles",
    {
      display_name: "ACP closeout model",
      api_key: "acp-closeout-model",
      model: {
        base_url: "http://acp-closeout-model:8080/v1",
        model: "acp-closeout",
        context_window: 64000,
        max_output_tokens: 4096,
        supports_images: false,
      },
    },
    201,
  );
  const template = await admin.request(
    "/api/admin/templates",
    {
      name: "ACP closeout",
      model_profile_revision_id: model.revision_id,
      system_prompt: "Use the Runtime tools.",
      max_model_requests: 8,
      runtime: { image_ref: "antnest/antnest-runtime:local" },
    },
    201,
  );
  for (const ownerID of [
    owner.principal.user_id,
    owner.principal.user_id,
    userB.user.id,
  ]) {
    const created = await admin.request(
      "/api/admin/agents",
      {
        owner_user_id: ownerID,
        name: `ACP closeout ${agents.length + 1}`,
        template_id: template.template_id,
        template_revision: 1,
      },
      202,
    );
    agents.push(created.agent.agent_id);
    await admin.waitOperation(created.operation.request_id);
  }
  for (const version of [1, 2]) await exercise(version);
  const calls = await modelStatus();
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      versions: metrics,
      model_requests: calls.length,
      restarts,
    }) + "\n",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "closeout_failed",
      restarts,
      agents,
      runs: (
        await pool.query(
          "SELECT id, session_id, state, error_class, tool_effect_state FROM runs ORDER BY created_at",
        )
      ).rows,
      model: await (
        await fetch("http://acp-closeout-model:8080/status", {
          signal: AbortSignal.timeout(5000),
        })
      ).json(),
    }),
  );
  throw error;
} finally {
  for (const client of clients) client.close();
  await pool.end();
  // The parent stops lifecycle creators and removes only this disposable project's resources.
}
