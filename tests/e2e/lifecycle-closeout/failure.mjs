import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { assertEventPage } from "./evidence.mjs";

export async function waitForDeletedRuntimeResources(
  read,
  { timeout = 60000, interval = 250, signal } = {},
) {
  const deadline = AbortSignal.timeout(timeout);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let physical;
  try {
    while (true) {
      bounded.throwIfAborted();
      physical = await read();
      bounded.throwIfAborted();
      assert(
        Array.isArray(physical.containers) && Array.isArray(physical.volumes),
      );
      if (!physical.containers.length && !physical.volumes.length) {
        assert.deepEqual(physical, { containers: [], volumes: [] });
        return physical;
      }
      await delay(interval, undefined, { signal: bounded });
    }
  } catch (error) {
    if (deadline.aborted && physical)
      throw new Error(
        `Runtime resources remain: ${physical.containers.length} containers, ${physical.volumes.length} volumes`,
        { cause: error },
      );
    throw error;
  }
}

export function assertRuntimeStorage(physical, agentID) {
  assert.equal(physical.containers.length, 1);
  const mounts = physical.containers[0].Mounts;
  const storage = Object.fromEntries(
    [
      ["workspace", "/workspace", true],
      ["skills", "/skills", false],
      ["receiver", "/run/antnest-auth", false],
    ].map(([kind, path, writable]) => {
      const matching = mounts.filter((mount) => mount.Destination === path);
      assert.equal(matching.length, 1, `${kind} mount missing or ambiguous`);
      const mount = matching[0];
      assert.equal(mount.Type, "volume", `${kind} must use a named volume`);
      assert.equal(mount.RW, writable, `${kind} mount permissions`);
      assert(mount.Name, `${kind} volume identity missing`);
      return [kind, mount.Name];
    }),
  );
  assert.equal(storage.workspace, `antnest-workspace-${agentID}`);
  assert.equal(new Set(Object.values(storage)).size, 3);
  assert.deepEqual(
    [...physical.volumes].sort(),
    Object.values(storage).sort(),
    "unmounted or unowned Runtime storage",
  );
  return storage;
}

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
  const container = physical.containers[0]?.State;
  assert(
    ["unhealthy", "exited"].includes(agent.runtime_state) ||
      (agent.runtime_state === "waiting" &&
        agent.runtime_reason === "runtime_restarting"),
    `startup failure not observed: runtime_state=${agent.runtime_state} runtime_reason=${agent.runtime_reason} container=${container?.Status}/${container?.Health?.Status}`,
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
  assertRuntimeStorage(physical, agentID);
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
  resolvedImage = image,
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
    image: resolvedImage,
  });
  const container = physical.containers[0];
  assertMCPStartupLog(
    await docker(["logs", "--tail", "100", container.Id]),
    agentID,
    container.Config.Labels["io.antnest.runtime-generation"],
  );
  const deleted = await command("delete", agentID, {});
  await waitForDeletedRuntimeResources(() => resources(agentID));
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
