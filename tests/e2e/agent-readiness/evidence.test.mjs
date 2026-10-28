import assert from "node:assert/strict";
import test from "node:test";
import { inspectBatch, inspectRound, readinessRounds } from "./evidence.mjs";

// Synthetic wire/inspect DTOs exercise the admission boundary only. They do not
// stand in for the real Docker run, its proxy delay, or its persisted Run facts.
function roundFixture(index = 1, overrides = {}) {
  const suffix = index.toString(16).padStart(32, "0");
  const agentId = overrides.agentId ?? `agent_${suffix}`;
  const operationId = overrides.operationId ?? `create_${suffix}`;
  const phase = overrides.phase ?? `readiness-${index}`;
  const sessionId = overrides.sessionId ?? `session_${suffix}`;
  const runId = overrides.runId ?? `run_${suffix}`;
  const organizationId = "org_readiness";
  const principalId = "user_owner";
  const execution = `execution_${suffix}`;
  const spec = `spec_${suffix}`;
  const runtime = `rtv_${suffix}`;
  const process = `exec-process-${index}`;
  const revision = index * 10 + 8;
  const wall = Date.UTC(2026, 9, 23) + index * 10000;
  const iso = (offset = 0) => new Date(wall + offset).toISOString();
  const data = {
    organization_id: organizationId,
    agent_spec_revision_id: spec,
    execution_revision_id: execution,
    runtime_revision: runtime,
    ready_after_revision: revision,
  };
  const bound = {
    event_id: `event_bound_${suffix}`,
    global_sequence: index * 10 + 2,
    aggregate_sequence: 2,
    schema_version: 2,
    agent_id: agentId,
    event_type: "runtime_bound",
    operation_request_id: operationId,
    occurred_at: iso(),
    data: structuredClone(data),
  };
  const ready = {
    ...structuredClone(bound),
    event_id: `event_ready_${suffix}`,
    global_sequence: index * 10 + 3,
    aggregate_sequence: 3,
    event_type: "agent_ready",
    occurred_at: iso(3000),
    data: { ...structuredClone(data), applied_revision: revision },
  };
  const publication = {
    id: `publication-${index}`,
    path: "/rpc/agent-acp/apply-execution-snapshot",
    organizationId,
    revision,
    appliedRevision: revision,
    status: 200,
    requestSha256: "a".repeat(64),
    receivedAt: index * 10000,
    delayStartedAt: index * 10000 + 1,
    forwardedAt: index * 10000 + 2001,
    upstreamCompletedAt: index * 10000 + 2002,
    completedAt: index * 10000 + 2003,
    cancelled: false,
    bindings: [
      {
        agent_id: agentId,
        agent_spec_revision: spec,
        execution_revision: execution,
        runtime_revision: runtime,
        accepting_runs: true,
      },
    ],
  };
  const delaying = {
    ...structuredClone(publication),
    appliedRevision: null,
    status: null,
    forwardedAt: null,
    upstreamCompletedAt: null,
    completedAt: null,
  };
  const currentAgent = {
    organization_id: organizationId,
    agent_id: agentId,
    owner_user_id: principalId,
    name: `Readiness Agent ${index}`,
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    runtime_observed_at: iso(),
    access_revision: `access_${suffix}`,
    agent_spec_revision: spec,
    executable_execution_revision: execution,
    last_successful_execution_revision: execution,
    runtime: { runtime_revision: runtime, runtime_execution_id: process },
    readiness: "ready",
    aggregate_sequence: 3,
    created_at: iso(-1000),
    updated_at: iso(3000),
  };
  const initialResult = {
    protocolVersion: 1,
    agentInfo: { name: "Synthetic readiness fixture", version: "1" },
    agentCapabilities: { loadSession: true },
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  const metadata = {
    boundary: "private-acp",
    agentId,
    version: 1,
    protocolVersion: 1,
    transport: "websocket",
    kind: "request",
    outcome: "succeeded",
  };
  const initialization = {
    ...metadata,
    requestId: "1",
    method: "initialize",
    inputSessionID: null,
    label: phase + ":initialize",
    initializationResult: structuredClone(initialResult),
  };
  const newParams = { cwd: "/workspace", mcpServers: [] };
  const newResult = {
    sessionId,
    configOptions: [],
    modes: {
      currentModeId: "auto",
      availableModes: [{ id: "auto", name: "Auto" }],
    },
  };
  const promptParams = { sessionId, prompt: [{ type: "text", text: phase }] };
  const promptResult = { stopReason: "end_turn" };
  const evidence = [
    {
      ...metadata,
      requestId: "2",
      method: "session/new",
      sessionId,
      inputSessionID: null,
      label: phase + ":new",
      requestReceipt: {
        requestId: "2",
        params: structuredClone(newParams),
        result: structuredClone(newResult),
      },
    },
    {
      ...metadata,
      requestId: "3",
      method: "session/prompt",
      sessionId,
      inputSessionID: sessionId,
      label: phase + ":prompt",
      requestReceipt: {
        requestId: "3",
        params: structuredClone(promptParams),
        result: structuredClone(promptResult),
      },
    },
  ];
  const summary = {
    run_id: runId,
    session_id: sessionId,
    agent_id: agentId,
    principal_id: principalId,
    state: "completed",
    created_at: iso(3100),
    updated_at: iso(3200),
  };
  const workspace = `antnest-workspace-${agentId}`;
  const skills = `antnest-skills-${agentId}`;
  const auth = `antnest-auth-${agentId}`;
  return {
    index,
    phase,
    agentId,
    operationId,
    organizationId,
    principalId,
    actions: [
      { name: "ready_observed", at: 10 },
      { name: "initialize_started", at: 11 },
      { name: "new_started", at: 12 },
      { name: "prompt_started", at: 13 },
    ],
    events: [bound, ready],
    publication,
    delayed: {
      before: structuredClone(delaying),
      after: structuredClone(delaying),
      agent: {
        ...structuredClone(currentAgent),
        readiness: "preparing",
        aggregate_sequence: 2,
        updated_at: iso(),
      },
      events: [structuredClone(bound)],
    },
    currentAgent,
    connection: {
      version: 1,
      agent_id: agentId,
      transport: "websocket",
      closed: true,
      initialization,
      evidence,
      requests: [
        { requestId: "1", method: "initialize" },
        { requestId: "2", method: "session/new" },
        { requestId: "3", method: "session/prompt", sessionId },
      ],
      raw_frames: [
        { jsonrpc: "2.0", id: 1, result: structuredClone(initialResult) },
        { jsonrpc: "2.0", id: 2, result: structuredClone(newResult) },
        { jsonrpc: "2.0", id: 3, result: structuredClone(promptResult) },
      ],
    },
    runList: { items: [structuredClone(summary)], next_cursor: null },
    run: {
      ...structuredClone(summary),
      input: structuredClone(promptParams.prompt),
      execution_snapshot: {
        executionRevision: execution,
        modelProfileId: "model_readiness",
        executionSpec: {
          model: {
            model: "stage3-model",
            contextWindow: 64000,
            maxOutputTokens: 4096,
            supportsImages: false,
          },
        },
      },
      terminal_class: "completed",
      executor_state: "quiescent",
      tool_effect_state: "none",
      stop_reason: "end_turn",
      error_class: null,
      usage_measurements: [],
    },
    model: { requests: [{ phase, stage: "reply" }], errors: [] },
    deleted: {
      operation: {
        request_id: `delete_${suffix}`,
        agent_id: agentId,
        kind: "delete",
        state: "completed",
        phase: "completed",
        created_at: iso(4000),
        updated_at: iso(5000),
      },
      agent: {
        organization_id: organizationId,
        agent_id: agentId,
        owner_user_id: principalId,
        name: `Readiness Agent ${index}`,
        desired_state: "deleted",
        lifecycle_state: "deleted",
        runtime_state: "absent",
        readiness: "unavailable",
        access_revision: `access_deleted_${suffix}`,
        last_successful_execution_revision: execution,
        aggregate_sequence: 5,
        created_at: iso(-1000),
        updated_at: iso(5000),
      },
    },
    resources: {
      before: {
        containers: [
          {
            Id: index.toString(16).padStart(64, "0"),
            Image: "sha256:" + "b".repeat(64),
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "healthy" },
              ExitCode: 0,
              OOMKilled: false,
              Error: "",
            },
            RestartCount: 0,
            Config: {
              Labels: {
                "io.antnest.managed": "runtime",
                "io.antnest.runtime-controller-scope":
                  "antnest-stage3-e2e-12345",
                "io.antnest.agent-id": agentId,
                "io.antnest.runtime-generation": "1",
                "io.antnest.runtime-spec-digest": "c".repeat(64),
              },
            },
            Mounts: [
              {
                Type: "volume",
                Name: workspace,
                Destination: "/workspace",
                RW: true,
              },
              {
                Type: "volume",
                Name: skills,
                Destination: "/skills",
                RW: false,
              },
              {
                Type: "volume",
                Name: auth,
                Destination: "/run/antnest-auth",
                RW: false,
              },
            ],
          },
        ],
        volumes: [workspace, skills, auth],
      },
      after: { containers: [], volumes: [] },
      runtimeStatus: {
        agent_id: agentId,
        generation: 1,
        execution_id: process,
        status: "ready",
        test_features: [],
      },
    },
  };
}

function batchFixture(count = 100) {
  const rounds = Array.from({ length: count }, (_, index) =>
    roundFixture(index + 1),
  );
  return {
    rounds,
    model: {
      requests: rounds.map((round) => structuredClone(round.model.requests[0])),
      errors: [],
    },
  };
}

test("one original ready binding admits exactly one completed Prompt and proves cleanup without changing evidence", () => {
  const round = roundFixture();
  const before = structuredClone(round);
  assert.doesNotThrow(() => inspectRound(round));
  assert.deepEqual(round, before);
});

test("one hundred fresh rounds preserve distinct original Agents, operations, phases, Sessions and Runs", () => {
  const batch = batchFixture();
  const before = structuredClone(batch);
  assert.doesNotThrow(() => inspectBatch(batch));
  assert.deepEqual(batch, before);
});

test("the default expectation is the full one hundred rounds", () => {
  assert.throws(() => inspectBatch(batchFixture(99)));
  assert.doesNotThrow(() => inspectBatch(batchFixture(3), 3));
});

test("three functional rounds pass only when all three complete", () => {
  assert.doesNotThrow(() => inspectBatch(batchFixture(3), 3));
  assert.throws(() => inspectBatch(batchFixture(2), 3));
  assert.throws(() => inspectBatch(batchFixture(100), 3));
});

test("the expected round count accepts only the functional or soak policy", () => {
  for (const expected of [0, 1, 2, 4, 99, 101, "3", "100", undefined])
    assert.throws(() => inspectBatch(batchFixture(3), expected));
});

test("the environment round policy accepts only three or one hundred", () => {
  assert.equal(readinessRounds(undefined), 100);
  assert.equal(readinessRounds("3"), 3);
  assert.equal(readinessRounds("100"), 100);
  for (const value of ["", "0", "2", "99", "1000", "three", " 3", "3 "])
    assert.throws(() => readinessRounds(value), value);
});

for (const [name, change] of [
  [
    "an extra ACP-ready wait before initialization",
    (round) => {
      round.actions.splice(1, 0, { name: "acp_ready_poll", at: 10.5 });
    },
  ],
  [
    "a repeated Prompt action",
    (round) => {
      round.actions.push({ name: "prompt_started", at: 14 });
    },
  ],
  [
    "non-monotonic action times",
    (round) => {
      round.actions[2].at = round.actions[1].at - 1;
    },
  ],
  ["missing ready acknowledgement", (round) => round.events.pop()],
  [
    "legacy ready without v2 proof",
    (round) => {
      round.events[1].schema_version = 1;
    },
  ],
  [
    "ACK below the binding threshold",
    (round) => {
      round.events[1].data.applied_revision -= 1;
    },
  ],
  [
    "ready for another execution",
    (round) => {
      round.events[1].data.execution_revision_id = "execution_other";
    },
  ],
  [
    "stored Run for another execution",
    (round) => {
      round.run.execution_snapshot.executionRevision = "execution_other";
    },
  ],
  [
    "stored Run has not completed",
    (round) => {
      round.run.state = "running";
      round.runList.items[0].state = "running";
    },
  ],
  [
    "stored executor has not joined",
    (round) => {
      round.run.executor_state = "cancellation_requested";
    },
  ],
  [
    "wrong durable terminal class",
    (round) => {
      round.run.terminal_class = "unresolved";
    },
  ],
  [
    "non-end-turn durable outcome",
    (round) => {
      round.run.stop_reason = "max_tokens";
    },
  ],
  [
    "changed original Prompt content",
    (round) => {
      round.run.input[0].text = "replacement Prompt";
    },
  ],
  [
    "stored Run for another Session",
    (round) => {
      round.run.session_id = "session_other";
    },
  ],
  [
    "stored Run for another Principal",
    (round) => {
      round.run.principal_id = "user_other";
    },
  ],
  [
    "truncated Run inventory",
    (round) => {
      round.runList.next_cursor = "more-runs";
    },
  ],
  [
    "missing durable Run",
    (round) => {
      round.runList.items = [];
    },
  ],
  [
    "a second Run hidden by the selected detail",
    (round) => {
      round.runList.items.push({
        ...round.runList.items[0],
        run_id: "run_extra",
      });
    },
  ],
  [
    "Run detail disagrees with its inventory",
    (round) => {
      round.runList.items[0].run_id = "run_other";
    },
  ],
  [
    "connection has not actually closed",
    (round) => {
      round.connection.closed = false;
    },
  ],
  [
    "connection belongs to another Agent",
    (round) => {
      round.connection.agent_id = "agent_other";
    },
  ],
  [
    "wrong initialization method",
    (round) => {
      round.connection.initialization.method = "session/new";
    },
  ],
  [
    "duplicate original Prompt",
    (round) => {
      round.connection.evidence.push(
        structuredClone(round.connection.evidence[1]),
      );
    },
  ],
  [
    "hidden outgoing Prompt outside the business rows",
    (round) => {
      round.connection.requests.push({
        method: "session/prompt",
        requestId: "4",
        sessionId: round.run.session_id,
      });
    },
  ],
  [
    "hidden outgoing Session request",
    (round) => {
      round.connection.requests.push({ method: "session/new", requestId: "4" });
    },
  ],
  [
    "missing outgoing original Prompt",
    (round) => {
      round.connection.requests.pop();
    },
  ],
  [
    "failed original Prompt receipt",
    (round) => {
      round.connection.evidence[1].outcome = "failed";
    },
  ],
  [
    "changed receipt Session",
    (round) => {
      round.connection.evidence[1].requestReceipt.params.sessionId =
        "session_other";
    },
  ],
  [
    "changed receipt Prompt",
    (round) => {
      round.connection.evidence[1].requestReceipt.params.prompt[0].text =
        "replacement Prompt";
    },
  ],
  [
    "receipt is missing the original parameters",
    (round) => {
      delete round.connection.evidence[1].requestReceipt.params;
    },
  ],
  [
    "receipt returned another new Session",
    (round) => {
      round.connection.evidence[0].requestReceipt.result.sessionId =
        "session_other";
    },
  ],
  [
    "Prompt did not return end_turn",
    (round) => {
      round.connection.evidence[1].requestReceipt.result.stopReason = "refusal";
    },
  ],
  [
    "missing model execution",
    (round) => {
      round.model.requests = [];
    },
  ],
  [
    "duplicate model execution",
    (round) => {
      round.model.requests.push(structuredClone(round.model.requests[0]));
    },
  ],
  [
    "another model phase",
    (round) => {
      round.model.requests[0].phase = "readiness-other";
    },
  ],
  [
    "unexpected model Tool dispatch",
    (round) => {
      round.model.requests[0].stage = "tool";
    },
  ],
  [
    "model rejected the actual request",
    (round) => {
      round.model.errors.push("synthetic request rejected");
    },
  ],
  [
    "publication already forwarded before the pending observation",
    (round) => {
      round.delayed.before.forwardedAt = round.publication.forwardedAt;
    },
  ],
  [
    "publication forwarded during the pending observation",
    (round) => {
      round.delayed.after.forwardedAt = round.publication.forwardedAt;
    },
  ],
  [
    "pending observation already has an upstream result",
    (round) => {
      round.delayed.after.upstreamCompletedAt =
        round.publication.upstreamCompletedAt;
    },
  ],
  [
    "pending observation already completed",
    (round) => {
      round.delayed.after.completedAt = round.publication.completedAt;
    },
  ],
  [
    "pending observation belongs to another attempt",
    (round) => {
      round.delayed.after.id = "publication-other";
    },
  ],
  [
    "pending observation has another organization",
    (round) => {
      round.delayed.before.organizationId = "org_other";
    },
  ],
  [
    "pending observation has another revision",
    (round) => {
      round.delayed.after.revision += 1;
    },
  ],
  [
    "pending observation has different original bytes",
    (round) => {
      round.delayed.before.requestSha256 = "d".repeat(64);
    },
  ],
  [
    "pending observation has another binding",
    (round) => {
      round.delayed.after.bindings[0].execution_revision = "execution_other";
    },
  ],
  [
    "Agent was already ready in the delay window",
    (round) => {
      round.delayed.agent.readiness = "ready";
    },
  ],
  [
    "pending Agent has another binding",
    (round) => {
      round.delayed.agent.executable_execution_revision = "execution_other";
    },
  ],
  [
    "pending Agent has another Runtime",
    (round) => {
      round.delayed.agent.runtime.runtime_revision = "rtv_other";
    },
  ],
  [
    "historical ready appears before forwarding",
    (round) => {
      round.delayed.events.push({
        ...structuredClone(round.events[1]),
        event_id: "event_historical",
        schema_version: 1,
        operation_request_id: "create_historical",
      });
    },
  ],
  [
    "pending window lacks the bound event",
    (round) => {
      round.delayed.events = [];
    },
  ],
  [
    "current Agent is not acknowledged ready",
    (round) => {
      round.currentAgent.readiness = "preparing";
    },
  ],
  [
    "current Agent binding differs from the ready proof",
    (round) => {
      round.currentAgent.executable_execution_revision = "execution_other";
    },
  ],
  [
    "Runtime process differs from the current binding",
    (round) => {
      round.resources.runtimeStatus.execution_id = "exec-process-other";
    },
  ],
  [
    "Runtime status is not ready",
    (round) => {
      round.resources.runtimeStatus.status = "ok";
    },
  ],
  [
    "Runtime status belongs to another Agent",
    (round) => {
      round.resources.runtimeStatus.agent_id = "agent_other";
    },
  ],
  [
    "Runtime status has another generation",
    (round) => {
      round.resources.runtimeStatus.generation = 2;
    },
  ],
  [
    "missing original physical Runtime",
    (round) => {
      round.resources.before.containers = [];
    },
  ],
  [
    "extra original physical Runtime",
    (round) => {
      round.resources.before.containers.push(
        structuredClone(round.resources.before.containers[0]),
      );
    },
  ],
  [
    "original Runtime is not running",
    (round) => {
      round.resources.before.containers[0].State.Running = false;
    },
  ],
  [
    "physical Runtime belongs to another Agent",
    (round) => {
      round.resources.before.containers[0].Config.Labels[
        "io.antnest.agent-id"
      ] = "agent_other";
    },
  ],
  [
    "physical Runtime lacks its owned scope",
    (round) => {
      delete round.resources.before.containers[0].Config.Labels[
        "io.antnest.runtime-controller-scope"
      ];
    },
  ],
  [
    "physical Runtime has another generation",
    (round) => {
      round.resources.before.containers[0].Config.Labels[
        "io.antnest.runtime-generation"
      ] = "2";
    },
  ],
  [
    "missing auth mount",
    (round) => {
      round.resources.before.containers[0].Mounts.pop();
    },
  ],
  [
    "writable Skill mount",
    (round) => {
      round.resources.before.containers[0].Mounts[1].RW = true;
    },
  ],
  [
    "read-only workspace mount",
    (round) => {
      round.resources.before.containers[0].Mounts[0].RW = false;
    },
  ],
  [
    "bind mount substituted for an owned volume",
    (round) => {
      round.resources.before.containers[0].Mounts[0].Type = "bind";
    },
  ],
  [
    "another workspace volume",
    (round) => {
      round.resources.before.containers[0].Mounts[0].Name =
        "antnest-workspace-other";
    },
  ],
  [
    "unaccounted owned volume",
    (round) => {
      round.resources.before.volumes.push("antnest-unaccounted-volume");
    },
  ],
  [
    "delete operation is still running",
    (round) => {
      round.deleted.operation.state = "running";
    },
  ],
  [
    "delete operation belongs to another Agent",
    (round) => {
      round.deleted.operation.agent_id = "agent_other";
    },
  ],
  [
    "another completed operation is substituted for deletion",
    (round) => {
      round.deleted.operation.kind = "disable";
    },
  ],
  [
    "deleted projection is still created",
    (round) => {
      round.deleted.agent.lifecycle_state = "created";
    },
  ],
  [
    "deleted projection retains an executable entry",
    (round) => {
      round.deleted.agent.executable_execution_revision =
        round.currentAgent.executable_execution_revision;
    },
  ],
  [
    "Runtime container has not actually disappeared",
    (round) => {
      round.resources.after.containers.push(
        structuredClone(round.resources.before.containers[0]),
      );
    },
  ],
  [
    "owned volume has not actually disappeared",
    (round) => {
      round.resources.after.volumes.push(round.resources.before.volumes[1]);
    },
  ],
  [
    "cleanup evidence was not collected",
    (round) => {
      delete round.resources.after;
    },
  ],
]) {
  test("round admission rejects " + name, () => {
    const round = roundFixture();
    change(round);
    assert.throws(() => inspectRound(round));
  });
}

for (const [name, change] of [
  [
    "only ninety-nine executed rounds",
    (batch) => {
      batch.rounds.pop();
    },
  ],
  [
    "an extra round",
    (batch) => {
      batch.rounds.push(roundFixture(101));
    },
  ],
  [
    "missing index one",
    (batch) => {
      batch.rounds = Array.from({ length: 100 }, (_, index) =>
        roundFixture(index + 2),
      );
      batch.model.requests = batch.rounds.map((round) =>
        structuredClone(round.model.requests[0]),
      );
    },
  ],
  [
    "duplicate Agent identity",
    (batch) => {
      batch.rounds[1] = roundFixture(2, { agentId: batch.rounds[0].agentId });
    },
  ],
  [
    "duplicate original operation identity",
    (batch) => {
      batch.rounds[1] = roundFixture(2, {
        operationId: batch.rounds[0].operationId,
      });
    },
  ],
  [
    "duplicate original Session identity",
    (batch) => {
      batch.rounds[1] = roundFixture(2, {
        sessionId: batch.rounds[0].run.session_id,
      });
    },
  ],
  [
    "duplicate durable Run identity",
    (batch) => {
      batch.rounds[1] = roundFixture(2, { runId: batch.rounds[0].run.run_id });
    },
  ],
  [
    "duplicate phase",
    (batch) => {
      batch.rounds[1] = roundFixture(2, { phase: batch.rounds[0].phase });
    },
  ],
  [
    "missing final model request",
    (batch) => {
      batch.model.requests.pop();
    },
  ],
  [
    "duplicate final model request",
    (batch) => {
      batch.model.requests.push(structuredClone(batch.model.requests[0]));
    },
  ],
  [
    "one model phase replaced by a duplicate",
    (batch) => {
      batch.model.requests[1] = structuredClone(batch.model.requests[0]);
    },
  ],
  [
    "unexecuted model phase substituted into the final inventory",
    (batch) => {
      batch.model.requests[0].phase = "readiness-never-dispatched";
    },
  ],
  [
    "a final model Tool dispatch",
    (batch) => {
      batch.model.requests[0].stage = "tool";
    },
  ],
  [
    "a final model error",
    (batch) => {
      batch.model.errors.push("synthetic model failure");
    },
  ],
  [
    "an invalid round hidden by complete aggregate counts",
    (batch) => {
      batch.rounds[50].run.executor_state = "unknown";
    },
  ],
]) {
  test("batch admission rejects " + name, () => {
    const batch = batchFixture();
    change(batch);
    assert.throws(() => inspectBatch(batch));
  });
}
