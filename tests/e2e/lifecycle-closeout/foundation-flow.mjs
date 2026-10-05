import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { lines, scopeLabel } from "./docker.mjs";
import { assertEventPage } from "./evidence.mjs";
import {
  collectFoundationLifecycle,
  saveFoundationFailure,
} from "./foundation-trace.mjs";
import {
  collectLifecycleEvidence,
  foundationLifecycleExpectation,
} from "./foundation-evidence.mjs";
import { setupFoundation } from "./foundation-setup.mjs";
import {
  assertRuntimeStorage,
  exerciseStartupFailure,
  waitForDeletedRuntimeResources,
} from "./failure.mjs";
import { withHeldRun } from "./foundation-drain.mjs";
import {
  waitForAgentReady,
  assertAgentDisabled,
} from "../../support/verification/agent-state.mjs";

async function firstEvent(client, agentID, after = 0) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  let reader;
  try {
    const response = await fetch(
      `${client.base}/api/admin/agents/${agentID}/events/watch?after_sequence=0`,
      {
        headers: { Cookie: client.cookie, "Last-Event-ID": String(after) },
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const next = await reader.read();
      assert(!next.done, "Watch ended before an event");
      text += decoder.decode(next.value, { stream: true }).replaceAll("\r", "");
      let end;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        assert.equal(
          Number(frame.match(/^id:\s*(\d+)$/m)?.[1]),
          event.global_sequence,
        );
        assert(
          event.global_sequence > after,
          "Watch ignored Last-Event-ID precedence",
        );
        return event;
      }
    }
  } finally {
    await reader?.cancel();
    abort.abort();
    clearTimeout(timer);
  }
}

export async function runFoundationFlow(config, docker, signal, scenario) {
  const client = new GatewayClient(config.gateway);
  const api = async (path, options) => {
    signal.throwIfAborted();
    return client.request(path, options);
  };
  const json = async (path, options) => (await api(path, options)).body;
  const admitted = [];
  const login = await json("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const principal = encodeURIComponent(
    JSON.stringify([login.principal.organization_id, login.principal.user_id]),
  );
  const traceSecrets = [
    "stage3-admin-password",
    "stage3-model-secret",
    ...client.cookies.values(),
  ];
  for (const path of ["model-profiles", "templates", "agents"]) {
    assert.deepEqual(
      (await json(`/api/admin/${path}`)).items,
      [],
      `empty ${path}`,
    );
  }
  const owner = await json("/api/admin/directory/users", {
    body: {
      email: "lifecycle-owner@example.com",
      display_name: "Lifecycle owner",
      password: "lifecycle-owner-password",
      role: "member",
    },
  });
  assert(owner.user.active && owner.membership.active);
  const { template, templateBody } = await setupFoundation(
    client,
    config.image,
  );
  assert.equal(template.runtime.image_ref, config.image);
  const agentBody = {
    owner_user_id: owner.user.id,
    name: "Lifecycle Agent",
    template_id: template.template_id,
    template_revision: template.revision,
  };
  async function waitOperation(requestID, outcome = "completed") {
    const expected =
      outcome === "runtime_start_failed" ? "failed" : "completed";
    for (let i = 0; i < 180; i++) {
      const op = await json(`/api/admin/operations/${requestID}`);
      if (op.state === expected) return op;
      assert.equal(
        op.state,
        "running",
        `${op.kind} unexpected state ${op.state} at ${op.phase}: ${op.error_code ?? "unknown"}`,
      );
      await delay(500);
    }
    throw new Error(`Lifecycle operation ${requestID} did not complete`);
  }
  async function command(kind, agentID, body, expectation = {}, during) {
    const path =
      kind === "create"
        ? "/api/admin/agents"
        : `/api/admin/agents/${agentID}/${kind}`;
    const options = {
      body,
      status: 202,
      headers: { "Idempotency-Key": randomUUID() },
    };
    const response = await api(path, options);
    const op = response.body.operation ?? response.body;
    const id = response.body.agent?.agent_id ?? agentID;
    assert(op.request_id && /^[a-f0-9]{32}$/.test(response.traceID));
    if (during) await during({ requestID: op.request_id, path, options });
    const terminal = await waitOperation(op.request_id, expectation.outcome);
    // Provisioning completion and observed Runtime readiness are distinct. The
    // initial ready event must settle before taking the exact replay baseline.
    if (
      ["create", "enable", "rebuild"].includes(kind) &&
      !expectation.runtimeStartupFailure
    )
      await ready(id);
    if (kind === "delete")
      await waitForDeletedRuntimeResources(() => resources(id), { signal });
    const beforeReplay = await physicalIdentity(id);
    const historyPath = `/api/admin/agents/${id}/events?limit=100`;
    const beforeEvents = await json(historyPath);
    assert(
      beforeEvents.events.length < 100,
      "replay baseline may be truncated",
    );
    const replay = await json(path, options);
    assert.equal((replay.operation ?? replay).request_id, op.request_id);
    if (kind === "create") assert.equal(replay.agent.agent_id, id);
    assert.deepEqual(
      await physicalIdentity(id),
      beforeReplay,
      `${kind} replay changed physical resources`,
    );
    assert.deepEqual(
      await waitOperation(op.request_id, expectation.outcome),
      terminal,
    );
    assert.deepEqual(
      await json(historyPath),
      beforeEvents,
      `${kind} replay changed event history`,
    );
    const result = {
      ...foundationLifecycleExpectation(kind, expectation),
      kind,
      agentID: id,
      requestID: op.request_id,
      traceID: response.traceID,
      path,
      options,
      terminal,
    };
    admitted.push(result);
    console.error(
      `Lifecycle ${kind}: terminal and exact-request replay verified`,
    );
    return result;
  }
  async function resources(agentID) {
    const filter = [
      "--filter",
      `label=${scopeLabel}=${config.project}`,
      "--filter",
      `label=io.antnest.agent-id=${agentID}`,
    ];
    const ids = lines(await docker(["ps", "-aq", "--no-trunc", ...filter]));
    const containers = ids.length
      ? JSON.parse(await docker(["inspect", ...ids]))
      : [];
    const volumes = lines(await docker(["volume", "ls", "-q", ...filter]));
    return { containers, volumes };
  }
  async function ready(agentID) {
    const agent = await waitForAgentReady(
      () => json(`/api/admin/agents/${agentID}`),
      signal,
    );
    const physical = await resources(agentID);
    assert.equal(physical.containers.length, 1);
    const container = physical.containers[0];
    assert.equal(container.State.Health.Status, "healthy");
    assert.equal(container.Image, config.resolvedImage);
    const storage = assertRuntimeStorage(physical, agentID);
    return {
      agent,
      container,
      volume: storage.workspace,
      skillVolume: storage.skills,
    };
  }
  async function physicalIdentity(agentID) {
    const state = await resources(agentID);
    return {
      containers: state.containers.map((c) => c.Id).sort(),
      volumes: state.volumes.sort(),
    };
  }
  if (scenario) {
    const result = await scenario({
      config,
      docker,
      signal,
      api,
      json,
      principal,
      agentBody,
      templateBody,
      admin: client,
      command,
      resources,
      ready,
      traceSecrets,
    });
    const traces = await collectLifecycleEvidence(
      admitted,
      (operation) =>
        collectFoundationLifecycle(config, operation, traceSecrets, signal),
      (operation, error) => saveFoundationFailure(config, operation, error),
      signal,
    );
    return { ...result, operations: admitted.length, traces };
  }
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID;
  const initial = await ready(agentID);
  const sentinel = randomUUID();
  await docker([
    "exec",
    "--user",
    "1000:1000",
    initial.container.Id,
    "sh",
    "-c",
    "printf '%s' \"$1\" > /workspace/.c3-sentinel",
    "sh",
    sentinel,
  ]);
  const verifyBytes = async (container) =>
    assert.equal(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        container,
        "cat",
        "/workspace/.c3-sentinel",
      ]),
      sentinel,
    );
  const disconnected = await firstEvent(client, agentID);
  // A second aggregate forces gaps in this Agent's global sequence.
  const noise = await command("create", undefined, {
    ...agentBody,
    name: "Cursor interleaving Agent",
  });
  await command("delete", noise.agentID, {});

  const revision = await json(
    `/api/admin/templates/${template.template_id}/revisions`,
    {
      status: 201,
      body: { ...templateBody, system_prompt: "Revised immutable fixture" },
    },
  );
  assert.equal(revision.revision, template.revision + 1);
  const unchanged = await ready(agentID);
  assert.equal(unchanged.container.Id, initial.container.Id);
  assert.deepEqual(unchanged.agent.configuration, initial.agent.configuration);
  const drain = await withHeldRun({
    config,
    docker,
    json,
    resources,
    command,
    agentID,
    initial,
    template: revision,
    signal,
    ready,
  });
  const rebuilt = await ready(agentID);
  assert.notEqual(rebuilt.container.Id, initial.container.Id);
  assert.notEqual(
    rebuilt.agent.runtime.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(
    rebuilt.agent.configuration.template.revision,
    revision.revision,
  );
  await verifyBytes(rebuilt.container.Id);

  async function policy(action) {
    const path = `/api/admin/agents/${agentID}/network-policy`;
    const before = await json(path);
    const options = {
      method: "PUT",
      body: { action, expected_resource_version: before.resource_version },
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Antnest-Expected-Principal": principal,
      },
    };
    const saved = await json(path, options);
    assert.equal(saved.action, action);
    assert.equal(saved.resource_version, before.resource_version + 1);
    assert.deepEqual(await json(path, options), saved);
    const conflict = await json(path, {
      ...options,
      status: 409,
      body: { ...options.body, action: before.action },
      headers: { ...options.headers, "Idempotency-Key": randomUUID() },
    });
    assert.equal(conflict.code, "resource_version_conflict");
    return json(path);
  }
  const originalPolicy = await json(
    `/api/admin/agents/${agentID}/network-policy`,
  );
  const other =
    originalPolicy.action === "allow_all" ? "deny_all" : "allow_all";
  assert.equal((await policy(other)).attachment.state, "open");
  assert.equal((await ready(agentID)).container.Id, rebuilt.container.Id);
  await command("disable", agentID, {});
  const disabled = await resources(agentID);
  assertAgentDisabled(await json(`/api/admin/agents/${agentID}`));
  assert.deepEqual(disabled.containers, []);
  assert.deepEqual(
    disabled.volumes.sort(),
    [initial.volume, initial.skillVolume].sort(),
  );
  assert.equal(
    (await policy(originalPolicy.action)).attachment.state,
    "closed",
  );
  assert.deepEqual(await resources(agentID), disabled);
  await command("enable", agentID, {});
  const enabled = await ready(agentID);
  assert.notEqual(enabled.container.Id, rebuilt.container.Id);
  await verifyBytes(enabled.container.Id);
  await command("delete", agentID, {});
  assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
  assert.equal(
    (await json(`/api/admin/agents/${agentID}`)).lifecycle_state,
    "deleted",
  );
  assert.deepEqual((await json("/api/admin/agents")).items, []);
  assert(
    (await json("/api/admin/agents?view=deleted")).items.some(
      (a) => a.agent_id === agentID,
    ),
  );

  async function replay(after = 0) {
    const all = [];
    const seen = new Set();
    let cursor = after;
    for (let i = 0; i < 100; i++) {
      const page = await json(
        `/api/admin/agents/${agentID}/events?after_sequence=${cursor}&limit=2`,
      );
      cursor = assertEventPage(page, cursor, seen, agentID);
      all.push(...page.events);
      if (!page.events.length) return all;
    }
    throw new Error("Event pagination did not terminate");
  }
  const events = await replay();
  const remaining = events.filter(
    (e) => e.global_sequence > disconnected.global_sequence,
  );
  assert.deepEqual(await replay(disconnected.global_sequence), remaining);
  assert.deepEqual(
    await firstEvent(client, agentID, disconnected.global_sequence),
    remaining[0],
  );
  assert(
    events.some((e) => e.global_sequence !== e.aggregate_sequence),
    "test did not distinguish global and aggregate cursors",
  );
  for (const operation of admitted.filter((o) => o.agentID === agentID)) {
    assert(
      events.some((e) => e.operation_request_id === operation.requestID),
      `${operation.kind} event missing`,
    );
  }
  const failed = await exerciseStartupFailure({
    json,
    command,
    resources,
    templateBody,
    agentBody,
    image: config.image,
    resolvedImage: config.resolvedImage,
    docker,
  });
  await docker(
    config.compose(["restart", "-t", "10", "agent-controller"]),
    true,
  );
  await docker(
    config.compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "--no-build",
    ]),
    true,
  );
  assert.deepEqual(
    await replay(),
    events,
    "idle restart changed durable events",
  );
  for (const op of admitted) {
    const repeated = await json(op.path, op.options);
    assert.equal((repeated.operation ?? repeated).request_id, op.requestID);
    assert.deepEqual(
      await waitOperation(op.requestID, op.outcome),
      op.terminal,
    );
    assert.deepEqual(
      await resources(op.agentID),
      { containers: [], volumes: [] },
      "terminal replay recreated Runtime resources",
    );
  }
  assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
  assert.deepEqual(
    await replay(),
    events,
    "replay repeated a lifecycle effect",
  );
  assert.deepEqual(
    await json(`/api/admin/agents/${failed.agentID}/events?limit=100`),
    failed.events,
    "restart/replay altered failed Agent events",
  );
  const traces = await collectLifecycleEvidence(
    admitted,
    (op) => collectFoundationLifecycle(config, op, traceSecrets, signal),
    (op, error) => saveFoundationFailure(config, op, error),
    signal,
  );
  return {
    profile: "lifecycle-foundation-and-startup-failure",
    operations: admitted.length,
    lifecycle_kinds: traces.map((t) => t.kind),
    events: events.length,
    network_cas_changes: 2,
    workspace_preserved_and_removed: true,
    idle_restart_replay: true,
    failed_runtime_deleted_before_teardown: true,
    failed_agent_events: failed.events.events.length,
    active_run_rebuild: drain.evidence,
    traces,
  };
}
