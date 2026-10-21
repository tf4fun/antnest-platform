import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  assertAdmissionError,
  assertErrorCapability,
} from "../../support/acp-errors.mjs";
import { replayRequest } from "../managed-mcp/protocol.mjs";

const plans = [
  { version: 1, kind: "apply" },
  { version: 1, kind: "settle" },
  { version: 2, kind: "apply" },
  { version: 2, kind: "settle" },
];
const roles = ["prompt", "replay-1", "replay-2"];
const summaryFields = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const metadata = new Set([
  "available_commands_update",
  "session_info_update",
  "config_option_update",
  "current_mode_update",
]);
const eventKinds = new Set([
  "user_message",
  "agent_message",
  "agent_thought",
  "tool_call",
  "usage",
  "state",
  "environment_change",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value, message) =>
  assert(typeof value === "string" && value.trim().length > 0, message);
const same = (actual, expected, message) =>
  assert(isDeepStrictEqual(actual, expected), message);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const summary = (run) =>
  Object.fromEntries(summaryFields.map((field) => [field, run[field]]));

function safeCheck(check, message) {
  try {
    check();
  } catch {
    throw new Error(message);
  }
}

function completePage(page, message) {
  assert(object(page) && Array.isArray(page.items), message);
  assert(page.items.length <= 100 && page.next_cursor === null, message);
}

function models(rows) {
  assert(Array.isArray(rows), "Original RPC model request inventory required");
  return rows.map((row) => {
    assert(object(row), "Original RPC model receipt required");
    nonempty(row.phase, "Original RPC model phase required");
    assert(["tool", "reply"].includes(row.stage), "Unexpected RPC model stage");
    return [row.phase, row.stage];
  });
}

function response(connection, row) {
  const frames = connection.raw_frames.filter(
    (frame) =>
      object(frame) &&
      Object.hasOwn(frame, "id") &&
      String(frame.id) === row.requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
  assert(frames.length === 1, "One original RPC response required");
  return frames[0];
}

function inspectConnections(input) {
  assert(
    Array.isArray(input.connections) && input.connections.length === 12,
    "Twelve original RPC connections required",
  );
  const connections = new Map();
  let requests = 0;
  for (const connection of input.connections) {
    assert(object(connection), "Original RPC connection required");
    assert(
      plans.some(
        (plan) =>
          plan.version === connection.version && plan.kind === connection.kind,
      ),
      "Foreign RPC scenario connection",
    );
    assert(roles.includes(connection.role), "Foreign RPC connection role");
    const key = `${connection.version}:${connection.kind}:${connection.role}`;
    assert(!connections.has(key), "Duplicate original RPC connection");
    connections.set(key, connection);
    same(connection.agentId, input.agentId, "Foreign RPC connection Agent");
    assert(connection.closed === true, "RPC connection has not joined");
    same(connection.evidence_errors, [], "RPC evidence or archive failed");
    assert(
      Array.isArray(connection.evidence) &&
        Array.isArray(connection.requests) &&
        Array.isArray(connection.raw_frames),
      "Original RPC wire inventory required",
    );
    const rows = [connection.initialization, ...connection.evidence];
    const ids = new Set();
    for (const row of rows) {
      assert(object(row), "Original RPC request receipt required");
      nonempty(row.requestId, "Original RPC request ID required");
      assert(
        !ids.has(row.requestId),
        "Duplicate RPC request ID on one connection",
      );
      ids.add(row.requestId);
      same(
        [row.boundary, row.transport, row.protocolVersion, row.agentId],
        ["private-acp", "websocket", connection.version, input.agentId],
        "Foreign RPC request scope",
      );
      assert(
        row.closedBeforeResponse === undefined,
        "RPC request borrowed a close exception",
      );
      const raw = response(connection, row);
      if (row.outcome === "succeeded") {
        assert(
          Object.hasOwn(raw, "result") &&
            !Object.hasOwn(raw, "error") &&
            object(raw.result),
          "Successful RPC response missing or conflicting",
        );
        assert(
          row.failure === undefined,
          "Successful RPC request retained a failure",
        );
      } else {
        assert(
          row.outcome === "failed" &&
            Object.hasOwn(raw, "error") &&
            !Object.hasOwn(raw, "result"),
          "Failed RPC response missing or conflicting",
        );
        nonempty(row.failure, "Original RPC rejection required");
        assert(
          row.requestResult === undefined,
          "Rejected RPC request acquired a result",
        );
      }
    }
    same(
      connection.requests.map((row) => [
        row.method,
        row.requestId,
        row.sessionId ?? null,
      ]),
      rows.map((row) => [row.method, row.requestId, row.inputSessionID]),
      "RPC wire requests differ from original receipts",
    );
    const initialized = connection.initialization;
    assert(
      initialized.method === "initialize" &&
        initialized.outcome === "succeeded" &&
        initialized.inputSessionID === null &&
        initialized.sessionId === undefined,
      "Original RPC initialization changed",
    );
    same(
      initialized.initializationResult?.protocolVersion,
      connection.version,
      "RPC SDK initialization version changed",
    );
    same(
      response(connection, initialized).result.protocolVersion,
      connection.version,
      "RPC wire initialization version changed",
    );
    safeCheck(() => {
      assertErrorCapability(initialized.initializationResult);
      assertErrorCapability(response(connection, initialized).result);
    }, "Original RPC errors capability required");
    requests += connection.evidence.length;
  }
  assert(requests === 22, "Twenty-two original RPC business requests required");
  return { connections, requests };
}

function inspectCalls(context, scenario) {
  const label = `v${scenario.version}-${scenario.kind}`;
  const group = roles.map((role) =>
    context.connections.get(`${scenario.version}:${scenario.kind}:${role}`),
  );
  assert(group.every(Boolean), "RPC scenario connection missing");
  const replay = replayRequest(scenario.version, scenario.sessionId);
  const prompt = (step) => ({
    sessionId: scenario.sessionId,
    prompt: [{ type: "text", text: label + "-" + step }],
  });
  const calls = [
    [
      ["new", { cwd: "/workspace", mcpServers: [] }],
      ["prompt", prompt("write")],
      ...(scenario.kind === "settle"
        ? [["prompt", prompt("denied"), true]]
        : []),
    ],
    [[replay.method, replay.params]],
    [
      [replay.method, replay.params],
      ["prompt", prompt("read")],
    ],
  ];
  for (const [index, connection] of group.entries()) {
    assert(
      connection.evidence.length === calls[index].length,
      "RPC scenario request inventory changed",
    );
    for (const [position, [method, params, rejected]] of calls[
      index
    ].entries()) {
      const row = connection.evidence[position];
      same(
        [row.method, row.inputSessionID, row.sessionId],
        ["session/" + method, params.sessionId ?? null, scenario.sessionId],
        "RPC request method or Session changed",
      );
      same(row.requestParams, params, "RPC request changed its original input");
      assert(
        row.outcome === (rejected ? "failed" : "succeeded"),
        "RPC request outcome changed",
      );
      const raw = response(connection, row);
      if (rejected) {
        safeCheck(
          () => assertAdmissionError(raw.error, "agent_unavailable"),
          "Noncanonical RPC closed-admission error",
        );
        same(
          row.failureCode,
          raw.error.code,
          "RPC rejection numeric receipt changed",
        );
        same(
          row.failureData,
          raw.error.data,
          "RPC rejection data receipt changed",
        );
        same(
          row.rejectionReceipt,
          {
            rpcCode: raw.error.code,
            code: "agent_unavailable",
            retryable: raw.error.data.retryable,
          },
          "RPC rejection receipt changed",
        );
      } else {
        assert(object(row.requestResult), "Original RPC SDK result required");
        if (method === "new")
          same(
            [row.requestResult.sessionId, raw.result.sessionId],
            [scenario.sessionId, scenario.sessionId],
            "New RPC Session identity changed",
          );
        if (method === "prompt") {
          if (scenario.version === 1)
            same(
              [row.requestResult.stopReason, raw.result.stopReason],
              ["end_turn", "end_turn"],
              "RPC v1 prompt did not finish",
            );
          else {
            nonempty(
              row.requestResult.messageId,
              "Original RPC v2 ACK required",
            );
            same(
              raw.result.messageId,
              row.requestResult.messageId,
              "RPC v2 ACK changed after receipt",
            );
          }
        }
      }
    }
  }
  return {
    group,
    write: group[0].evidence[1],
    read: group[2].evidence[1],
    denied: scenario.kind === "settle" ? group[0].evidence[2] : undefined,
  };
}

function inspectEvents(saved, phase, state, sessionSequences) {
  const { run, events } = saved;
  completePage(events, "Complete RPC execution event page required");
  assert(events.stream === "execution", "RPC execution event stream changed");
  let previous = 0;
  for (const event of events.items) {
    assert(object(event), "Original RPC execution event required");
    nonempty(event.id, "RPC execution event identity required");
    assert(!state.events.has(event.id), "Duplicate durable RPC event identity");
    state.events.add(event.id);
    assert(
      positive(event.sequence) &&
        event.sequence > previous &&
        !sessionSequences.has(event.sequence),
      "Duplicate or unordered RPC Session event sequence",
    );
    sessionSequences.add(event.sequence);
    previous = event.sequence;
    assert(
      typeof event.visible === "boolean" && date(event.created_at),
      "Invalid RPC event visibility or timestamp",
    );
    assert(
      eventKinds.has(event.kind) &&
        object(event.payload) &&
        event.payload.kind === event.kind,
      "Invalid durable RPC event kind",
    );
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      same(
        event.payload.messageId,
        event.id,
        "Durable RPC message identity changed",
      );
      assert(
        Array.isArray(event.payload.content),
        "Durable RPC message content required",
      );
      if (event.kind === "agent_message")
        assert(
          event.visible === event.payload.content.length > 0,
          "Durable RPC assistant visibility changed",
        );
    }
    if (event.kind === "environment_change")
      assert(
        event.visible === false,
        "RPC environment fact became public history",
      );
  }
  const users = events.items.filter((event) => event.kind === "user_message");
  assert(
    users.length === 1 && users[0].visible,
    "One durable RPC user message required",
  );
  same(users[0].payload.content, run.input, "Durable RPC user input changed");
  const tools = events.items.filter((event) => event.kind === "tool_call");
  assert(tools.length >= 2, "Durable RPC Tool start and completion required");
  const first = tools[0].payload;
  const last = tools.at(-1).payload;
  same(
    first.toolCallId,
    createHash("sha256")
      .update(JSON.stringify([run.run_id, 0, phase + "-tool"]))
      .digest("hex"),
    "RPC Tool differs from its original model call",
  );
  assert(!state.tools.has(first.toolCallId), "Duplicate RPC Tool identity");
  state.tools.add(first.toolCallId);
  assert(
    first.modelName === "bash" && object(first.arguments),
    "Original RPC Bash request required",
  );
  for (const [index, event] of tools.entries()) {
    same(
      event.payload.toolCallId,
      first.toolCallId,
      "RPC Tool lifecycle changed identity",
    );
    assert(
      event.visible === true && event.payload.initial === (index === 0),
      "RPC Tool start missing or repeated",
    );
    assert(
      event.payload.status ===
        (index === tools.length - 1 ? "completed" : "in_progress"),
      "RPC Tool progress or completion changed",
    );
    if (event.payload.content !== undefined)
      assert(
        Array.isArray(event.payload.content),
        "RPC Tool content must be an array",
      );
  }
  assert(
    Array.isArray(last.content) && last.content.length > 0,
    "RPC Tool result required",
  );
  let result;
  safeCheck(() => {
    const text = last.content
      .map((block) => {
        assert(
          object(block) &&
            block.type === "text" &&
            typeof block.text === "string",
        );
        return block.text;
      })
      .join("");
    result = JSON.parse(text);
  }, "Invalid durable RPC Bash result");
  same(
    [
      result?.exit_code,
      result?.stdout,
      result?.stderr,
      result?.truncated,
      result?.effect_state,
    ],
    [0, phase.replace(/-(write|read)$/u, "") + "\n", "", false, "settled"],
    "RPC Tool did not preserve its single physical marker",
  );
  const dispatches = events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => {
      assert(
        event.payload.toolCalls === undefined ||
          Array.isArray(event.payload.toolCalls),
        "Invalid durable RPC model dispatch",
      );
      return (event.payload.toolCalls ?? []).map((call) => ({
        call,
        sequence: event.sequence,
      }));
    });
  assert(
    dispatches.length === 1,
    "One original RPC model Tool dispatch required",
  );
  same(
    dispatches[0].call,
    { id: first.toolCallId, name: first.modelName, arguments: first.arguments },
    "RPC model dispatch differs from durable Tool",
  );
  assert(
    users[0].sequence < tools[0].sequence &&
      dispatches[0].sequence < tools[0].sequence,
    "RPC Tool preceded original input or model dispatch",
  );
  const replies = events.items.filter(
    (event) => event.kind === "agent_message" && event.visible,
  );
  assert(
    replies.length > 0 && replies[0].sequence > tools.at(-1).sequence,
    "RPC final answer preceded Tool completion",
  );
  const reply = replies
    .flatMap((event) => event.payload.content)
    .map((block) => {
      assert(
        object(block) &&
          block.type === "text" &&
          typeof block.text === "string",
        "Original RPC text reply required",
      );
      return block.text;
    })
    .join("");
  same(reply, phase + " verified", "RPC final answer changed");
  const usage = events.items.filter((event) => event.kind === "usage");
  assert(usage.length === 2, "Two durable RPC model usage receipts required");
  for (const event of usage)
    assert(
      event.visible &&
        object(event.payload.measurement) &&
        Number.isFinite(event.payload.used) &&
        event.payload.used >= 0 &&
        Number.isFinite(event.payload.size) &&
        event.payload.size > 0,
      "Invalid durable RPC usage receipt",
    );
  same(
    run.usage_measurements,
    usage.map((event) => event.payload.measurement),
    "RPC Run usage differs from its durable events",
  );
  return users[0].id;
}

function inspectAudits(input, scenario, calls, state) {
  completePage(scenario.auditPage, "Complete RPC Run list required");
  assert(
    scenario.auditPage.items.length === 2 &&
      Array.isArray(scenario.runs) &&
      scenario.runs.length === 2,
    "Two complete RPC Runs per scenario required",
  );
  const listed = new Map();
  for (const row of scenario.auditPage.items) {
    assert(object(row), "Original RPC Run summary required");
    for (const field of summaryFields)
      nonempty(row[field], "Complete RPC Run summary required");
    same(
      [row.agent_id, row.principal_id, row.session_id],
      [input.agentId, input.principalId, scenario.sessionId],
      "Foreign RPC audit scope",
    );
    assert(!listed.has(row.run_id), "Duplicate listed RPC Run");
    listed.set(row.run_id, row);
  }
  const byStep = new Map();
  const sessionSequences = new Set();
  for (const saved of scenario.runs) {
    assert(object(saved?.run), "Original RPC Run detail required");
    const run = saved.run;
    assert(
      !state.runs.has(run.run_id) && listed.has(run.run_id),
      "Duplicate or unlisted RPC Run",
    );
    state.runs.add(run.run_id);
    same(
      summary(run),
      listed.get(run.run_id),
      "RPC Run detail changed its original summary",
    );
    assert(
      date(run.created_at) && date(run.updated_at),
      "RPC Run timestamps required",
    );
    assert(
      run.state === "completed" &&
        run.terminal_class === "completed" &&
        run.executor_state === "quiescent" &&
        run.tool_effect_state === "settled" &&
        run.stop_reason === "end_turn" &&
        run.error_class === null,
      "RPC Run is not durably completed and settled",
    );
    assert(
      run.unknown_effect_source === null ||
        run.unknown_effect_source === undefined,
      "Unknown RPC Tool effects remain",
    );
    const step = ["write", "read"].find((value) =>
      isDeepStrictEqual(run.input, [
        {
          type: "text",
          text: `v${scenario.version}-${scenario.kind}-${value}`,
        },
      ]),
    );
    assert(
      step && !byStep.has(step),
      "RPC Run is not bound to one original prompt",
    );
    const snapshot = run.execution_snapshot;
    assert(
      object(snapshot) && object(snapshot.runtime),
      "Original RPC execution snapshot required",
    );
    same(
      snapshot.organizationId,
      input.organizationId,
      "Foreign RPC execution organization",
    );
    for (const field of [
      "providerConnectionId",
      "modelProfileId",
      "accessRevision",
      "agentSpecRevision",
      "executionRevision",
      "clientMcpRevisionId",
    ])
      nonempty(
        snapshot[field],
        "Complete original RPC execution authority required",
      );
    assert(
      positive(snapshot.configurationRevision) && date(snapshot.deadlineAt),
      "Original RPC execution boundary required",
    );
    for (const field of [
      "revision",
      "executionId",
      "mcpEndpoint",
      "connectionId",
    ])
      nonempty(
        snapshot.runtime[field],
        "Original RPC Runtime binding required",
      );
    const userId = inspectEvents(
      saved,
      `v${scenario.version}-${scenario.kind}-${step}`,
      state,
      sessionSequences,
    );
    const request = calls[step];
    same(
      request.requestParams.prompt,
      run.input,
      "RPC Run input differs from SDK request",
    );
    if (scenario.version === 2)
      same(
        request.requestResult.messageId,
        userId,
        "RPC Run differs from original v2 input ACK",
      );
    byStep.set(step, saved);
  }
  assert(byStep.size === 2, "Both RPC write and read executions required");
  return byStep;
}

function inspectReplacement(input, scenario, byStep) {
  if (scenario.kind !== "settle") return;
  const replacement = scenario.replacement;
  assert(object(replacement), "Actual replacement Runtime receipt required");
  same(
    replacement.agent_id,
    input.agentId,
    "Foreign replacement Runtime Agent",
  );
  const old = byStep.get("write").run.execution_snapshot;
  const current = byStep.get("read").run.execution_snapshot;
  same(
    [
      current.runtime.revision,
      current.runtime.executionId,
      current.runtime.mcpEndpoint,
      current.executionRevision,
    ],
    [
      replacement.runtime_revision,
      replacement.runtime_execution_id,
      replacement.mcp_endpoint,
      replacement.execution_revision,
    ],
    "RPC read Run did not capture actual replacement Runtime",
  );
  assert(
    current.runtime.revision !== old.runtime.revision &&
      current.runtime.executionId !== old.runtime.executionId &&
      current.executionRevision !== old.executionRevision,
    "RPC Rebuild retained old executable authority",
  );
}

function inspectFault(input, scenario) {
  const fault = scenario.fault;
  assert(
    object(fault) && object(fault.held) && Array.isArray(fault.records),
    "Original proxy loss receipts required",
  );
  const held = fault.held;
  assert(
    held.delivery === "held" &&
      held.status === 200 &&
      positive(held.applied_revision),
    "Proxy did not hold an applied success",
  );
  same(
    held.organization_id,
    input.organizationId,
    "Foreign proxy receipt organization",
  );
  assert(
    held.method ===
      (scenario.kind === "apply" ? "apply-execution-snapshot" : "settle-agent"),
    "Proxy receipt belongs to another RPC method",
  );
  for (const key of ["request_hash", "response_hash"])
    assert(
      typeof held[key] === "string" && /^[a-f0-9]{64}$/u.test(held[key]),
      "Canonical proxy business hashes required",
    );
  if (scenario.kind === "apply")
    assert(
      positive(held.revision) && held.applied_revision >= held.revision,
      "Proxy publication revision was not applied",
    );
  else {
    same(held.agent_id, input.agentId, "Foreign proxy settlement Agent");
    nonempty(held.operation_id, "Original proxy settlement operation required");
    assert(
      positive(held.minimum_revision) &&
        held.applied_revision >= held.minimum_revision &&
        held.mode === "wait" &&
        date(held.deadline_at) &&
        held.outcome === "settled",
      "Original settled RPC boundary required",
    );
    same(
      [
        fault.lifecycle?.kind,
        fault.lifecycle?.agentId,
        fault.lifecycle?.requestId,
      ],
      ["rebuild", input.agentId, held.operation_id],
      "Proxy settlement differs from actual Rebuild admission",
    );
  }
  assert(
    fault.records.length >= 2 && fault.records.length <= 512,
    "Delivered RPC retry missing",
  );
  same(
    fault.records[0].receipt_id,
    held.receipt_id,
    "Proxy lost a different held receipt",
  );
  const ids = new Set();
  for (const [index, record] of fault.records.entries()) {
    nonempty(record.receipt_id, "Original proxy HTTP attempt ID required");
    assert(!ids.has(record.receipt_id), "Proxy counted an HTTP receipt twice");
    ids.add(record.receipt_id);
    assert(
      record.delivery === (index === 0 ? "dropped" : "delivered"),
      "Proxy loss or retry delivery was not observed",
    );
    for (const key of [
      "method",
      "organization_id",
      "revision",
      "minimum_revision",
      "applied_revision",
      "agent_id",
      "operation_id",
      "mode",
      "deadline_at",
      "outcome",
      "request_hash",
      "response_hash",
      "status",
    ])
      same(
        record[key],
        held[key],
        "Proxy retry changed the original business receipt",
      );
  }
}

function inspectCheckpoints(input, scenario, calls, byStep, index) {
  const saved = byStep.get("write");
  const expected = {
    rows: [summary(saved.run)],
    run: saved.run,
    events: saved.events,
  };
  const expectedModels = input.model.requests.slice(0, index * 4 + 2);
  assert(object(scenario.replay), "Original replay checkpoints required");
  for (const checkpoint of [scenario.replay.before, scenario.replay.after]) {
    assert(object(checkpoint), "Original replay checkpoint required");
    same(
      checkpoint.execution,
      expected,
      "Replay changed or borrowed durable RPC execution",
    );
    same(
      checkpoint.modelRequests,
      expectedModels,
      "Replay executed or changed Provider requests",
    );
  }
  if (scenario.kind !== "settle") return;
  assert(
    object(scenario.denial),
    "Original closed-admission checkpoints required",
  );
  same(
    scenario.denial.requestId,
    calls.denied.requestId,
    "Closed-admission checkpoint changed original request",
  );
  for (const checkpoint of [scenario.denial.before, scenario.denial.after]) {
    assert(object(checkpoint), "Original closed-admission checkpoint required");
    same(
      checkpoint.execution,
      expected,
      "Closed admission changed or borrowed durable RPC execution",
    );
    same(
      checkpoint.modelRequests,
      expectedModels,
      "Closed admission executed or changed Provider requests",
    );
    same(
      checkpoint.updates,
      calls.group[0].updates,
      "Closed admission emitted or changed execution notifications",
    );
  }
}

function messageUpdates(payload, version) {
  return (version === 1 ? payload.content : [payload.content]).map(
    (content) => ({
      sessionUpdate: payload.kind + (version === 1 ? "_chunk" : ""),
      messageId:
        version === 1
          ? (payload.responseId ?? payload.messageId)
          : payload.messageId,
      content,
    }),
  );
}

function projected(saved, version, replay = false) {
  return saved.events.items
    .filter((event) => event.visible)
    .flatMap(({ payload }) => {
      if (payload.kind === "state") return [];
      if (
        ["user_message", "agent_message", "agent_thought"].includes(
          payload.kind,
        )
      ) {
        if (payload.kind === "user_message" && version === 1 && !replay)
          return [];
        return messageUpdates(payload, version);
      }
      if (payload.kind === "usage")
        return [
          {
            sessionUpdate: "usage_update",
            used: payload.used,
            size: payload.size,
            ...(payload.cost === undefined ? {} : { cost: payload.cost }),
          },
        ];
      assert(
        payload.kind === "tool_call",
        "Unexpected visible RPC history event",
      );
      return [
        {
          sessionUpdate:
            version === 1 && payload.initial ? "tool_call" : "tool_call_update",
          toolCallId: payload.toolCallId,
          status: payload.status,
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.toolKind === undefined ? {} : { kind: payload.toolKind }),
          ...(payload.modelName === undefined
            ? {}
            : { name: payload.modelName }),
          ...(payload.arguments === undefined
            ? {}
            : { rawInput: payload.arguments }),
          ...(payload.rawOutput === undefined
            ? {}
            : { rawOutput: payload.rawOutput }),
          ...(payload.locations === undefined
            ? {}
            : { locations: payload.locations }),
          ...(payload.content === undefined
            ? {}
            : {
                content: payload.content.map((content) => ({
                  type: "content",
                  content,
                })),
              }),
        },
      ];
    })
    .map((update) => ({ sessionId: saved.run.session_id, update }));
}

function inspectNotifications(scenario, calls, byStep) {
  const actual = calls.group.map((connection) => {
    assert(
      Array.isArray(connection.updates),
      "Original RPC notifications required",
    );
    for (const frame of connection.updates)
      assert(
        object(frame) &&
          frame.sessionId === scenario.sessionId &&
          object(frame.update),
        "Foreign RPC notification",
      );
    return connection.updates.filter(
      ({ update }) =>
        !metadata.has(update.sessionUpdate) &&
        update.sessionUpdate !== "state_update",
    );
  });
  const write = byStep.get("write");
  const read = byStep.get("read");
  same(
    actual[0],
    projected(write, scenario.version),
    "Live RPC write notifications differ from durable events",
  );
  same(
    actual[1],
    projected(write, scenario.version, true),
    "RPC first replay changed original history",
  );
  same(
    actual[2],
    [
      ...projected(write, scenario.version, true),
      ...projected(read, scenario.version),
    ],
    "RPC second replay or new read changed original history",
  );
  for (const [index, connection] of calls.group.entries()) {
    const states = connection.updates
      .filter(({ update }) => update.sessionUpdate === "state_update")
      .map(({ update }) => update);
    if (scenario.version === 1)
      assert(states.length === 0, "RPC v1 acquired v2 state notifications");
    else {
      const observed =
        index === 0 && states[0]?.state === "idle" ? states.slice(1) : states;
      const expected =
        index === 0
          ? ["running", "idle"]
          : index === 1
            ? ["idle"]
            : ["idle", "running", "idle"];
      same(
        observed.map((update) => update.state),
        expected,
        "Original RPC v2 completion states missing or repeated",
      );
      assert(
        observed.at(-1).stopReason === "end_turn",
        "RPC v2 terminal stop reason changed",
      );
    }
  }
}

// This accepts only captured protocol/Admin/proxy facts. Runtime journals,
// acknowledgement blocking, actual deletion and outer resource cleanup retain
// their existing owning checks; these safe counts do not certify those gates.
export function inspectRpcLossBusinessEvidence(input) {
  assert(object(input), "Original RPC business evidence required");
  for (const key of ["agentId", "principalId", "organizationId"])
    nonempty(input[key], "Original RPC business authority required");
  const context = inspectConnections(input);
  assert(
    Array.isArray(input.scenarios) && input.scenarios.length === 4,
    "Four original RPC loss scenarios required",
  );
  same(
    input.scenarios.map(({ version, kind }) => ({ version, kind })),
    plans,
    "RPC loss scenario inventory changed",
  );
  assert(object(input.model), "Original RPC model status required");
  same(input.model.errors, [], "RPC model fixture rejected business requests");
  same(
    models(input.model.requests),
    plans.flatMap(({ version, kind }) =>
      ["write", "read"].flatMap((step) =>
        ["tool", "reply"].map((stage) => [
          `v${version}-${kind}-${step}`,
          stage,
        ]),
      ),
    ),
    "RPC model requests missing, repeated or reordered",
  );
  const state = { runs: new Set(), events: new Set(), tools: new Set() };
  const sessions = new Set();
  for (const [index, scenario] of input.scenarios.entries()) {
    nonempty(scenario.sessionId, "Original RPC scenario Session required");
    assert(!sessions.has(scenario.sessionId), "RPC scenarios reused a Session");
    sessions.add(scenario.sessionId);
    const calls = inspectCalls(context, scenario);
    const byStep = inspectAudits(input, scenario, calls, state);
    inspectReplacement(input, scenario, byStep);
    inspectFault(input, scenario);
    inspectCheckpoints(input, scenario, calls, byStep, index);
    inspectNotifications(scenario, calls, byStep);
  }
  assert(
    state.runs.size === 8 && state.tools.size === 8,
    "Eight complete RPC Runs and Tools required",
  );
  return {
    status: "passed",
    versions: [1, 2],
    fault_cases: input.scenarios.length,
    runs: state.runs.size,
    tool_calls: state.tools.size,
    model_requests: input.model.requests.length,
    replays: input.connections.filter(
      (connection) => connection.role !== "prompt",
    ).length,
    rejections: input.scenarios.filter((scenario) => scenario.kind === "settle")
      .length,
    connections: input.connections.length,
    initializations: context.connections.size,
    business_requests: context.requests,
  };
}
