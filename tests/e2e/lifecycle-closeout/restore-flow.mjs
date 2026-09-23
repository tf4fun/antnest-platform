import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { join } from "node:path";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import { collectLifecycleEvidence } from "./foundation-evidence.mjs";
import {
  saveFoundationTrace,
  saveFoundationFailure,
} from "./foundation-trace.mjs";
import { flushTraceProducers } from "./network-support.mjs";
import { connectOwner } from "./acp.mjs";
import { lines } from "./docker.mjs";
import {
  keyNames,
  databases,
  assertRestoreRun,
  assertReplayAudits,
  writerServices,
  assertQuiesced,
  keyDigests,
  assertInjectedKeys,
} from "./restore-evidence.mjs";
import {
  backupStorage,
  restoreStorage,
  volumeTool,
} from "./restore-storage.mjs";

export function configureRestore(config) {
  for (const key of keyNames)
    config.env[key] = randomBytes(32).toString("base64");
}

async function loginOwner(config) {
  const owner = new GatewayClient(config.gateway);
  const response = await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  return { owner, principal: response.body.principal };
}

async function history(client, sessionId) {
  const start = client.updates.length;
  await client.request("load", {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });
  return client.updates
    .slice(start)
    .filter(
      (value) =>
        value.sessionId === sessionId &&
        [
          "user_message_chunk",
          "agent_message_chunk",
          "tool_call",
          "tool_call_update",
        ].includes(value.update.sessionUpdate),
    );
}

async function prompt(client, sessionId, text) {
  const result = await client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text }] },
    60000,
  );
  assert.equal(result.stopReason, "end_turn");
}

export async function runRestore(input) {
  const directory = await mkdtemp(
    join(temporaryStorageRoot(), "antnest-restore-"),
  );
  await chmod(directory, 0o700);
  let client;
  try {
    return await restoreScenario(input, directory, (next) => {
      client?.close();
      client = next;
    });
  } finally {
    client?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function restoreScenario(
  {
    config,
    docker,
    signal,
    json,
    agentBody,
    command,
    resources,
    ready,
    traceSecrets,
  },
  directory,
  setClient,
) {
  console.error(
    "Restore: creating a real Session, Tool effect and persistent filesystem fixtures",
  );
  const requests = [];
  const remember = (client, method, details) => {
    const actual = client.requests.filter((r) => r.method === method).at(-1);
    assert(actual, "actual restore SDK request missing");
    requests.push({
      ...actual,
      agentId: client.agentId,
      agentID: client.agentId,
      requestID: actual.requestId,
      connectionTraceID: client.connectionTraceID,
      transport: "websocket",
      kind: "request",
      ...details,
    });
  };
  const modelState = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.errors, []);
    return state.requests;
  };
  const expectedKeys = keyDigests(config.env);
  const created = await command("create", undefined, agentBody);
  const initial = await ready(created.agentID);
  const first = await loginOwner(config);
  traceSecrets.push(
    "lifecycle-owner-password",
    ...first.owner.cookies.values(),
    ...keyNames.map((k) => config.env[k]),
  );
  const auditPath = `/api/admin/execution-audits?agent_id=${created.agentID}`;
  const completedRun = async (sessionId, agent) => {
    const page = await json(`${auditPath}&session_id=${sessionId}`);
    assert.equal(page.next_cursor, null);
    assert.equal(page.items.length, 1);
    return assertRestoreRun(
      [await json(`/api/admin/execution-audits/${page.items[0].run_id}`)],
      agent,
      sessionId,
    );
  };
  let client = connectOwner(
    config.gateway,
    created.agentID,
    first.owner.cookie,
    signal,
  );
  setClient(client);
  await client.initialize();
  const sessionId = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  remember(client, "session/new", { sessionId });
  const untouchedSessionId = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  remember(client, "session/new", { sessionId: untouchedSessionId });
  await prompt(client, sessionId, "c5-before-backup");
  const beforeRun = await completedRun(sessionId, initial.agent);
  remember(client, "session/prompt", {
    sessionId,
    kind: "ordinary",
    phase: "c5-before-backup",
    runId: beforeRun.run_id,
  });
  const beforeAudits = await json(auditPath);
  assert.equal(beforeAudits.items.length, 1);
  const beforeModel = await modelState();
  assert.deepEqual(
    beforeModel.map(({ phase, stage }) => [phase, stage]),
    [
      ["c5-before-backup", "tool"],
      ["c5-before-backup", "reply"],
    ],
  );
  const beforeHistory = await history(client, sessionId);
  remember(client, "session/load", { sessionId });
  assertReplayAudits(beforeAudits, await json(auditPath));
  assert.deepEqual(await modelState(), beforeModel);
  assert(
    beforeHistory.some((event) => event.update.sessionUpdate === "tool_call"),
  );
  assert(JSON.stringify(beforeHistory).includes("c5-before-backup completed"));
  client.close();

  await docker([
    "exec",
    "--user",
    "1000:1000",
    initial.container.Id,
    "sh",
    "-c",
    "mkdir -p /workspace/.antnest/skills/restore-fixture; printf '%s\\n' '# Personal recovery skill' > /workspace/.antnest/skills/restore-fixture/SKILL.md; printf '\\000\\001\\377' > /workspace/.c5-binary; chmod 600 /workspace/.c5-binary; ln -s .c5-binary /workspace/.c5-link",
  ]);
  const skills = config.env.ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME;
  await volumeTool(config, docker, skills, directory, [
    "sh",
    "-c",
    "mkdir -p /data/restore-fixture; printf '%s\\n' '# System recovery skill' > /data/restore-fixture/SKILL.md; chmod 644 /data/restore-fixture/SKILL.md",
  ]);
  await command("disable", created.agentID, {});
  const offline = await json(`/api/admin/agents/${created.agentID}`);
  assert.equal(offline.lifecycle_state, "created");
  assert.equal(offline.activation_state, "disabled");
  assert.deepEqual(await resources(created.agentID), {
    containers: [],
    volumes: [initial.volume],
  });
  const models = await json("/api/admin/model-profiles");
  const templates = await json("/api/admin/templates");
  const policy = await json(
    `/api/admin/agents/${created.agentID}/network-policy`,
  );
  assert.equal(policy.attachment.state, "closed");

  const eventPath = `/api/admin/agents/${created.agentID}/events?limit=100`;
  const beforeEvents = await json(eventPath);
  assert(beforeEvents.events.length < 100);
  console.error(
    "Restore: stopping every writer, exporting seven databases and two persistent volumes",
  );
  await docker(
    config.compose([
      "stop",
      "-t",
      "25",
      ...writerServices.filter((s) => s !== "temporal"),
    ]),
    true,
  );
  await docker(config.compose(["stop", "-t", "25", "temporal"]), true);
  const ids = lines(
    await docker(config.compose(["ps", "-aq", ...writerServices])),
  );
  assertQuiesced(JSON.parse(await docker(["inspect", ...ids])), config.project);
  await docker(config.compose(["stop", "-t", "20", "stage3-model"]), true);
  const backup = await backupStorage(config, docker, directory, [
    initial.volume,
    skills,
  ]);
  assert.equal(Object.keys(backup.files).length, databases.length + 3);
  // Recovery must reload the saved keys rather than reuse the in-memory values.
  for (const key of keyNames) delete config.env[key];
  console.error(
    "Restore: replacing the original storage, restoring data and comparing frozen fingerprints",
  );
  const storage = await restoreStorage(config, docker, directory, {
    postgres: backup.postgres.name,
    volumes: [initial.volume, skills],
  });
  await docker(
    config.compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
    ]),
    true,
  );

  console.error(
    "Restore: checking authentication, saved policy/configuration, history and new Tool execution",
  );
  const restoredIDs = lines(
    await docker(
      config.compose([
        "ps",
        "-q",
        "identity-service",
        "agent-controller",
        "agent-acp-service",
      ]),
    ),
  );
  assertInjectedKeys(
    JSON.parse(await docker(["inspect", ...restoredIDs])),
    expectedKeys,
  );
  await json("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const restored = await json(`/api/admin/agents/${created.agentID}`);
  assert.equal(restored.lifecycle_state, "created");
  assert.equal(restored.activation_state, "disabled");
  assert.deepEqual(restored.configuration, offline.configuration);
  assert.deepEqual(await json("/api/admin/model-profiles"), models);
  assert.deepEqual(await json("/api/admin/templates"), templates);
  const restoredPolicy = await json(
    `/api/admin/agents/${created.agentID}/network-policy`,
  );
  assert.equal(restoredPolicy.action, policy.action);
  assert.equal(restoredPolicy.resource_version, policy.resource_version);
  assert.equal(restoredPolicy.attachment.state, "closed");
  assert.deepEqual(await json(eventPath), beforeEvents);
  assertReplayAudits(beforeAudits, await json(auditPath));
  assert.deepEqual(
    await json(`/api/admin/execution-audits/${beforeRun.run_id}`),
    beforeRun,
  );
  const second = await loginOwner(config);
  traceSecrets.push(...second.owner.cookies.values());
  assert.deepEqual(second.principal, first.principal);
  await command("enable", created.agentID, {});
  const enabled = await ready(created.agentID);
  assert.notEqual(enabled.container.Id, initial.container.Id);
  assert.deepEqual(await modelState(), []);
  client = connectOwner(
    config.gateway,
    created.agentID,
    second.owner.cookie,
    signal,
  );
  setClient(client);
  await client.initialize();
  assert.deepEqual(await history(client, sessionId), beforeHistory);
  remember(client, "session/load", { sessionId });
  assertReplayAudits(beforeAudits, await json(auditPath));
  assert.deepEqual(
    await json(`/api/admin/execution-audits/${beforeRun.run_id}`),
    beforeRun,
  );
  assert.deepEqual(
    await modelState(),
    [],
    "history replay executed a model request",
  );
  // This Session has never been loaded/resumed since creation. Prompt must open
  // its original encrypted MCP revision, not a replacement written by load.
  await prompt(client, untouchedSessionId, "c5-after-restore");
  const afterRun = await completedRun(untouchedSessionId, enabled.agent);
  assert.notEqual(afterRun.run_id, beforeRun.run_id);
  assert.notEqual(
    enabled.agent.executable_execution_revision,
    initial.agent.executable_execution_revision,
  );
  remember(client, "session/prompt", {
    sessionId: untouchedSessionId,
    kind: "ordinary",
    phase: "c5-after-restore",
    toolName: "read",
    runId: afterRun.run_id,
  });
  const afterAudits = await json(auditPath);
  assert.equal(afterAudits.next_cursor, null);
  assert.equal(afterAudits.items.length, 2);
  assert.deepEqual(
    await json(`/api/admin/execution-audits/${beforeRun.run_id}`),
    beforeRun,
  );
  assert.deepEqual(
    (await modelState()).map(({ phase, stage }) => [phase, stage]),
    [
      ["c5-after-restore", "tool"],
      ["c5-after-restore", "reply"],
    ],
  );
  client.close();
  assert.equal(
    await docker([
      "exec",
      "--user",
      "1000:1000",
      enabled.container.Id,
      "sh",
      "-c",
      "stat -c '%u:%g:%a' /workspace/.c5-binary; readlink /workspace/.c5-link; base64 -w 0 /workspace/.c5-binary",
    ]),
    "1000:1000:600\n.c5-binary\nAAH/",
  );
  const calls = [...beforeModel, ...(await modelState())];
  await command("delete", created.agentID, {});
  assert.deepEqual(await resources(created.agentID), {
    containers: [],
    volumes: [],
  });
  await flushTraceProducers(config, docker);
  const requestTraces = await collectLifecycleEvidence(
    requests,
    (expected) =>
      collectManagedTrace(
        config.jaeger,
        expected,
        traceSecrets,
        expected.kind === "ordinary"
          ? calls.filter((c) => c.phase === expected.phase)
          : [],
        (trace) => {
          expected.traceID = trace.traceID;
          saveFoundationTrace(config, trace);
        },
        (trace, expected, secrets, modelCalls) => {
          const evidence = inspectCommandTrace(
            trace,
            expected,
            secrets,
            modelCalls,
          );
          if (expected.runId) assert.equal(evidence.run_id, expected.runId);
          return strictSessionEvidence(evidence, trace);
        },
        signal,
      ),
    (expected, error) =>
      saveFoundationFailure(
        config,
        { traceID: expected.traceID ?? expected.connectionTraceID },
        error,
      ),
    signal,
  );
  return {
    profile: "offline-restore",
    request_traces: requestTraces,
    completed_runs: 2,
    model_requests: calls.length,
    event_history_preserved: true,
    execution_audits_preserved: true,
    deleted_before_teardown: true,
    project: config.project,
    ...storage,
    history_events: beforeHistory.length,
    history_replay_model_calls: 0,
    restored_tool_calls: 1,
    original_acp_ciphertext_read: true,
    file_metadata_preserved: true,
    agent_id: created.agentID,
  };
}
