import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectOwner } from "./acp.mjs";
import { composeArgs, lines } from "./docker.mjs";
import {
  keyNames,
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
  const directory = await mkdtemp(join(tmpdir(), "antnest-restore-"));
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
  { config, docker, signal, json, agentBody, command, resources, ready },
  directory,
  setClient,
) {
  console.error(
    "Restore: creating a real Session, Tool effect and persistent filesystem fixtures",
  );
  const expectedKeys = keyDigests(config.env);
  const created = await command("create", undefined, agentBody);
  const initial = await ready(created.agentID);
  const first = await loginOwner(config);
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
  const untouchedSessionId = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  await prompt(client, sessionId, "c5-before-backup");
  const beforeHistory = await history(client, sessionId);
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
  assert.equal(offline.lifecycle_state, "disabled");
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

  console.error(
    "Restore: stopping every writer, exporting five databases and two persistent volumes",
  );
  await docker(
    composeArgs(config.project, ["stop", "-t", "25", ...writerServices]),
    true,
  );
  const ids = lines(
    await docker(composeArgs(config.project, ["ps", "-aq", ...writerServices])),
  );
  assertQuiesced(JSON.parse(await docker(["inspect", ...ids])), config.project);
  await docker(
    composeArgs(config.project, ["stop", "-t", "20", "stage3-model", "jaeger"]),
    true,
  );
  const backup = await backupStorage(config, docker, directory, [
    initial.volume,
    skills,
  ]);
  assert.equal(Object.keys(backup.files).length, 8);
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
    composeArgs(config.project, [
      "-f",
      "scripts/lifecycle-closeout/restore.compose.yaml",
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
      composeArgs(config.project, [
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
  assert.equal(restored.lifecycle_state, "disabled");
  assert.deepEqual(restored.configuration, offline.configuration);
  assert.deepEqual(await json("/api/admin/model-profiles"), models);
  assert.deepEqual(await json("/api/admin/templates"), templates);
  const restoredPolicy = await json(
    `/api/admin/agents/${created.agentID}/network-policy`,
  );
  assert.equal(restoredPolicy.action, policy.action);
  assert.equal(restoredPolicy.resource_version, policy.resource_version);
  assert.equal(restoredPolicy.attachment.state, "closed");
  const second = await loginOwner(config);
  assert.deepEqual(second.principal, first.principal);
  await command("enable", created.agentID, {});
  const enabled = await ready(created.agentID);
  assert.notEqual(enabled.container.Id, initial.container.Id);
  const modelState = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.errors, []);
    return state.requests;
  };
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
  assert.deepEqual(
    await modelState(),
    [],
    "history replay executed a model request",
  );
  // This Session has never been loaded/resumed since creation. Prompt must open
  // its original encrypted MCP revision, not a replacement written by load.
  await prompt(client, untouchedSessionId, "c5-after-restore");
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
  return {
    profile: "offline-restore",
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
