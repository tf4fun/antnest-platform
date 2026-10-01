import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  stage4WriterServices,
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
  stage4RecoveryPlan,
} from "./restore-storage.mjs";
import {
  assertFrozenSkill,
  publishSkill,
} from "../skill-registry/stage3-fixture.mjs";

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
    api,
    admin,
    agentBody,
    templateBody,
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
  let frozenSkill;
  if (config.skillRestore) {
    frozenSkill = await publishSkill(admin, 1);
    const revision = (
      await api(`/api/admin/templates/${agentBody.template_id}/revisions`, {
        body: {
          ...templateBody,
          skill_refs: [
            { skill_id: frozenSkill.skill_id, version: frozenSkill.version },
          ],
        },
        status: 201,
      })
    ).body;
    assertFrozenSkill(revision, frozenSkill);
    agentBody = { ...agentBody, template_revision: revision.revision };
  }
  const created = await command("create", undefined, agentBody);
  const initial = await ready(created.agentID);
  let peerCreated, peerInitial;
  if (config.skillRestore) {
    assert(initial.skillVolume);
    assert.match(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        initial.container.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]),
      /Stage 4 immutable preset version 1\./,
    );
    peerCreated = await command("create", undefined, {
      ...agentBody,
      name: "Second restored Skill Agent",
    });
    peerInitial = await ready(peerCreated.agentID);
    assert(
      peerInitial.skillVolume &&
        peerInitial.skillVolume !== initial.skillVolume,
    );
    assert.notEqual(peerInitial.volume, initial.volume);
    assert.match(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        peerInitial.container.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]),
      /Stage 4 immutable preset version 1\./,
    );
  }
  const first = await loginOwner(config);
  traceSecrets.push(
    "lifecycle-owner-password",
    ...first.owner.cookies.values(),
    ...keyNames.map((k) => config.env[k]),
  );
  const auditPath = `/api/admin/execution-audits?agent_id=${created.agentID}`;
  const completedRun = async (sessionId, agent, agentID = created.agentID) => {
    const page = await json(
      `/api/admin/execution-audits?agent_id=${agentID}&session_id=${sessionId}`,
    );
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
  if (!config.skillRestore)
    await volumeTool(config, docker, skills, directory, [
      "sh",
      "-c",
      "mkdir -p /data/restore-fixture; printf '%s\\n' '# System recovery skill' > /data/restore-fixture/SKILL.md; chmod 644 /data/restore-fixture/SKILL.md",
    ]);
  await command("disable", created.agentID, {});
  if (peerCreated) await command("disable", peerCreated.agentID, {});
  const offline = await json(`/api/admin/agents/${created.agentID}`);
  const peerOffline = peerCreated
    ? await json(`/api/admin/agents/${peerCreated.agentID}`)
    : undefined;
  assert.equal(offline.lifecycle_state, "created");
  assert.equal(offline.activation_state, "disabled");
  const offlineResources = await resources(created.agentID);
  assert.deepEqual(offlineResources.containers, []);
  assert.deepEqual(
    offlineResources.volumes.sort(),
    [
      initial.volume,
      ...(config.skillRestore ? [initial.skillVolume] : []),
    ].sort(),
  );
  if (peerCreated) {
    const peerResources = await resources(peerCreated.agentID);
    assert.deepEqual(peerResources.containers, []);
    assert.deepEqual(
      peerResources.volumes.sort(),
      [peerInitial.volume, peerInitial.skillVolume].sort(),
    );
    assert.equal(peerOffline.activation_state, "disabled");
  }
  const models = await json("/api/admin/model-profiles");
  const templates = await json("/api/admin/templates");
  const policy = await json(
    `/api/admin/agents/${created.agentID}/network-policy`,
  );
  assert.equal(policy.attachment.state, "closed");

  const eventPath = `/api/admin/agents/${created.agentID}/events?limit=100`;
  const beforeEvents = await json(eventPath);
  assert(beforeEvents.events.length < 100);
  const recoveryWriters = config.skillRestore
    ? stage4WriterServices
    : writerServices;
  console.error(
    "Restore: stopping every writer and exporting the complete recovery set",
  );
  await docker(
    config.compose([
      "stop",
      "-t",
      "25",
      ...recoveryWriters.filter((s) => s !== "temporal"),
    ]),
    true,
  );
  await docker(config.compose(["stop", "-t", "25", "temporal"]), true);
  const ids = lines(
    await docker(config.compose(["ps", "-aq", ...recoveryWriters])),
  );
  assertQuiesced(
    JSON.parse(await docker(["inspect", ...ids])),
    config.project,
    recoveryWriters,
  );
  await docker(config.compose(["stop", "-t", "20", "stage3-model"]), true);
  const plan = config.skillRestore
    ? await stage4RecoveryPlan(config, docker, [
        initial.volume,
        peerInitial.volume,
      ])
    : { databases, volumes: [initial.volume, skills] };
  const backup = await backupStorage(
    config,
    docker,
    directory,
    plan.volumes,
    plan.databases,
  );
  assert.equal(
    Object.keys(backup.files).length,
    plan.databases.length + plan.volumes.length + 1,
  );
  // Recovery must reload the saved keys rather than reuse the in-memory values.
  for (const key of keyNames) delete config.env[key];
  console.error(
    "Restore: replacing the original storage, restoring data and comparing frozen fingerprints",
  );
  const storage = await restoreStorage(config, docker, directory, {
    postgres: backup.postgres.name,
    ...plan,
  });
  if (config.skillRestore)
    assert.deepEqual(
      await stage4RecoveryPlan(config, docker, [
        initial.volume,
        peerInitial.volume,
      ]),
      plan,
    );
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
  if (config.skillRestore)
    await docker(config.compose(["stop", "-t", "20", "skill-registry"]), true);

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
  if (peerCreated) {
    const peerRestored = await json(`/api/admin/agents/${peerCreated.agentID}`);
    assert.equal(peerRestored.activation_state, "disabled");
    assert.deepEqual(peerRestored.configuration, peerOffline.configuration);
  }
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
  let peerEnabled;
  if (config.skillRestore) {
    assert.equal(
      enabled.skillVolume,
      initial.skillVolume,
      "offline Enable replaced the retained Skill collection",
    );
    assert.match(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        enabled.container.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]),
      /Stage 4 immutable preset version 1\./,
    );
    await command("enable", peerCreated.agentID, {});
    peerEnabled = await ready(peerCreated.agentID);
    assert.equal(
      peerEnabled.skillVolume,
      peerInitial.skillVolume,
      "second Agent lost its retained Skill collection",
    );
    assert.notEqual(peerEnabled.skillVolume, enabled.skillVolume);
    assert.match(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        peerEnabled.container.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]),
      /Stage 4 immutable preset version 1\./,
    );
  }
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
  if (peerCreated) {
    client.close();
    client = connectOwner(
      config.gateway,
      peerCreated.agentID,
      second.owner.cookie,
      signal,
    );
    setClient(client);
    await client.initialize();
    const peerSessionID = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    remember(client, "session/new", { sessionId: peerSessionID });
    await prompt(client, peerSessionID, "c5-after-restore-peer");
    const peerRun = await completedRun(
      peerSessionID,
      peerEnabled.agent,
      peerCreated.agentID,
    );
    assert.notEqual(peerRun.run_id, afterRun.run_id);
    remember(client, "session/prompt", {
      sessionId: peerSessionID,
      kind: "ordinary",
      phase: "c5-after-restore-peer",
      toolName: "read",
      runId: peerRun.run_id,
    });
    assert.deepEqual(
      (await modelState()).map(({ phase, stage }) => [phase, stage]),
      [
        ["c5-after-restore", "tool"],
        ["c5-after-restore", "reply"],
        ["c5-after-restore-peer", "tool"],
        ["c5-after-restore-peer", "reply"],
      ],
    );

    await command("disable", peerCreated.agentID, {});
    assert.deepEqual(
      (await resources(peerCreated.agentID)).volumes.sort(),
      [peerInitial.volume, peerInitial.skillVolume].sort(),
    );
    await docker(["volume", "rm", peerInitial.skillVolume]);
    const missingVolume = () =>
      docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `name=${peerInitial.skillVolume}`,
      ]);
    assert(!lines(await missingVolume()).includes(peerInitial.skillVolume));
    const enableKey = randomUUID();
    let blockedEnable;
    try {
      blockedEnable = await fetch(
        `${config.gateway}/api/admin/agents/${peerCreated.agentID}/enable`,
        {
          method: "POST",
          signal: AbortSignal.timeout(5000),
          headers: {
            "content-type": "application/json",
            Cookie: admin.cookie,
            Origin: config.gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": enableKey,
          },
          body: "{}",
        },
      );
    } catch (error) {
      assert.equal(
        error.name,
        "TimeoutError",
        "missing-volume Enable failed unexpectedly",
      );
    }
    if (blockedEnable) {
      assert.equal(blockedEnable.status, 503);
      assert.equal((await blockedEnable.json()).retryable, true);
    }
    let preparation;
    for (let attempt = 0; attempt < 60; attempt++) {
      preparation = (
        await admin.request(
          "/api/admin/agent-skill-preparations/by-idempotency-key",
          {
            headers: { "Idempotency-Key": enableKey },
          },
        )
      ).body;
      if (preparation.state === "retry_wait") break;
      assert(
        ["queued", "preparing"].includes(preparation.state),
        `unexpected missing-volume preparation state: ${preparation.state}`,
      );
      await delay(500);
    }
    assert.equal(preparation.state, "retry_wait");
    assert.equal(preparation.agent_id, peerCreated.agentID);
    assert.equal(preparation.kind, "enable");
    assert.equal(preparation.error_code, "skill_preparation_unavailable");
    assert.equal(
      (await json(`/api/admin/agents/${peerCreated.agentID}`)).activation_state,
      "disabled",
    );
    const blockedResources = await resources(peerCreated.agentID);
    assert.deepEqual(blockedResources.containers, []);
    assert.deepEqual(blockedResources.volumes, [peerInitial.volume]);
    assert(
      !lines(await missingVolume()).includes(peerInitial.skillVolume),
      "Docker silently recreated the missing Skill volume",
    );

    client.close();
    client = connectOwner(
      config.gateway,
      created.agentID,
      second.owner.cookie,
      signal,
    );
    setClient(client);
    await client.initialize();
    const unaffectedSessionID = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    remember(client, "session/new", { sessionId: unaffectedSessionID });
    await prompt(client, unaffectedSessionID, "c5-after-peer-volume-loss");
    const unaffectedRun = await completedRun(
      unaffectedSessionID,
      enabled.agent,
    );
    remember(client, "session/prompt", {
      sessionId: unaffectedSessionID,
      kind: "ordinary",
      phase: "c5-after-peer-volume-loss",
      toolName: "read",
      runId: unaffectedRun.run_id,
    });
  }
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
  if (peerCreated)
    await command(
      "delete",
      peerCreated.agentID,
      {},
      { networkAlreadyClosed: true },
    );
  let cleared = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    const remaining = await resources(created.agentID);
    if (remaining.containers.length === 0 && remaining.volumes.length === 0) {
      cleared = true;
      break;
    }
    await delay(100);
  }
  assert(cleared, "Delete did not close retained Skill and workspace volumes");
  if (peerCreated) {
    let peerCleared = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const remaining = await resources(peerCreated.agentID);
      if (remaining.containers.length === 0 && remaining.volumes.length === 0) {
        peerCleared = true;
        break;
      }
      await delay(100);
    }
    assert(
      peerCleared,
      "second Agent retained Skill or workspace volumes after Delete",
    );
  }
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
    profile: config.skillRestore ? "offline-skill-restore" : "offline-restore",
    request_traces: requestTraces,
    completed_runs: peerCreated ? 4 : 2,
    model_requests: calls.length,
    event_history_preserved: true,
    execution_audits_preserved: true,
    deleted_before_teardown: true,
    project: config.project,
    ...storage,
    history_events: beforeHistory.length,
    history_replay_model_calls: 0,
    restored_tool_calls: peerCreated ? 3 : 1,
    original_acp_ciphertext_read: true,
    ...(config.skillRestore
      ? {
          restored_preset_skill: frozenSkill.skill_id,
          registry_offline_enable: true,
          restored_agents: 2,
          independent_skill_volumes: true,
          offline_missing_skill_volume_blocked: true,
          unaffected_peer_run: true,
        }
      : {}),
    file_metadata_preserved: true,
    agent_id: created.agentID,
  };
}
