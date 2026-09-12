import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { Pool } from "pg";
import { BrowserSession, connect, until } from "./support.mjs";
import { publishCheckpoint } from "./checkpoint.mjs";
import { assertOrdinaryTool } from "../acp-commands/evidence.mjs";
import { inspectTrace } from "../managed-mcp/trace.mjs";
import { collectTrace, verifyTraces } from "../observability/collect.mjs";
import {
  assertReceipts,
  assertTerminal,
  assertConfiguredReplay,
  inspectRpcTrace,
} from "./rpc-evidence.mjs";
import { snapshotHash, storedAdmission } from "./rpc-snapshot.mjs";

const admin = new BrowserSession(),
  owner = new BrowserSession();
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  options: "-c default_transaction_read_only=on",
  query_timeout: 10000,
});
const clients = new Set(),
  metrics = [];
let agent,
  step = 0,
  stage = "setup";
const open = async (version) => {
  const client = await connect(version, agent, owner);
  clients.add(client);
  return client;
};
const close = (client) => {
  client.close();
  clients.delete(client);
};
async function proxy(path, body) {
  const response = await fetch(`http://rpc-loss-proxy:8080/__test/${path}`, {
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, "fault proxy rejected operation");
  return response.json();
}
async function model() {
  const response = await fetch("http://acp-closeout-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value.errors, [], "model rejected actual request");
  return value.requests;
}
async function snapshot(session, id) {
  const runs = (
    await pool.query(
      "SELECT * FROM runs WHERE session_id=$1 ORDER BY created_at",
      [session],
    )
  ).rows;
  const run = id ? runs.find((run) => run.id === id) : runs.at(-1);
  const attempts = run
    ? (
        await pool.query(
          "SELECT * FROM tool_attempts WHERE run_id=$1 ORDER BY id",
          [run.id],
        )
      ).rows
    : [];
  const messages = (
    await pool.query(
      "SELECT id, sequence, kind, visible, payload FROM session_messages WHERE session_id=$1 ORDER BY sequence",
      [session],
    )
  ).rows;
  return { runs, run, attempts, messages };
}
const settled = (session) =>
  until(
    async () => {
      const value = await snapshot(session);
      return value.run?.admission_finished_at ? value : false;
    },
    "RPC recovery did not settle",
    120000,
  );
async function restarted() {
  await until(
    async () => {
      try {
        await access(`/checkpoints/done-${step}`);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    "host did not observe exit and readiness",
    120000,
  );
}
async function replay(client, session, version, expected, configuration) {
  const offset = client.updates.length;
  const loaded = await client.request(version === 1 ? "load" : "resume", {
    sessionId: session,
    cwd: "/workspace",
    mcpServers: [],
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  const received = client.updates.slice(offset);
  assert(
    received.every((frame) => frame.sessionId === session),
    "foreign replay Session",
  );
  const frames = received.filter(
    ({ update }) => update.sessionUpdate !== "state_update",
  );
  const states = client.updates
    .slice(offset)
    .filter(({ update }) => update.sessionUpdate === "state_update");
  assert.equal(
    states.length,
    version === 1 ? 0 : 1,
    "unexpected completion count",
  );
  if (version === 2)
    assert.deepEqual(
      states.map(({ update }) => [update.state, update.stopReason]),
      [["idle", "end_turn"]],
    );
  assertConfiguredReplay(frames, expected, version, configuration, loaded);
  return frames;
}
async function exercise(version, kind) {
  stage = `v${version}-${kind}`;
  let client = await open(version);
  const { sessionId: session } = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const configuration = await client.request("setConfigOption", {
    sessionId: session,
    configId: "mode",
    value: "auto",
    ...(version === 2 ? { type: "id" } : {}),
  });
  const initial = await snapshot(session);
  assert.equal(initial.runs.length, 0, "new Session already has Runs");
  assert.deepEqual(
    initial.messages.map((message) => message.kind),
    ["configuration"],
  );
  await proxy("arm", {
    method: `${kind}-run`,
    agent_id: agent,
    session_id: session,
  });
  const phase = `v${version}-rpc-${kind}`;
  const offset = client.updates.length;
  const pending = client
    .request("prompt", {
      sessionId: session,
      prompt: [{ type: "text", text: phase }],
    })
    .then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  const held = await until(
    async () => (await proxy("status")).held,
    "no committed response held",
  );
  assert.equal(held.method, `${kind}-run`);
  assert.equal(held.agent_id, agent);
  assert.equal(held.session_id, session);
  assert.equal(held.status, 200);
  const before = await snapshot(session);
  const beforeCalls = await model();
  assert.equal(before.runs.length, 1);
  assert.equal(before.run.admission_finished_at, null);
  if (kind === "acquire") {
    assert.equal(before.run.state, "admitting");
    assert.equal(before.run.request_id, held.request_id);
    assert.equal(before.run.admission_id, null);
    assert.equal(before.run.execution_snapshot, null);
    assert.deepEqual(before.run.pending_prompt, [
      { type: "text", text: phase },
    ]);
    assert.equal(before.attempts.length, 0);
    assert.deepEqual(
      before.messages,
      initial.messages,
      "Acquire accepted input before receiving admission",
    );
    assert.equal(beforeCalls.filter((item) => item.phase === phase).length, 0);
  } else {
    assert.equal(before.run.state, "completed");
    assert.equal(before.run.admission_id, held.admission_id);
    assert.equal(before.run.terminal_class, "completed");
    assert.equal(before.run.tool_effect_state, "settled");
    assert.equal(before.attempts.length, 1);
    assert.equal(before.attempts[0].state, "completed");
    assert.equal(beforeCalls.filter((item) => item.phase === phase).length, 2);
  }
  assert(
    !client.updates
      .slice(offset)
      .some(
        ({ update }) =>
          update.sessionUpdate === "state_update" && update.state === "idle",
      ),
    "wire completed before admission acknowledgement",
  );
  await publishCheckpoint(`/checkpoints/request-${++step}`, {
    request_id: held.request_id,
  });
  await proxy("drop", { request_id: held.request_id });
  await restarted();
  close(client);
  const originalPrompt = await pending;
  if (kind === "acquire")
    assert(originalPrompt.error, "unaccepted prompt acknowledged");
  const after = await settled(session);
  assert.equal(after.runs.length, 1, "recovery created a duplicate Run");
  assert.equal(after.run.id, before.run.id);
  assert.equal(after.run.request_id, before.run.request_id);
  assert.equal(after.run.admission_id, held.admission_id);
  assert.equal(after.run.state, "completed");
  assert.equal(after.run.terminal_class, "completed");
  assert.equal(after.run.stop_reason, "end_turn");
  assert.equal(after.run.tool_effect_state, "settled");
  assert.equal(after.run.error_class, null);
  assert.equal(
    after.run.execution_snapshot.executionSpec.configuration.authorization.mode,
    "auto",
  );
  assert.equal(after.attempts.length, 1);
  if (kind === "finish") {
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(
      after.run.execution_snapshot,
      before.run.execution_snapshot,
    );
    assert.deepEqual(
      await model(),
      beforeCalls,
      "finish recovery reexecuted model",
    );
  }
  const calls = await model();
  assert.equal(calls.filter((item) => item.phase === phase).length, 2);
  const receipts = (await proxy("status")).records;
  assertReceipts(kind, held, receipts);
  assertTerminal(receipts, after.run);
  const acquire = receipts.find((item) => item.method === "acquire-run");
  assert.equal(
    after.run.execution_snapshot.executionRevision,
    acquire.execution_revision,
  );
  assert.equal(
    snapshotHash(storedAdmission(after.run.execution_snapshot)),
    acquire.snapshot_hash,
    "stored admission differs from the committed upstream snapshot",
  );
  client = await open(version);
  const first = await replay(
    client,
    session,
    version,
    after.messages,
    configuration,
  );
  assertOrdinaryTool(first, version, phase);
  assert.deepEqual(
    await replay(client, session, version, after.messages, configuration),
    first,
  );
  assert.deepEqual(await model(), calls, "replay executed model");
  const replayed = await snapshot(session);
  assert.deepEqual(replayed, after, "replay changed durable Run/Tool/history");
  const readPhase = `v${version}-rpc-read-${kind}`;
  await client.prompt(session, readPhase);
  const read = await settled(session);
  assert.notEqual(read.run.admission_id, after.run.admission_id);
  assert.deepEqual(
    read.run.execution_snapshot.runtime,
    after.run.execution_snapshot.runtime,
    "Runtime changed to hide repeated effects",
  );
  const original = await snapshot(session, before.run.id);
  assert.deepEqual(original.run, after.run);
  assert.deepEqual(original.attempts, after.attempts);
  for (const message of after.messages)
    assert.deepEqual(
      original.messages.find((item) => item.id === message.id),
      message,
    );
  close(client);
  const pair = receipts.filter((item) => item.method === held.method);
  const rpcTraces = [];
  for (const [index, receipt] of pair.entries())
    rpcTraces.push(
      await collectTrace(
        "http://jaeger:16686",
        receipt.traceparent.split("-")[1],
        (trace) =>
          inspectRpcTrace(
            trace,
            receipt,
            index === 1,
            [admin.cookie, owner.cookie, "acp-closeout-model"],
            held,
          ),
      ),
    );
  const readTraces = await verifyTraces(
    "http://jaeger:16686",
    (await model()).filter((item) => item.phase === readPhase),
    [admin.cookie, owner.cookie, "acp-closeout-model"],
    inspectTrace,
  );
  metrics.push({
    version,
    window: kind,
    admission_id: held.admission_id,
    same_intent: true,
    single_effect: true,
    replay_without_execution: true,
    rpc_traces: rpcTraces,
    read_traces: readTraces,
  });
}
try {
  await admin.login("stage3-admin@example.com", "stage3-admin-password");
  await admin.request("/api/admin/directory/users", {
    email: "rpc-owner@example.com",
    display_name: "RPC owner",
    password: "rpc-owner-password",
    role: "member",
  });
  await owner.login("rpc-owner@example.com", "rpc-owner-password");
  const profile = await admin.request(
    "/api/admin/model-profiles",
    {
      display_name: "RPC loss fixture",
      api_key: "acp-closeout-model",
      model: {
        base_url: "http://acp-closeout-model:8080/v1",
        model: "rpc-loss",
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
      name: "RPC loss fixture",
      model_profile_revision_id: profile.revision_id,
      system_prompt: "Use Runtime tools.",
      max_model_requests: 4,
      runtime: { image_ref: process.env.TEST_RUNTIME_IMAGE },
    },
    201,
  );
  const created = await admin.request(
    "/api/admin/agents",
    {
      owner_user_id: owner.principal.user_id,
      name: "RPC loss fixture",
      template_id: template.template_id,
      template_revision: 1,
    },
    202,
  );
  agent = created.agent.agent_id;
  await admin.waitOperation(created.operation.request_id);
  for (const version of [1, 2])
    for (const kind of ["acquire", "finish"]) await exercise(version, kind);
  const calls = await model();
  assert.equal(calls.length, 16);
  const deleted = await admin.request(
    `/api/admin/agents/${agent}/delete`,
    {},
    202,
  );
  await admin.waitOperation(deleted.request_id);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      restarts: step,
      model_requests: calls.length,
      windows: metrics,
    }) + "\n",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "rpc_loss_failed",
      stage,
      type: error.name,
      reason: error.message.split("\n")[0],
      location: error.stack?.match(
        /(?:rpc-[\w-]+|replay|evidence)\.mjs:\d+:\d+/,
      )?.[0],
    }),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await pool.end();
}
