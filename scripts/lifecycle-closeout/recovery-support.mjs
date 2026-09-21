import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { lines, scopeLabel, composeArgs } from "./docker.mjs";

export async function until(read, predicate, signal, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    await delay(500, undefined, { signal });
  }
  throw new Error("Interrupted-update checkpoint deadline exceeded");
}

export async function serviceContainer(docker, project, service) {
  const ids = lines(await docker(composeArgs(project, ["ps", "-aq", service])));
  assert.equal(ids.length, 1, `${service}: expected one owned service`);
  return JSON.parse(await docker(["inspect", ids[0]]))[0];
}

export async function runtimePhysical(docker, config, agentID) {
  const filter = [
    "--filter",
    `label=${scopeLabel}=${config.project}`,
    "--filter",
    `label=io.antnest.agent-id=${agentID}`,
  ];
  const ids = lines(await docker(["ps", "-aq", "--no-trunc", ...filter]));
  const volumes = lines(await docker(["volume", "ls", "-q", ...filter]));
  if (!ids.length) return { ids, volumes };
  assert.equal(ids.length, 1);
  const c = JSON.parse(await docker(["inspect", ids[0]]))[0];
  assert.equal(c.Image, config.image);
  assert.deepEqual(volumes, [`antnest-workspace-${agentID}`]);
  const mount = c.Mounts.find((m) => m.Destination === "/workspace");
  assert.equal(mount?.Name, volumes[0]);
  assert.equal(mount.RW, true);
  return {
    id: c.Id,
    agent_id: c.Config.Labels["io.antnest.agent-id"],
    generation: Number(c.Config.Labels["io.antnest.runtime-generation"]),
    digest: c.Config.Labels["io.antnest.runtime-spec-digest"],
    volume: volumes[0],
    started_at: c.State.StartedAt,
    restarts: c.RestartCount,
    running: c.State.Running,
    healthy: c.State.Health?.Status === "healthy",
  };
}

// Test evidence only: fixed SELECTs using each service's own role and database.
// Never fetch configuration snapshots, credentials or arbitrary table payloads.
export function journalReader(docker, postgres) {
  const query = async (service, sql) => {
    const role = `antnest_${service}`;
    const value = await docker([
      "exec",
      postgres,
      "psql",
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      role,
      "-d",
      role,
      "-c",
      `SELECT row_to_json(e) FROM (${sql}) e`,
    ]);
    return value ? JSON.parse(value) : null;
  };
  const safe = (id) => {
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
    return `'${id}'`;
  };
  return {
    binding: (agentID) =>
      query(
        "agent_controller",
        `SELECT runtime_revision, runtime_execution_id,
      executable_spec_revision_id FROM agent_controller.agents WHERE id=${safe(agentID)}`,
      ),
    runtimeCursor: () =>
      query(
        "agent_controller",
        "SELECT last_sequence, initialized FROM agent_controller.runtime_observation_cursor WHERE singleton=TRUE",
      ),
    lossBinding: (id) =>
      query(
        "agent_controller",
        `SELECT runtime_revision, runtime_execution_id,
      runtime_mcp_endpoint, executable_execution_revision_id, executable_spec_revision_id,
      last_successful_execution_revision_id FROM agent_controller.agents WHERE id=${safe(id)}`,
      ),
    lossObservation: (sequence) => {
      assert(Number.isSafeInteger(sequence) && sequence > 0);
      return query(
        "runtime_controller",
        `SELECT sequence, agent_id, runtime_revision, generation,
        platform_resource_id, kind, source FROM runtime_controller.observations WHERE sequence=${sequence}`,
      );
    },
    lossEvent: (id) =>
      query(
        "agent_controller",
        `SELECT event_id, global_sequence, agent_id, event_type,
      operation_request_id, admission_id, data FROM agent_controller.agent_events WHERE event_id=${safe(id)}`,
      ),
    ac: (id) =>
      query(
        "agent_controller",
        `SELECT request_id,agent_id,kind,state,phase,
      source_runtime_revision,target_spec_revision_id,child_request_id,runtime_result,
      updated_at
      FROM agent_controller.agent_lifecycle_operations WHERE request_id=${safe(id)}`,
      ),
    rc: (id) =>
      query(
        "runtime_controller",
        `SELECT request_id,request_digest,kind,agent_id,state,effect,
      source_revision,source_generation,source_spec_digest,runtime_revision,target_generation,target_spec_digest,attempt
      FROM runtime_controller.operations WHERE request_id=${safe(id)}`,
      ),
    publications: (agentID) =>
      query(
        "agent_controller",
        `SELECT count(*)::int AS count
      FROM agent_controller.execution_revisions WHERE agent_id=${safe(agentID)}`,
      ),
    claims: (agentID) =>
      query(
        "runtime_controller",
        `SELECT count(*)::int AS count
      FROM runtime_controller.generation_claims WHERE agent_id=${safe(agentID)}`,
      ),
    updated: (agentID, revision) =>
      query(
        "runtime_controller",
        `SELECT count(*)::int AS count
      FROM runtime_controller.observations WHERE agent_id=${safe(agentID)} AND runtime_revision=${safe(revision)} AND kind='updated'`,
      ),
  };
}
