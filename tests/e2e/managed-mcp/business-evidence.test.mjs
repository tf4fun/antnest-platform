import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { complete, guidance, skillSummary } from "./model.mjs";

const implementationURL = new URL("./business-evidence.mjs", import.meta.url);
const implementation = await import(implementationURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(implementationURL.pathname)
  )
    throw error;
  return {};
});

function inspector() {
  assert.equal(
    typeof implementation.inspectManagedBusinessEvidence,
    "function",
    "inspectManagedBusinessEvidence is not implemented",
  );
  return implementation.inspectManagedBusinessEvidence;
}

function collector() {
  assert.equal(
    typeof implementation.collectManagedBusinessEvidence,
    "function",
    "collectManagedBusinessEvidence is not implemented",
  );
  return implementation.collectManagedBusinessEvidence;
}

// These are the six inputs actually sent by client.mjs, not Trace-derived Runs.
const plans = [
  ["managed-bootstrap", ["write", "write"]],
  ["managed-exercise", ["mcp__alpha__fail", "mcp__alpha__echo", "bash"]],
  ["managed-mutate", ["write"]],
  ["managed-fresh", ["mcp__alpha__echo"]],
  ["managed-draining", ["mcp__alpha__echo", "mcp__alpha__echo"]],
  ["managed-rebuilt", ["mcp__beta__echo"]],
];
const expectedSummary = {
  status: "passed",
  runs: 6,
  tool_calls: 10,
  managed_tool_calls: 6,
  builtin_tool_calls: 4,
  failed_tool_calls: 1,
  model_requests: 16,
};
const clone = (value) => structuredClone(value);
const frame = (sessionId, update) => ({ sessionId, update });
const time = (offset) => new Date(Date.UTC(2026, 9, 22) + offset).toISOString();

function capturedRuntime(generation) {
  return {
    agent_id: "agent-managed",
    runtime_revision: `rtv_${String(generation).repeat(32)}`,
    runtime_execution_id: `execution-instance-${generation}`,
    mcp_endpoint: "http://runtime-managed:8080/mcp",
    execution_revision: `execution-revision-${generation}`,
    template_id: "template-managed",
    template_revision: generation,
  };
}

function storedSnapshot(captured) {
  // Admin Console's execution_snapshot projection omits private authority.
  // Each original prompt retains captureRuntime() separately for its binding.
  return {
    providerConnectionId: "provider-managed",
    modelProfileId: "model-managed",
    configurationRevision: captured.template_revision,
    deadlineAt: time(120000),
    agentSpecRevision: `agent-spec-${captured.template_revision}`,
    executionRevision: captured.execution_revision,
    agentExecutionSpecDigest: "b".repeat(64),
    executionSpec: {
      systemPrompt: "PRIVATE_MANAGED_BUSINESS_CANARY",
      contextPolicyVersion: "context-v1",
      model: {
        model: "managed-fixture",
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsImages: false,
      },
      maxModelRequests: 12,
      configuration: {
        modelProfileId: "model-managed",
        authorizationRevision: 1,
        authorization: { mode: "auto", toolRules: [] },
      },
    },
  };
}

function toolIdentity(run, step, providerId = `${run.input[0].text}-${step}`) {
  return createHash("sha256")
    .update(JSON.stringify([run.run_id, step, providerId]))
    .digest("hex");
}

function echo(phase, calls) {
  return {
    value: phase,
    uid: 2000,
    gid: 1000,
    pid: 4242,
    calls,
    explicit_env: true,
    supervisor_env: false,
    launcher_env: false,
    home: "/run/antnest-mcp-home/2000",
    cwd: "/workspace",
    cache_paths: [
      "/run/antnest-mcp-home/2000/token",
      "/run/antnest-mcp-home/2000/tmp/token",
      "/run/antnest-mcp-home/2000/.cache/token",
      "/run/antnest-mcp-home/2000/.config/token",
      "/tmp/token",
    ],
    cache_modes: Array(5).fill(0o600),
    cache_owned_and_readable: true,
    cache_executable_ok: true,
  };
}

function toolResult(phase, name, step) {
  if (name === "mcp__alpha__fail") return "fixture tool failed";
  if (name === "bash") return "MANAGED_CREDENTIAL_ISOLATION_OK";
  if (name.startsWith("mcp__")) {
    const calls =
      phase === "managed-exercise"
        ? 1
        : phase === "managed-fresh"
          ? 2
          : phase === "managed-draining"
            ? 3 + step
            : 1;
    return JSON.stringify(echo(phase, calls));
  }
  return "File written";
}

function modelPayload(phase, results) {
  const server = phase === "managed-rebuilt" ? "beta" : "alpha";
  const generation = [
    "managed-fresh",
    "managed-draining",
    "managed-rebuilt",
  ].includes(phase)
    ? 2
    : 1;
  return {
    tools: [{ function: { name: `mcp__${server}__echo` } }],
    messages: [
      {
        role: "system",
        content: `Current Runtime information ${guidance(generation)} ${skillSummary} .antnest/skills/fixture/SKILL.md`,
      },
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
  };
}

// Real API shapes: AuditList, AuditDetail and stream=execution AuditEvents.
// No made-up tool_attempts/runtime_call_stopped fields are exposed by this API.
// The protocol projection uses the actual v1 wrapped Tool content and v2 shape.
function fixture(version = 1) {
  const evidence = {
    version,
    agentId: "agent-managed",
    sessionId: "session-managed",
    principalId: "principal-managed-owner",
    requests: [],
    model: { requests: [], errors: [], held: null },
    original: [],
    replayed: [],
    auditList: { items: [], next_cursor: null },
    runs: [],
    errors: [],
  };
  let sequence = 0;
  for (const [index, [phase, names]] of plans.entries()) {
    const snapshot = capturedRuntime(phase === "managed-rebuilt" ? 2 : 1);
    const run = {
      run_id: `run-managed-${index}`,
      session_id: evidence.sessionId,
      agent_id: evidence.agentId,
      principal_id: evidence.principalId,
      state: "completed",
      created_at: time(index * 1000),
      updated_at: time(index * 1000 + 500),
      input: [{ type: "text", text: phase }],
      execution_snapshot: storedSnapshot(snapshot),
      terminal_class: "completed",
      executor_state: "quiescent",
      tool_effect_state: "settled",
      unknown_effect_source: null,
      stop_reason: "end_turn",
      error_class: null,
      usage_measurements: [],
    };
    const events = { stream: "execution", items: [], next_cursor: null };
    const append = (payload, visible = true) => {
      sequence++;
      const row = {
        id: payload.messageId ?? `message-managed-${sequence}`,
        sequence,
        kind: payload.kind,
        visible,
        payload,
        created_at: time(index * 1000 + events.items.length + 1),
      };
      events.items.push(row);
      return row;
    };
    const user = append({
      kind: "user_message",
      messageId: `input-managed-${index}`,
      content: clone(run.input),
    });
    const inputUpdate = frame(evidence.sessionId, {
      sessionUpdate: version === 1 ? "user_message_chunk" : "user_message",
      messageId: user.payload.messageId,
      content: version === 1 ? clone(run.input[0]) : clone(run.input),
    });
    if (version === 2) {
      evidence.original.push(inputUpdate);
      evidence.original.push(
        frame(evidence.sessionId, {
          sessionUpdate: "state_update",
          state: "running",
        }),
      );
    }
    evidence.replayed.push(clone(inputUpdate));
    const results = [];
    for (const [step, name] of names.entries()) {
      // Obtain genuine fixture decision/argument shapes, including its Bash
      // isolation command. This is source fixture data, not wire acceptance.
      const decision = complete(modelPayload(phase, results));
      const call = decision.choices[0].message.tool_calls[0];
      assert.equal(call.function.name, name);
      const toolCallId = toolIdentity(run, step, call.id);
      const arguments_ = JSON.parse(call.function.arguments);
      evidence.model.requests.push({ phase, step, outcome: "validated" });
      append(
        {
          kind: "agent_message",
          messageId: `proposal-${index}-${step}`,
          content: [],
          toolCalls: [{ id: toolCallId, name, arguments: arguments_ }],
        },
        false,
      );
      const start = {
        kind: "tool_call",
        initial: true,
        toolCallId,
        title: name,
        modelName: name,
        arguments: clone(arguments_),
        status: "in_progress",
      };
      append(start);
      const started = frame(evidence.sessionId, {
        sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
        toolCallId,
        title: name,
        name,
        rawInput: clone(arguments_),
        status: "in_progress",
      });
      evidence.original.push(started);
      evidence.replayed.push(clone(started));
      const text = toolResult(phase, name, step);
      const terminal = {
        kind: "tool_call",
        initial: false,
        toolCallId,
        status: name === "mcp__alpha__fail" ? "failed" : "completed",
        content: [{ type: "text", text }],
        ...(name.endsWith("__echo") ? { rawOutput: JSON.parse(text) } : {}),
        ...(name === "write"
          ? { file: { path: `/workspace/${arguments_.path}` } }
          : {}),
      };
      append(terminal);
      const finished = frame(evidence.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: terminal.status,
        content: terminal.content.map((content) => ({
          type: "content",
          content: clone(content),
        })),
        ...(terminal.rawOutput === undefined
          ? {}
          : { rawOutput: clone(terminal.rawOutput) }),
        ...(terminal.file === undefined
          ? {}
          : { locations: [{ path: terminal.file.path }] }),
      });
      evidence.original.push(finished);
      evidence.replayed.push(clone(finished));
      results.push(text);
    }
    const final = complete(modelPayload(phase, results));
    assert.equal(final.choices[0].finish_reason, "stop");
    evidence.model.requests.push({
      phase,
      step: names.length,
      outcome: "validated",
    });
    const answer = append({
      kind: "agent_message",
      messageId: `answer-managed-${index}`,
      content: [{ type: "text", text: final.choices[0].message.content }],
    });
    const answerUpdate = frame(evidence.sessionId, {
      sessionUpdate: version === 1 ? "agent_message_chunk" : "agent_message",
      messageId: answer.payload.messageId,
      content:
        version === 1
          ? clone(answer.payload.content[0])
          : clone(answer.payload.content),
    });
    evidence.original.push(answerUpdate);
    evidence.replayed.push(clone(answerUpdate));
    if (version === 2)
      evidence.original.push(
        frame(evidence.sessionId, {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        }),
      );
    const requestId = String(100 + index);
    evidence.requests.push({
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: version,
      agentId: evidence.agentId,
      sessionId: evidence.sessionId,
      method: "session/prompt",
      requestId,
      kind: "managed",
      label: phase,
      phase,
      snapshot,
      outcome: "succeeded",
      requestReceipt: {
        requestId,
        params: { sessionId: evidence.sessionId, prompt: clone(run.input) },
        result:
          version === 1
            ? { stopReason: "end_turn" }
            : { messageId: user.payload.messageId },
      },
    });
    const {
      run_id,
      session_id,
      agent_id,
      principal_id,
      state,
      created_at,
      updated_at,
    } = run;
    evidence.auditList.items.unshift({
      run_id,
      session_id,
      agent_id,
      principal_id,
      state,
      created_at,
      updated_at,
    });
    evidence.runs.push({ run, events });
  }
  if (version === 2)
    evidence.replayed.push(
      frame(evidence.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      }),
    );
  return evidence;
}

function inputOf(evidence) {
  const { auditList, runs, errors, ...input } = evidence;
  void auditList;
  void runs;
  void errors;
  return clone(input);
}

function firstStart(evidence) {
  return evidence.runs[0].events.items.find(
    ({ payload }) => payload.kind === "tool_call" && payload.initial,
  );
}

function firstTerminal(evidence) {
  return evidence.runs[0].events.items.find(
    ({ payload }) => payload.kind === "tool_call" && payload.initial === false,
  );
}

function readFixture(evidence, visits = []) {
  return async (path, options = {}) => {
    const url = new URL(path, "http://managed-audit.invalid");
    assert.equal(url.origin, "http://managed-audit.invalid");
    options.signal?.throwIfAborted();
    visits.push({
      path: url.pathname,
      query: url.searchParams,
      signal: options.signal,
    });
    if (url.pathname === "/api/admin/execution-audits") {
      assert.equal(url.searchParams.get("agent_id"), evidence.agentId);
      assert.equal(url.searchParams.get("session_id"), evidence.sessionId);
      assert.equal(url.searchParams.get("limit"), "100");
      return clone(evidence.auditList);
    }
    const match = url.pathname.match(
      /^\/api\/admin\/execution-audits\/([^/]+)(\/events)?$/u,
    );
    assert(match, "unexpected audit request path");
    const record = evidence.runs.find(
      ({ run }) => run.run_id === decodeURIComponent(match[1]),
    );
    assert(record, "unknown audit Run");
    if (!match[2]) return clone(record.run);
    assert.equal(url.searchParams.get("limit"), "100");
    assert(
      !url.searchParams.has("cursor"),
      "incomplete pages are rejected, not silently merged",
    );
    return clone(record.events);
  };
}

const flatten = (error) =>
  error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Managed evidence test barrier timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withCleanup(body, cleanup) {
  const errors = [];
  let result;
  try {
    result = await body();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Managed test and cleanup failed");
  return result;
}

for (const version of [1, 2]) {
  test(`v${version}: actual public Admin DTOs bind to the original captured execution revision`, () => {
    const inspect = inspector();
    const evidence = fixture(version);
    for (const { run } of evidence.runs) {
      const snapshot = run.execution_snapshot;
      // services/admin-console/internal/server/execution_snapshot_projection.go
      // exposes these fields; it does not expose Runtime process/endpoint data.
      assert.deepEqual(
        Object.keys(snapshot).sort(),
        [
          "providerConnectionId",
          "modelProfileId",
          "configurationRevision",
          "agentSpecRevision",
          "executionRevision",
          "deadlineAt",
          "agentExecutionSpecDigest",
          "executionSpec",
        ].sort(),
      );
      assert.deepEqual(
        Object.keys(snapshot.executionSpec).sort(),
        [
          "systemPrompt",
          "contextPolicyVersion",
          "maxModelRequests",
          "model",
          "configuration",
        ].sort(),
      );
      assert(!Object.hasOwn(snapshot.executionSpec.model, "baseUrl"));
      const request = evidence.requests.find(
        (value) => value.phase === run.input[0].text,
      );
      assert.equal(
        snapshot.executionRevision,
        request.snapshot.execution_revision,
      );
    }
    assert.deepEqual(inspect(evidence), expectedSummary);
  });
  test(`v${version}: six actual audit Runs and ten paired Tools pass without Trace`, () => {
    const inspect = inspector();
    const evidence = fixture(version);
    const before = clone(evidence);
    assert.deepEqual(inspect(evidence), expectedSummary);
    assert.deepEqual(
      evidence,
      before,
      "business inspection mutated its raw evidence",
    );
    assert(
      !JSON.stringify(inspect(evidence)).includes(
        "PRIVATE_MANAGED_BUSINESS_CANARY",
      ),
    );
  });
  test(`v${version}: audit ordering and legal sequence gaps do not manufacture missing facts`, () => {
    const inspect = inspector();
    const evidence = fixture(version);
    evidence.runs.reverse();
    for (const { events } of evidence.runs)
      for (const row of events.items) row.sequence *= 2;
    assert.deepEqual(inspect(evidence), expectedSummary);
  });
  test(`v${version}: progress for an existing Tool does not count as another execution`, () => {
    const inspect = inspector();
    const evidence = fixture(version);
    for (const { events } of evidence.runs)
      for (const row of events.items) row.sequence *= 3;
    const start = firstStart(evidence);
    const rows = evidence.runs[0].events.items;
    const progress = {
      id: "message-managed-progress",
      sequence: start.sequence + 1,
      kind: "tool_call",
      visible: true,
      payload: {
        kind: "tool_call",
        initial: false,
        toolCallId: start.payload.toolCallId,
        status: "in_progress",
        content: [{ type: "text", text: "write progress" }],
      },
      created_at: start.created_at,
    };
    rows.splice(rows.indexOf(start) + 1, 0, progress);
    const update = frame(evidence.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: start.payload.toolCallId,
      status: "in_progress",
      content: [
        { type: "content", content: clone(progress.payload.content[0]) },
      ],
    });
    for (const notifications of [evidence.original, evidence.replayed]) {
      const index = notifications.findIndex(
        ({ update }) => update.toolCallId === start.payload.toolCallId,
      );
      notifications.splice(index + 1, 0, clone(update));
    }
    assert.deepEqual(inspect(evidence), expectedSummary);
  });
}

const invalidCases = [
  ["missing phase request", (e) => e.requests.pop()],
  ["duplicate phase request", (e) => e.requests.push(clone(e.requests[0]))],
  [
    "unrecognized phase request",
    (e) => {
      e.requests[0].phase = "managed-extra";
    },
  ],
  [
    "request has foreign Agent",
    (e) => {
      e.requests[0].agentId = "foreign-agent";
    },
  ],
  [
    "request has foreign Session",
    (e) => {
      e.requests[0].sessionId = "foreign-session";
    },
  ],
  [
    "request is not a prompt",
    (e) => {
      e.requests[0].method = "session/new";
    },
  ],
  [
    "request failed",
    (e) => {
      e.requests[0].outcome = "failed";
    },
  ],
  [
    "request receipt missing",
    (e) => {
      delete e.requests[0].requestReceipt;
    },
  ],
  [
    "request receipt identity changed",
    (e) => {
      e.requests[0].requestReceipt.requestId = "foreign";
    },
  ],
  [
    "request receipt input changed",
    (e) => {
      e.requests[0].requestReceipt.params.prompt[0].text = "managed-fresh";
    },
  ],
  [
    "request receipt Session changed",
    (e) => {
      e.requests[0].requestReceipt.params.sessionId = "foreign";
    },
  ],
  [
    "duplicate actual request ID",
    (e) => {
      e.requests[1].requestId = e.requests[0].requestId;
      e.requests[1].requestReceipt.requestId = e.requests[0].requestId;
    },
  ],
  [
    "audit list pagination incomplete",
    (e) => {
      e.auditList.next_cursor = "opaque-next";
    },
  ],
  [
    "extra audit Run",
    (e) => {
      e.auditList.items.push({ ...e.auditList.items[0], run_id: "run-extra" });
    },
  ],
  ["missing audit Run", (e) => e.auditList.items.pop()],
  [
    "duplicate audit Run",
    (e) => {
      e.auditList.items[1] = clone(e.auditList.items[0]);
    },
  ],
  [
    "foreign list Agent",
    (e) => {
      e.auditList.items[0].agent_id = "foreign";
    },
  ],
  [
    "foreign list Session",
    (e) => {
      e.auditList.items[0].session_id = "foreign";
    },
  ],
  [
    "foreign list Principal",
    (e) => {
      e.auditList.items[0].principal_id = "foreign";
    },
  ],
  [
    "list detail state mismatch",
    (e) => {
      e.auditList.items[0].state = "running";
    },
  ],
  ["missing raw Run detail", (e) => e.runs.pop()],
  ["extra raw Run detail", (e) => e.runs.push(clone(e.runs[0]))],
  [
    "detail has foreign Run",
    (e) => {
      e.runs[0].run.run_id = "foreign";
    },
  ],
  [
    "detail has foreign Agent",
    (e) => {
      e.runs[0].run.agent_id = "foreign";
    },
  ],
  [
    "detail has foreign Session",
    (e) => {
      e.runs[0].run.session_id = "foreign";
    },
  ],
  [
    "detail has foreign Principal",
    (e) => {
      e.runs[0].run.principal_id = "foreign";
    },
  ],
  [
    "detail has wrong prompt phase",
    (e) => {
      e.runs[0].run.input = clone(e.runs[1].run.input);
    },
  ],
  [
    "Run is not terminal",
    (e) => {
      e.runs[0].run.state = "running";
    },
  ],
  [
    "Run terminal class changed",
    (e) => {
      e.runs[0].run.terminal_class = "unresolved";
    },
  ],
  [
    "Run executor is not quiescent",
    (e) => {
      e.runs[0].run.executor_state = "unknown";
    },
  ],
  [
    "Run has unknown effects",
    (e) => {
      e.runs[0].run.tool_effect_state = "unknown";
    },
  ],
  [
    "Run has unexpected error",
    (e) => {
      e.runs[0].run.error_class = "tool_outcome_unknown";
    },
  ],
  [
    "Run has unknown effect source",
    (e) => {
      e.runs[0].run.unknown_effect_source = "runtime_mcp";
    },
  ],
  [
    "Run did not end turn",
    (e) => {
      e.runs[0].run.stop_reason = "max_turn_requests";
    },
  ],
  [
    "missing captured execution",
    (e) => {
      delete e.runs[0].run.execution_snapshot;
    },
  ],
  [
    "execution revision changed",
    (e) => {
      e.runs[0].run.execution_snapshot.executionRevision = "foreign";
    },
  ],
  [
    "original captured execution revision changed",
    (e) => {
      e.requests[0].snapshot.execution_revision = "foreign";
    },
  ],
  [
    "original captured Runtime revision missing",
    (e) => {
      delete e.requests[0].snapshot.runtime_revision;
    },
  ],
  [
    "original captured Runtime instance missing",
    (e) => {
      delete e.requests[0].snapshot.runtime_execution_id;
    },
  ],
  [
    "original captured Runtime endpoint missing",
    (e) => {
      delete e.requests[0].snapshot.mcp_endpoint;
    },
  ],
  [
    "original Runtime capture missing",
    (e) => {
      delete e.requests[0].snapshot;
    },
  ],
  [
    "request captured another Agent",
    (e) => {
      e.requests[0].snapshot.agent_id = "foreign";
    },
  ],
  [
    "draining Run switched to replacement",
    (e) => {
      e.runs[4].run.execution_snapshot = clone(
        e.runs[5].run.execution_snapshot,
      );
    },
  ],
  [
    "rebuilt Run reused old execution",
    (e) => {
      e.runs[5].run.execution_snapshot = clone(
        e.runs[4].run.execution_snapshot,
      );
    },
  ],
  [
    "events page missing",
    (e) => {
      delete e.runs[0].events;
    },
  ],
  [
    "events pagination incomplete",
    (e) => {
      e.runs[0].events.next_cursor = "opaque-next";
    },
  ],
  [
    "permissions stream is not execution evidence",
    (e) => {
      e.runs[0].events.stream = "permissions";
    },
  ],
  [
    "events assigned to another Run",
    (e) => {
      [e.runs[0].events, e.runs[1].events] = [
        e.runs[1].events,
        e.runs[0].events,
      ];
    },
  ],
  [
    "duplicate persistent event ID",
    (e) => {
      e.runs[0].events.items[1].id = e.runs[0].events.items[0].id;
    },
  ],
  [
    "persistent event ID borrowed from another Run",
    (e) => {
      e.runs[1].events.items[0].id = e.runs[0].events.items[0].id;
    },
  ],
  [
    "duplicate persistent sequence",
    (e) => {
      e.runs[0].events.items[1].sequence = e.runs[0].events.items[0].sequence;
    },
  ],
  ["persistent events reordered", (e) => e.runs[0].events.items.reverse()],
  [
    "invalid persistent sequence",
    (e) => {
      e.runs[0].events.items[0].sequence = 0;
    },
  ],
  [
    "event kind conflicts with payload",
    (e) => {
      firstStart(e).kind = "agent_message";
    },
  ],
  [
    "missing Tool start",
    (e) => {
      const row = firstStart(e);
      e.runs[0].events.items = e.runs[0].events.items.filter(
        (item) => item !== row,
      );
    },
  ],
  [
    "missing Tool terminal",
    (e) => {
      const row = firstTerminal(e);
      e.runs[0].events.items = e.runs[0].events.items.filter(
        (item) => item !== row,
      );
    },
  ],
  [
    "terminal attributed to another call",
    (e) => {
      firstTerminal(e).payload.toolCallId = "foreign-call";
    },
  ],
  [
    "wrong Tool model name",
    (e) => {
      firstStart(e).payload.modelName = "bash";
    },
  ],
  [
    "unexpected Tool terminal failure",
    (e) => {
      firstTerminal(e).payload.status = "failed";
    },
  ],
  [
    "unexpected Tool cancellation",
    (e) => {
      firstTerminal(e).payload.status = "cancelled";
    },
  ],
  [
    "expected ordinary failure lost",
    (e) => {
      e.runs[1].events.items.find(
        ({ payload }) =>
          payload.toolCallId === toolIdentity(e.runs[1].run, 0) &&
          payload.initial === false,
      ).payload.status = "completed";
    },
  ],
  [
    "terminal is still running",
    (e) => {
      firstTerminal(e).payload.status = "in_progress";
    },
  ],
  [
    "Tool arguments changed in persistence",
    (e) => {
      firstStart(e).payload.arguments.path = "foreign.txt";
    },
  ],
  [
    "Tool result changed in persistence",
    (e) => {
      firstTerminal(e).payload.content[0].text = "different effect";
    },
  ],
  ["missing model request", (e) => e.model.requests.pop()],
  [
    "extra model request",
    (e) => e.model.requests.push(clone(e.model.requests[0])),
  ],
  [
    "duplicate model phase step",
    (e) => {
      e.model.requests[1] = clone(e.model.requests[0]);
    },
  ],
  [
    "foreign model phase",
    (e) => {
      e.model.requests[0].phase = "foreign";
    },
  ],
  [
    "unvalidated model request",
    (e) => {
      e.model.requests[0].outcome = "rejected";
    },
  ],
  ["model business error", (e) => e.model.errors.push("barrier_disconnected")],
  [
    "model response still held",
    (e) => {
      e.model.held = { phase: "managed-draining", step: 2 };
    },
  ],
  [
    "live Tool absent",
    (e) => {
      e.original = e.original.filter(
        ({ update }) =>
          !(
            update.toolCallId === toolIdentity(e.runs[0].run, 0) &&
            update.status === "completed"
          ),
      );
    },
  ],
  [
    "foreign live Session",
    (e) => {
      e.original[0].sessionId = "foreign";
    },
  ],
  [
    "live Tool result changed",
    (e) => {
      e.original.find(
        ({ update }) =>
          update.toolCallId === toolIdentity(e.runs[0].run, 0) &&
          update.status === "completed",
      ).update.content[0].content.text = "changed";
    },
  ],
  [
    "replay Tool absent",
    (e) => {
      e.replayed = e.replayed.filter(
        ({ update }) => update.toolCallId !== toolIdentity(e.runs[0].run, 0),
      );
    },
  ],
  [
    "replay Tool duplicated",
    (e) => {
      e.replayed.push(
        clone(e.replayed.find(({ update }) => update.status === "completed")),
      );
    },
  ],
  [
    "foreign replay Session",
    (e) => {
      e.replayed[0].sessionId = "foreign";
    },
  ],
  [
    "replay result changed",
    (e) => {
      e.replayed.find(
        ({ update }) =>
          update.toolCallId === toolIdentity(e.runs[0].run, 0) &&
          update.status === "completed",
      ).update.content[0].content.text = "changed";
    },
  ],
  [
    "live and replay agree on a result different from persistence",
    (e) => {
      for (const rows of [e.original, e.replayed])
        rows.find(
          ({ update }) =>
            update.toolCallId === toolIdentity(e.runs[0].run, 0) &&
            update.status === "completed",
        ).update.content[0].content.text = "same fabricated result";
    },
  ],
  [
    "raw read error cannot be a passed summary",
    (e) => e.errors.push(new Error("audit unavailable")),
  ],
];

for (const version of [1, 2])
  for (const [label, mutate] of invalidCases)
    test(`v${version}: rejects ${label}`, () => {
      const inspect = inspector();
      const evidence = fixture(version);
      mutate(evidence);
      assert.throws(() => inspect(evidence));
    });

for (const version of [1, 2]) {
  test(`v${version}: coherent Tool receipts still reject bare, foreign-Run or foreign-Provider identities`, () => {
    const inspect = inspector();
    for (const variant of ["bare", "foreign-run", "foreign-provider"]) {
      const evidence = fixture(version);
      let text = JSON.stringify(evidence);
      for (const [index, [phase, names]] of plans.entries()) {
        const run = evidence.runs[index].run;
        for (const step of names.keys()) {
          const providerId = `${phase}-${step}`;
          const original = toolIdentity(run, step, providerId);
          const replacement =
            variant === "bare"
              ? providerId
              : toolIdentity(
                  variant === "foreign-run"
                    ? { ...run, run_id: "foreign-run" }
                    : run,
                  step,
                  variant === "foreign-provider"
                    ? "foreign-provider-call"
                    : providerId,
                );
          // Change the proposal, durable lifecycle and original/replay wire
          // together, so only the binding to the actual Run/model can reject it.
          text = text.replaceAll(original, replacement);
        }
      }
      assert.throws(() => inspect(JSON.parse(text)));
    }
  });
  test(`v${version}: additional durable Tool cannot hide behind correct model totals`, () => {
    const inspect = inspector();
    const evidence = fixture(version);
    const start = clone(firstStart(evidence));
    const terminal = clone(firstTerminal(evidence));
    const rows = evidence.runs[0].events.items;
    let sequence = rows.at(-1).sequence;
    for (const [index, row] of [start, terminal].entries()) {
      row.id = `extra-event-${index}`;
      row.sequence = ++sequence;
      row.payload.toolCallId = "extra-actual-tool";
      rows.push(row);
    }
    assert.throws(() => inspect(evidence));
  });
  test(`v${version}: duplicate starts and terminal receipts with fresh event IDs are rejected`, () => {
    const inspect = inspector();
    for (const pick of [firstStart, firstTerminal]) {
      const evidence = fixture(version);
      const rows = evidence.runs[0].events.items;
      const duplicate = clone(pick(evidence));
      duplicate.id = "fresh-duplicate-event";
      duplicate.sequence = rows.at(-1).sequence + 1;
      rows.push(duplicate);
      assert.throws(() => inspect(evidence));
    }
  });
}

for (const version of [1, 2])
  test(`v${version}: collector preserves all thirteen raw audit responses before returning`, async () => {
    const collect = collector();
    const evidence = fixture(version);
    const visits = [];
    const signal = new AbortController().signal;
    const archived = [];
    const result = await collect(inputOf(evidence), {
      signal,
      readJSON: readFixture(evidence, visits),
      async preserve(value) {
        archived.push(clone(value));
      },
    });
    assert.equal(visits.length, 13);
    assert(visits.every((row) => row.signal === signal));
    assert.equal(new Set(visits.map(({ path }) => path)).size, 13);
    assert.equal(archived.length, 1);
    assert.deepEqual(result.summary, expectedSummary);
    assert.deepEqual(result.evidence, archived[0]);
    assert.deepEqual(result.evidence.auditList, evidence.auditList);
    assert.deepEqual(
      result.evidence.runs.toSorted((a, b) =>
        a.run.run_id.localeCompare(b.run.run_id),
      ),
      evidence.runs.toSorted((a, b) =>
        a.run.run_id.localeCompare(b.run.run_id),
      ),
    );
    assert.deepEqual(result.evidence.errors, []);
  });

test("collector requires a real archive callback before starting reads", async () => {
  const collect = collector();
  let reads = 0;
  await assert.rejects(
    collect(inputOf(fixture()), {
      readJSON() {
        reads++;
        throw new Error("archive guard missing");
      },
    }),
  );
  assert.equal(reads, 0);
});

test("partial audit reading retains original failure and every already received raw record", async () => {
  const collect = collector();
  const evidence = fixture();
  const original = new Error("PRIVATE_READ_FAILURE");
  const read = readFixture(evidence);
  const received = [];
  let eventReads = 0;
  let archived;
  await assert.rejects(
    collect(inputOf(evidence), {
      async readJSON(path, options) {
        if (
          new URL(path, "http://fixture").pathname.endsWith("/events") &&
          ++eventReads === 2
        )
          throw original;
        const value = await read(path, options);
        received.push({ path, value: clone(value) });
        return value;
      },
      async preserve(value) {
        archived = value;
      },
    }),
    (error) => {
      assert(
        flatten(error).includes(original),
        "original read error was replaced",
      );
      return true;
    },
  );
  assert.deepEqual(archived.auditList, evidence.auditList);
  assert(archived.errors.some((error) => flatten(error).includes(original)));
  for (const { path, value } of received) {
    const url = new URL(path, "http://fixture");
    const match = url.pathname.match(
      /\/execution-audits\/([^/]+)(\/events)?$/u,
    );
    if (!match) continue;
    const record = archived.runs.find(({ run }) => run?.run_id === match[1]);
    assert(record, "received Run detail was not archived");
    assert.deepEqual(match[2] ? record.events : record.run, value);
  }
  assert(
    archived.runs.some(({ run, events }) => run && events),
    "complete partial Run evidence lost",
  );
});

test("a list read error and archive error retain both original Error identities", async () => {
  const collect = collector();
  const readError = new Error("PRIVATE_LIST_READ_FAILURE");
  const archiveError = new Error("PRIVATE_ARCHIVE_FAILURE");
  let archived;
  await assert.rejects(
    collect(inputOf(fixture()), {
      async readJSON() {
        throw readError;
      },
      async preserve(value) {
        archived = value;
        throw archiveError;
      },
    }),
    (error) => {
      assert.deepEqual(
        new Set(flatten(error)),
        new Set([readError, archiveError]),
      );
      return true;
    },
  );
  assert(archived.errors.includes(readError));
  assert.deepEqual(archived.runs, []);
});

test("archive failure after complete reads blocks collection instead of returning a business receipt", async () => {
  const collect = collector();
  const evidence = fixture();
  const original = new Error("PRIVATE_COMPLETE_ARCHIVE_FAILURE");
  await assert.rejects(
    collect(inputOf(evidence), {
      readJSON: readFixture(evidence),
      async preserve(value) {
        assert.equal(value.runs.length, 6);
        throw original;
      },
    }),
    (error) => error === original,
  );
});

test(
  "collector actually awaits its archive before resolving",
  { timeout: 5000 },
  async () => {
    const collect = collector();
    const evidence = fixture();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let settled = false;
    const task = collect(inputOf(evidence), {
      readJSON: readFixture(evidence),
      async preserve() {
        entered.resolve();
        await release.promise;
      },
    });
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await withCleanup(
      async () => {
        await within(entered.promise);
        await Promise.resolve();
        assert.equal(settled, false);
        release.resolve();
        assert.deepEqual((await within(task)).summary, expectedSummary);
      },
      async () => {
        release.resolve();
        await within(Promise.allSettled([task]));
      },
    );
  },
);

test(
  "abort joins an already started read and then the partial archive before rejecting",
  { timeout: 5000 },
  async () => {
    const collect = collector();
    const evidence = fixture();
    const read = readFixture(evidence);
    const abort = new AbortController();
    const original = new Error("Managed collection parent stopped");
    const readEntered = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    const archiveEntered = Promise.withResolvers();
    const releaseArchive = Promise.withResolvers();
    let held = false;
    let heldRunId;
    let readFinished = false;
    let settled = false;
    let archived;
    const task = collect(inputOf(evidence), {
      signal: abort.signal,
      async readJSON(path, options) {
        const value = await read(path, options);
        if (
          !held &&
          new URL(path, "http://fixture").pathname.endsWith("/events")
        ) {
          held = true;
          heldRunId = new URL(path, "http://fixture").pathname
            .split("/")
            .at(-2);
          readEntered.resolve();
          await releaseRead.promise;
          readFinished = true;
        }
        return value;
      },
      async preserve(value) {
        assert.equal(
          readFinished,
          true,
          "archive began before the outstanding read settled",
        );
        archived = value;
        archiveEntered.resolve();
        await releaseArchive.promise;
      },
    });
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await withCleanup(
      async () => {
        await within(readEntered.promise);
        abort.abort(original);
        await Promise.resolve();
        assert.equal(settled, false, "abort abandoned an in-flight read");
        releaseRead.resolve();
        await within(archiveEntered.promise);
        assert.equal(settled, false, "abort abandoned its partial archive");
        releaseArchive.resolve();
        await assert.rejects(within(task), (error) => {
          assert(
            flatten(error).includes(original),
            "abort reason was replaced",
          );
          return true;
        });
        assert.deepEqual(archived.auditList, evidence.auditList);
        assert.deepEqual(
          archived.runs.find(({ run }) => run?.run_id === heldRunId)?.events,
          evidence.runs.find(({ run }) => run.run_id === heldRunId).events,
          "the response received while cancelling was not archived",
        );
        assert(
          archived.errors.some((error) => flatten(error).includes(original)),
        );
      },
      async () => {
        abort.abort(original);
        releaseRead.resolve();
        releaseArchive.resolve();
        await within(Promise.allSettled([task]));
      },
    );
  },
);

for (const stage of ["list", "events"])
  test(`collector archives and rejects incomplete ${stage} pagination`, async () => {
    const collect = collector();
    const evidence = fixture();
    if (stage === "list") evidence.auditList.next_cursor = "more-runs";
    else evidence.runs[0].events.next_cursor = "more-events";
    let archived;
    await assert.rejects(
      collect(inputOf(evidence), {
        readJSON: readFixture(evidence),
        async preserve(value) {
          archived = value;
        },
      }),
    );
    assert(archived, "incomplete raw page was not preserved");
    if (stage === "list")
      assert.equal(archived.auditList.next_cursor, "more-runs");
    else
      assert(
        archived.runs.some(
          ({ events }) => events?.next_cursor === "more-events",
        ),
      );
  });
