import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { serviceContainer } from "../lifecycle-closeout/recovery-support.mjs";
import { skillClientArgs } from "../skill-learning/client-container.mjs";

const prompt = [{ type: "text", text: "foreground during review" }];
const outcome = {
  state: "completed",
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: "none",
  stop_reason: "end_turn",
  error_class: null,
};

export function inspectOwnerBusiness({
  agentId,
  sessionId,
  clientResult,
  runs,
  audit,
  events,
}) {
  assert.match(agentId, /^agent_[a-f0-9]{32}$/u);
  assert.match(sessionId, /^session_[a-f0-9]{32}$/u);
  assert.equal(clientResult.status, "passed");
  assert.equal(clientResult.agent_id, agentId);
  assert.equal(clientResult.session_id, sessionId);
  assert(Array.isArray(runs));
  assert.equal(runs.length, 1, "expected one actual foreground Run");
  const run = runs[0];
  assert.match(run.id, /^run_[a-f0-9]{32}$/u);
  assert.equal(typeof run.request_id, "string");
  assert(run.request_id.length > 0);
  assert.equal(run.agent_id, agentId);
  assert.equal(run.session_id, sessionId);
  assert.equal(typeof run.principal_id, "string");
  assert(run.principal_id.length > 0);
  assert.equal(audit.run_id, run.id);
  for (const field of ["session_id", "agent_id", "principal_id"])
    assert.equal(audit[field], run[field]);
  for (const [field, expected] of Object.entries(outcome)) {
    assert.equal(run[field], expected, `durable Run ${field}`);
    assert.equal(audit[field], expected, `audit Run ${field}`);
  }
  assert.deepEqual(audit.input, prompt);
  assert.equal(events.stream, "execution");
  assert.equal(
    events.next_cursor,
    null,
    "complete durable event page required",
  );
  assert(Array.isArray(events.items));
  const ids = new Set();
  let sequence = 0;
  for (const event of events.items) {
    assert.equal(typeof event.id, "string");
    assert(event.id.length > 0 && !ids.has(event.id));
    ids.add(event.id);
    assert(Number.isSafeInteger(event.sequence) && event.sequence > sequence);
    sequence = event.sequence;
    assert.equal(typeof event.visible, "boolean");
    assert.equal(typeof event.created_at, "string");
    assert(Number.isFinite(Date.parse(event.created_at)));
    assert.equal(event.kind, event.payload.kind);
    if (["user_message", "agent_message"].includes(event.kind))
      assert.equal(event.payload.messageId, event.id);
  }
  const users = events.items.filter((event) => event.kind === "user_message");
  const replies = events.items.filter(
    (event) => event.kind === "agent_message" && event.visible,
  );
  assert.equal(users.length, 1);
  assert.equal(users[0].visible, true);
  assert.deepEqual(users[0].payload.content, prompt);
  assert.equal(replies.length, 1);
  assert(replies[0].sequence > users[0].sequence);
  assert(Array.isArray(replies[0].payload.content));
  assert(
    replies[0].payload.content.every(
      (block) => block.type === "text" && typeof block.text === "string",
    ),
  );
  assert.equal(
    replies[0].payload.content.map((block) => block.text).join(""),
    "Foreground request completed.",
  );
  return {
    status: "passed",
    run_id: run.id,
    session_id: sessionId,
    agent_id: agentId,
    executor_state: run.executor_state,
  };
}

export async function runOwnerBusiness({
  config,
  docker,
  root,
  image,
  output,
  fixture,
  signal,
  cleanupDocker = dockerClient(config.env, undefined, 180_000),
}) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.match(fixture.agentID, /^agent_[a-f0-9]{32}$/u);
  const name = `${config.project}-owner-business`;
  const errors = [];
  let clientResult;
  try {
    signal?.throwIfAborted();
    const text = await docker(
      [
        "run",
        "--name",
        name,
        ...skillClientArgs(config, { privateACP: true }),
        "--read-only",
        "--cap-drop",
        "ALL",
        "-e",
        `ANTNEST_E2E_AGENT_ID=${fixture.agentID}`,
        "-v",
        `${root}/tests:/app/tests:ro`,
        image,
        "node",
        "/app/tests/e2e/security/owner-business-client.mjs",
      ],
      true,
    );
    clientResult = JSON.parse(text.trim().split("\n").at(-1));
    assert.equal(clientResult.status, "passed");
    assert.equal(clientResult.agent_id, fixture.agentID);
    assert.match(clientResult.session_id, /^session_[a-f0-9]{32}$/u);
    const [client] = JSON.parse(await docker(["inspect", name]));
    assert.equal(
      client.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(client.Config.Image, image);
    assert.equal(client.State.Running, false);
    assert.equal(
      client.State.ExitCode,
      0,
      "original client did not join its work and connections",
    );
    await writeFile(
      resolve(output, "owner-client.json"),
      JSON.stringify(clientResult),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    errors.push(error);
    try {
      const logs = await docker(["logs", name]);
      await writeFile(resolve(output, "owner-client-failure.log"), logs, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      /* Failure diagnostics cannot replace the original failure. */
    }
  } finally {
    try {
      // This independent budget survives interruption of the original runner.
      const args = [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${config.project}`,
        "--filter",
        `name=^/${name}$`,
      ];
      const ids = (await cleanupDocker(args))
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      assert(ids.length <= 1);
      if (ids.length) await cleanupDocker(["rm", "-f", ids[0]]);
      assert.equal(
        (await cleanupDocker(args)).trim(),
        "",
        "owned business client remains after cleanup",
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Owner business client or container cleanup failed",
    );
  signal?.throwIfAborted();
  const agentId = fixture.agentID,
    sessionId = clientResult.session_id;
  const postgres = await serviceContainer(docker, config.project, "postgres");
  assert.equal(
    postgres.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(
    postgres.Config.Labels["com.docker.compose.service"],
    "postgres",
  );
  assert.equal(postgres.State.Running, true);
  assert.match(postgres.Id, /^[0-9a-f]{64}$/u);
  // Both interpolated resource IDs passed their closed canonical validators.
  const sql = `SELECT COALESCE(json_agg(e), '[]'::json) FROM (
    SELECT r.id,r.request_id,r.session_id,s.agent_id,s.principal_id,
      r.state,r.terminal_class,r.executor_state,r.tool_effect_state,r.stop_reason,r.error_class
    FROM runs r JOIN acp_sessions s ON s.id=r.session_id
    WHERE s.agent_id='${agentId}' AND s.id='${sessionId}'
  ) e`;
  const runs = JSON.parse(
    await docker([
      "exec",
      "-e",
      "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c timezone=UTC",
      postgres.Id,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_agent_acp",
      "-d",
      "antnest_agent_acp",
      "-c",
      sql,
    ]),
  );
  signal?.throwIfAborted();
  assert(Array.isArray(runs) && runs.length === 1);
  assert.match(runs[0].id, /^run_[a-f0-9]{32}$/u);
  const page = await fixture.json(
    `/api/admin/execution-audits?agent_id=${agentId}&limit=100`,
  );
  signal?.throwIfAborted();
  assert.equal(page.next_cursor, null);
  assert.equal(
    page.items.filter((run) => run.session_id === sessionId).length,
    1,
  );
  assert(
    page.items.some(
      (run) => run.run_id === runs[0].id && run.session_id === sessionId,
    ),
  );
  const path = `/api/admin/execution-audits/${runs[0].id}`;
  const audit = await fixture.json(path);
  signal?.throwIfAborted();
  const events = await fixture.json(
    `${path}/events?stream=execution&limit=100`,
  );
  signal?.throwIfAborted();
  const evidence = { agentId, sessionId, clientResult, runs, audit, events };
  await writeFile(
    resolve(output, "owner-run-evidence.private.json"),
    JSON.stringify(evidence),
    { flag: "wx", mode: 0o600 },
  );
  signal?.throwIfAborted();
  return inspectOwnerBusiness(evidence);
}
