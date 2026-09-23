import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { assertEventPage } from "./evidence.mjs";

export function assertStartupFailure({
  operation,
  agent,
  physical,
  agentID,
  image,
}) {
  assert.equal(operation.agent_id, agentID);
  assert.equal(operation.kind, "create");
  assert.equal(operation.state, "completed");
  assert.equal(operation.phase, "completed");
  assert.equal(agent.agent_id, agentID);
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "enabled");
  assert(
    ["unhealthy", "exited"].includes(agent.runtime_state) ||
      (agent.runtime_state === "waiting" &&
        agent.runtime_reason === "runtime_restarting"),
  );
  assert(agent.runtime_reason, "observed startup diagnostic missing");
  assert(agent.runtime?.runtime_revision, "configured target missing");
  assert(
    !agent.executable_execution_revision && !agent.runtime?.mcp_endpoint,
    "failed Agent has an executable binding",
  );
  assert.equal(physical.containers.length, 1);
  assert.equal(physical.containers[0].Image, image);
  assert.notEqual(physical.containers[0].State.Health?.Status, "healthy");
  assert.deepEqual(physical.volumes, [`antnest-workspace-${agentID}`]);
}

export function assertMCPStartupLog(text, agentID, generation) {
  const records = text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  assert(
    records.some(
      (record) =>
        record.level === "ERROR" &&
        record["antnest.agent.id"] === agentID &&
        record["antnest.runtime.generation"] === generation &&
        record.component === "managed_mcp" &&
        record["error.type"] === "managed_mcp_start_failed" &&
        record.reason === "managed MCP missing-mcp: initialization failed",
    ),
    "intended managed MCP startup failure not found in the owned container log",
  );
}

export function assertFailureEvents(events, createRequestID, deleteRequestID) {
  for (const [id, expected] of [
    [createRequestID, ["agent_create_requested", "agent_created"]],
    [deleteRequestID, ["agent_delete_requested", "agent_deleted"]],
  ])
    assert.deepEqual(
      events
        .filter((e) => e.operation_request_id === id)
        .map((e) => e.event_type),
      expected,
    );
}

export async function exerciseStartupFailure({
  json,
  command,
  resources,
  templateBody,
  agentBody,
  image,
  docker,
}) {
  const template = await json("/api/admin/templates", {
    status: 201,
    body: {
      ...templateBody,
      name: "Required MCP startup failure",
      runtime: {
        ...templateBody.runtime,
        mcp_servers: [
          { id: "missing-mcp", command: "/nonexistent-antnest-lifecycle-mcp" },
        ],
      },
    },
  });
  assert.equal(template.runtime.image_ref, image);
  const created = await command(
    "create",
    undefined,
    {
      ...agentBody,
      name: "Failed lifecycle Agent",
      template_id: template.template_id,
      template_revision: template.revision,
    },
    { runtimeStartupFailure: true },
  );
  const agentID = created.agentID;
  const path = `/api/admin/agents/${agentID}`;
  const deadline = Date.now() + 120000;
  let agent;
  do {
    agent = await json(path);
    if (
      ["unhealthy", "exited"].includes(agent.runtime_state) ||
      agent.runtime_reason === "runtime_restarting"
    )
      break;
    await delay(250);
  } while (Date.now() < deadline);
  const physical = await resources(agentID);
  assertStartupFailure({
    operation: created.terminal,
    agent,
    physical,
    agentID,
    image,
  });
  const container = physical.containers[0];
  assertMCPStartupLog(
    await docker(["logs", "--tail", "100", container.Id]),
    agentID,
    container.Config.Labels["io.antnest.runtime-generation"],
  );
  const deleted = await command("delete", agentID, {});
  assert.deepEqual(
    await resources(agentID),
    { containers: [], volumes: [] },
    "business Delete left failed Runtime resources",
  );
  assert.equal((await json(path)).lifecycle_state, "deleted");
  assert(
    !(await json("/api/admin/agents")).items.some(
      (a) => a.agent_id === agentID,
    ),
  );
  assert(
    (await json("/api/admin/agents?view=deleted")).items.some(
      (a) => a.agent_id === agentID,
    ),
  );
  assert.deepEqual(
    await json(`/api/admin/operations/${created.requestID}`),
    created.terminal,
  );
  const events = await json(`${path}/events?limit=100`);
  assertEventPage(events, 0, new Set(), agentID);
  assertFailureEvents(events.events, created.requestID, deleted.requestID);
  return { agentID, events };
}
