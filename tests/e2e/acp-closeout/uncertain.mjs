import assert from "node:assert/strict";
import { until, assertMessageReplay } from "./support.mjs";
import {
  assertUnknownOutcome,
  assertReleaseEvents,
  assertUnknownReplay,
} from "./uncertain-evidence.mjs";
import { captureRuntime } from "../managed-mcp/rebuild-evidence.mjs";
import { verifyTraces } from "../managed-mcp/trace.mjs";

async function internalGet(service, path) {
  const response = await fetch(`http://${service}:8080${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${service} observation failed`);
  return response.json();
}

async function events(admin, agent) {
  const result = [];
  let after = 0;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      organization_id: admin.principal.organization_id,
      after_sequence: String(after),
      limit: "100",
    });
    const list = await internalGet(
      "agent-controller",
      `/internal/agents/${agent}/events?${query}`,
    );
    if (!list.events.length) return result;
    assert(list.next_sequence > after, "event cursor did not advance");
    const publicList = await admin.request(
      `/api/admin/agents/${agent}/events?${query}`,
    );
    for (const item of list.events) {
      const { data: _data, ...metadata } = item;
      assert.deepEqual(
        publicList.events.find((event) => event.event_id === item.event_id),
        metadata,
        "audit event missing from Console projection",
      );
    }
    result.push(...list.events);
    after = list.next_sequence;
  }
  assert.fail("event pagination did not finish");
}

async function replayUnknown(client, session, version, unknown) {
  const offset = client.updates.length;
  const replay = await client.replay(session, "_unresolved");
  assertMessageReplay(replay, unknown.messages, version);
  assertUnknownReplay(replay, unknown.attempts[0].tool_call_id);
  const states = client.updates
    .slice(offset)
    .filter((item) => item.update.sessionUpdate === "state_update");
  assert.equal(
    states.length,
    version === 2 ? 1 : 0,
    "unexpected replay state count",
  );
  return replay;
}

export async function uncertainEffect({
  version,
  agent,
  session,
  admin,
  owner,
  pool,
  open,
  close,
  history,
  currentRun,
  modelStatus,
  restartACP,
  observeRetirement,
  settled,
}) {
  const attempts = async (run) =>
    (
      await pool.query(
        "SELECT * FROM tool_attempts WHERE run_id=$1 ORDER BY id",
        [run],
      )
    ).rows;
  const snapshot = async (runID) => ({
    run: (await pool.query("SELECT * FROM runs WHERE id=$1", [runID])).rows[0],
    attempts: await attempts(runID),
    messages: await history(session),
  });
  const runtime = () =>
    internalGet("runtime-controller", `/internal/runtimes/${agent}`);
  const agentView = () => admin.request(`/api/admin/agents/${agent}`);
  const source = captureRuntime(await agentView(), await runtime());
  let client = await open(version, agent, owner);
  const other = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  const phase = `v${version}-tool-inflight`;
  const pending = client
    .request("prompt", {
      sessionId: session,
      prompt: [{ type: "text", text: phase }],
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const before = await until(
    async () => {
      const run = await currentRun(session);
      if (run?.state !== "running") return false;
      const value = await snapshot(run.id);
      return value.attempts.length === 1 &&
        value.attempts[0].state === "in_progress"
        ? value
        : false;
    },
    "in-flight Runtime attempt",
    15000,
  );
  assert.equal(before.attempts[0].source, "runtime");
  assert.equal(before.attempts[0].tool_name, "bash");
  assert.equal(
    before.run.execution_snapshot.runtime.revision,
    source.runtime_revision,
  );
  const calls = await modelStatus();
  const proof = await restartACP({
    kind: "tool-inflight",
    agent_id: agent,
    version,
  });
  assert.equal(proof.marker, `${phase}\n`);
  assert(proof.tool_pid > 0);
  const interrupted = await pending;
  if (version === 1) {
    assert(interrupted.error, "in-flight v1 prompt completed before SIGKILL");
    await until(() => client.closeCode, "v1 prompt transport closed");
  }
  close(client);
  await until(
    async () => (await snapshot(before.run.id)).run.admission_finished_at,
    "unknown terminal report",
  );
  const unknown = await snapshot(before.run.id);
  assertUnknownOutcome(before, unknown);
  assert(
    !JSON.stringify(unknown.messages).includes(`${phase} verified`),
    "invented final answer",
  );
  const expected = {
    agent,
    admission: before.run.admission_id,
    revision: source.runtime_revision,
  };
  const unresolvedEvent = assertReleaseEvents(
    await events(admin, agent),
    expected,
  );

  client = await open(version, agent, owner);
  const first = await replayUnknown(client, session, version, unknown);
  assert.deepEqual(
    await replayUnknown(client, session, version, unknown),
    first,
  );
  const offset = client.updates.length;
  await assert.rejects(
    () =>
      client.request("prompt", {
        sessionId: other.sessionId,
        prompt: [{ type: "text", text: "unresolved-denied" }],
      }),
    (error) =>
      error.code === -32021 &&
      error.data?.code === "agent_busy" &&
      error.data?.retryable === true,
  );
  assert.equal(
    client.updates.length,
    offset,
    "busy rejection emitted a conversation update",
  );
  assert.deepEqual(await snapshot(before.run.id), unknown);
  assert.deepEqual(
    await modelStatus(),
    calls,
    "replay or denied prompt executed model",
  );
  assertReleaseEvents(await events(admin, agent), expected);
  close(client);

  const rebuild = await admin.request(
    `/api/admin/agents/${agent}/rebuild`,
    {
      template_id: source.template_id,
      template_revision: source.template_revision,
    },
    202,
  );
  await admin.waitOperation(rebuild.request_id);
  await observeRetirement();
  const operation = await admin.request(
    `/api/admin/operations/${rebuild.request_id}`,
  );
  assert.equal(operation.agent_id, agent);
  assert.equal(operation.kind, "rebuild");
  assert.equal(operation.state, "completed");
  const view = await agentView();
  const replacement = captureRuntime(view, await runtime());
  assert(!view.active_operation_request_id);
  assert.equal(replacement.template_revision, source.template_revision);
  for (const field of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ])
    assert.notEqual(replacement[field], source[field], `${field} not replaced`);
  const releaseEvents = await events(admin, agent);
  assert.deepEqual(
    assertReleaseEvents(releaseEvents, {
      ...expected,
      request: rebuild.request_id,
    }),
    unresolvedEvent,
  );
  assert.deepEqual(
    await snapshot(before.run.id),
    unknown,
    "rebuild rewrote unknown history",
  );

  client = await open(version, agent, owner);
  await replayUnknown(client, session, version, unknown);
  assert.deepEqual(await modelStatus(), calls);
  const recoveredPhase = `v${version}-recovered-effect`;
  await client.prompt(session, recoveredPhase);
  const recovered = await settled(session);
  assert.equal(recovered.state, "completed");
  assert.notEqual(recovered.id, before.run.id);
  assert.notEqual(recovered.admission_id, before.run.admission_id);
  assert.equal(
    recovered.execution_snapshot.runtime.revision,
    replacement.runtime_revision,
  );
  const reads = await attempts(recovered.id);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].tool_name, "read");
  assert.equal(reads[0].state, "completed");
  assert.deepEqual((await snapshot(before.run.id)).run, unknown.run);
  assert.deepEqual(await attempts(before.run.id), unknown.attempts);
  const later = await history(session);
  for (const message of unknown.messages)
    assert.deepEqual(
      later.find((item) => item.id === message.id),
      message,
    );
  const finalEvents = await events(admin, agent);
  assert.deepEqual(
    assertReleaseEvents(finalEvents, {
      ...expected,
      request: rebuild.request_id,
    }),
    unresolvedEvent,
  );
  close(client);
  const traces = await verifyTraces(
    "http://jaeger:16686",
    (await modelStatus()).filter((item) => item.phase === recoveredPhase),
  );
  return {
    unknown_run: before.run.id,
    admission_id: before.run.admission_id,
    rebuild_request: rebuild.request_id,
    source_runtime: source.runtime_revision,
    replacement_runtime: replacement.runtime_revision,
    physical_effect_once: true,
    unresolved_history_preserved: true,
    blocked_until_rebuild: true,
    traces,
  };
}
