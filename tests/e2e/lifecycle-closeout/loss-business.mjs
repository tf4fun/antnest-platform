import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  admissionErrorReceipt,
  assertAdmissionError,
  assertErrorCapability,
} from "../../support/acp-errors.mjs";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";

const modes = ["live", "cold"];
const summaryFields = [
  "run_id",
  "agent_id",
  "session_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const metadataUpdates = new Set([
  "available_commands_update",
  "session_info_update",
  "config_option_update",
  "current_mode_update",
]);
const historyUpdates = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "tool_call",
  "tool_call_update",
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
function requireFact(condition, message) {
  // Private DTOs, SDK failures and Tool output must not enter error messages.
  if (!condition) throw new Error(message);
}
const nonempty = (value, message) =>
  requireFact(typeof value === "string" && value.trim().length > 0, message);
const same = (actual, expected, message) =>
  requireFact(isDeepStrictEqual(actual, expected), message);
function safely(check, message) {
  try {
    check();
  } catch {
    throw new Error(message);
  }
}
function completePage(page, name) {
  requireFact(object(page) && Array.isArray(page.items), name + " required");
  requireFact(
    page.items.length <= 100 && page.next_cursor === null,
    name + " is incomplete",
  );
}
const summarize = (run) =>
  Object.fromEntries(summaryFields.map((field) => [field, run[field]]));
const phaseFor = (mode, moment) => `c5-${mode}-${moment}`;
function response(connection, row) {
  const found = connection.raw_frames.filter(
    (frame) =>
      object(frame) &&
      Object.hasOwn(frame, "id") &&
      String(frame.id) === row.requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
  requireFact(found.length === 1, "one original Loss SDK response required");
  return found[0];
}

function modelRows(rows) {
  requireFact(Array.isArray(rows), "original Loss model inventory required");
  return rows.map((row) => {
    requireFact(object(row), "original Loss model receipt required");
    nonempty(row.phase, "original Loss model phase required");
    requireFact(
      ["tool", "reply"].includes(row.stage),
      "unknown Loss model stage",
    );
    requireFact(
      Number.isFinite(row.received_at_ms) && row.received_at_ms > 0,
      "original Loss model receipt time required",
    );
    return {
      phase: row.phase,
      stage: row.stage,
      received_at_ms: row.received_at_ms,
    };
  });
}
function inspectModel(rows) {
  const result = modelRows(rows);
  same(
    result.map(({ phase, stage }) => [phase, stage]),
    modes.flatMap((mode) =>
      ["before", "after"].flatMap((moment) =>
        ["tool", "reply"].map((stage) => [phaseFor(mode, moment), stage]),
      ),
    ),
    "Loss model inventory is missing, repeated or out of order",
  );
  return result;
}

function inspectOwner(evidence) {
  requireFact(
    object(evidence?.principal),
    "original Loss owner principal required",
  );
  const principal = evidence.principal;
  nonempty(principal.organization_id, "original Loss organization required");
  nonempty(principal.user_id, "original Loss owner required");
  let creation;
  safely(() => {
    creation = JSON.parse(decodeURIComponent(evidence.creation_principal));
  }, "original Loss creation principal required");
  requireFact(
    Array.isArray(creation) && creation.length === 2,
    "original Loss creation principal required",
  );
  nonempty(creation[1], "original Loss administrator required");
  same(
    creation[0],
    principal.organization_id,
    "Loss owner and creation organizations differ",
  );
}
function inspectAgent(agent, principal) {
  nonempty(agent.id, "original Loss Agent required");
  nonempty(agent.session_id, "original Loss Session required");
  for (const state of [agent.initial, agent.replacement]) {
    requireFact(object(state?.agent), "original Loss ready Agent required");
    const row = state.agent;
    same(row.agent_id, agent.id, "foreign Loss ready Agent");
    same(
      row.organization_id,
      principal.organization_id,
      "foreign Loss ready organization",
    );
    same(row.owner_user_id, principal.user_id, "foreign Loss ready owner");
    for (const [field, expected] of Object.entries({
      desired_state: "enabled",
      lifecycle_state: "created",
      activation_state: "enabled",
      runtime_state: "available",
    }))
      same(
        row[field],
        expected,
        "Loss Agent was not ready for its original prompt",
      );
    for (const field of [
      "access_revision",
      "agent_spec_revision",
      "executable_execution_revision",
    ])
      nonempty(row[field], "original Loss Agent revision required");
    same(
      row.last_successful_execution_revision,
      row.executable_execution_revision,
      "Loss Agent executable revision differs from successful revision",
    );
    requireFact(object(row.runtime), "original Loss Runtime binding required");
    for (const field of [
      "runtime_revision",
      "runtime_execution_id",
      "mcp_endpoint",
    ])
      nonempty(
        row.runtime[field],
        "original Loss Runtime binding field required",
      );
  }
  const before = agent.initial.agent,
    after = agent.replacement.agent;
  same(
    after.configuration,
    before.configuration,
    "Loss Rebuild changed original configuration",
  );
  requireFact(
    after.executable_execution_revision !==
      before.executable_execution_revision,
    "Loss Rebuild retained the old executable revision",
  );
  requireFact(
    after.runtime.runtime_revision !== before.runtime.runtime_revision &&
      after.runtime.runtime_execution_id !==
        before.runtime.runtime_execution_id,
    "Loss Rebuild retained the old Runtime identity",
  );
}

function inspectConnections(evidence, agent) {
  const entries = evidence.private_connections
    .map((connection, index) => ({ connection, index }))
    .filter(({ connection }) => connection?.agentId === agent.id);
  requireFact(
    entries.length === 3,
    "three original Loss connections required per Agent",
  );
  const expectedMethods = [
    ["session/new", "session/prompt", "session/load"],
    ["session/load", "session/prompt"],
    ["session/load", "session/prompt"],
  ];
  const unavailable = admissionErrorReceipt("agent_unavailable");
  for (const [position, { connection }] of entries.entries()) {
    requireFact(
      connection.version === 1,
      "Loss entry requires its actual ACP v1 protocol",
    );
    requireFact(
      Array.isArray(connection.evidence) &&
        Array.isArray(connection.raw_frames),
      "original Loss recorder inventory required",
    );
    // Reuse the original recorder checks, without diagnostic Trace identities.
    const businessRow = (row) => ({
      ...row,
      connectionTraceID: undefined,
      clientSpanID: undefined,
    });
    safely(
      () =>
        checkPrivateACPConnection({
          ...connection,
          connectionTraceID: undefined,
          clientSpanID: undefined,
          initialization: businessRow(connection.initialization),
          evidence: connection.evidence.map(businessRow),
        }),
      "invalid original Loss SDK recorder evidence",
    );
    const initialization = connection.initialization;
    safely(() => {
      assertErrorCapability(initialization.initializationResult);
      assertErrorCapability(response(connection, initialization).result);
    }, "Loss initialization lacks the current error capability");
    same(
      connection.evidence.map((row) => row.method),
      expectedMethods[position],
      "Loss connection changed original requests",
    );
    for (const row of connection.evidence) {
      requireFact(
        object(row.requestParams),
        "original Loss request input required",
      );
      same(
        row.sessionId,
        agent.session_id,
        "Loss request changed original Session",
      );
      same(
        row.inputSessionID,
        row.requestParams.sessionId ?? null,
        "Loss request changed input Session",
      );
      const frame = response(connection, row);
      const denied = position === 1 && row.method === "session/prompt";
      if (denied) {
        same(
          row.requestParams,
          {
            sessionId: agent.session_id,
            prompt: [{ type: "text", text: phaseFor(agent.mode, "denied") }],
          },
          "Loss denial changed original input",
        );
        requireFact(
          row.outcome === "failed" && row.rejection === "agent_unavailable",
          "original Loss unavailable refusal required",
        );
        same(
          row.rejectionReceipt,
          {
            rpcCode: unavailable.code,
            code: unavailable.data.code,
            retryable: unavailable.data.retryable,
          },
          "Loss unavailable SDK receipt changed",
        );
        safely(
          () => assertAdmissionError(frame.error, "agent_unavailable"),
          "Loss unavailable raw error is not canonical",
        );
        continue;
      }
      requireFact(
        row.outcome === "succeeded" &&
          row.rejection === undefined &&
          row.rejectionReceipt === undefined,
        "original successful Loss request required",
      );
      same(
        row.requestReceipt,
        {
          requestId: row.requestId,
          params: row.requestParams,
          result: row.requestResult,
        },
        "Loss request lost its original SDK receipt",
      );
      requireFact(
        object(frame.result) && !Object.hasOwn(frame, "error"),
        "original successful Loss wire response required",
      );
      if (row.method === "session/prompt") {
        const phase = phaseFor(agent.mode, position === 0 ? "before" : "after");
        requireFact(
          row.kind === "ordinary" &&
            row.phase === phase &&
            row.toolName === (position === 0 ? "bash" : "read"),
          "Loss prompt changed original phase or Tool",
        );
        same(
          row.requestParams,
          {
            sessionId: agent.session_id,
            prompt: [{ type: "text", text: phase }],
          },
          "Loss prompt changed original input",
        );
        requireFact(
          row.requestResult.stopReason === "end_turn" &&
            frame.result.stopReason === "end_turn",
          "Loss prompt did not return the original completed result",
        );
      } else {
        same(
          row.requestParams,
          {
            cwd: "/workspace",
            mcpServers: [],
            ...(row.method === "session/load"
              ? { sessionId: agent.session_id }
              : {}),
          },
          "Loss new/load input changed",
        );
        if (row.method === "session/new")
          same(
            row.requestResult.sessionId,
            agent.session_id,
            "Loss Session is not the original new receipt",
          );
      }
    }
  }
  return {
    entries,
    prompts: [
      entries[0].connection.evidence[1],
      entries[2].connection.evidence[1],
    ],
    denial: entries[1].connection.evidence[1],
    loads: [
      entries[0].connection.evidence[2],
      entries[1].connection.evidence[0],
      entries[2].connection.evidence[0],
    ],
  };
}

function inspectSnapshot(run, state, principal) {
  const snapshot = run.execution_snapshot,
    agent = state.agent;
  requireFact(
    object(snapshot) && object(snapshot.runtime),
    "original Loss execution snapshot required",
  );
  same(
    snapshot.organizationId,
    principal.organization_id,
    "Loss Run snapshot changed organization",
  );
  for (const field of ["providerConnectionId", "modelProfileId"])
    nonempty(snapshot[field], "Loss Run snapshot lost its model identity");
  requireFact(
    Number.isSafeInteger(snapshot.configurationRevision) &&
      snapshot.configurationRevision > 0,
    "Loss Run snapshot lost configuration revision",
  );
  same(
    snapshot.accessRevision,
    agent.access_revision,
    "Loss Run snapshot changed access revision",
  );
  same(
    snapshot.agentSpecRevision,
    agent.agent_spec_revision,
    "Loss Run snapshot changed Agent spec revision",
  );
  same(
    snapshot.executionRevision,
    agent.executable_execution_revision,
    "Loss Run snapshot changed executable revision",
  );
  for (const [stored, current] of [
    ["revision", "runtime_revision"],
    ["executionId", "runtime_execution_id"],
    ["mcpEndpoint", "mcp_endpoint"],
  ])
    same(
      snapshot.runtime[stored],
      agent.runtime[current],
      "Loss Run snapshot changed original Runtime binding",
    );
  // The public Controller Agent DTO does not expose connection_id.
  nonempty(
    snapshot.runtime.connectionId,
    "Loss Run snapshot lost its private Runtime connection identity",
  );
}
function inspectEvents(page, run, agent, identities, sequences) {
  completePage(page, "Loss execution event page");
  requireFact(
    page.stream === "execution",
    "Loss execution event stream required",
  );
  let previous = 0;
  for (const event of page.items) {
    requireFact(object(event), "original Loss durable event required");
    nonempty(event.id, "original Loss durable event identity required");
    requireFact(
      !identities.has(event.id),
      "duplicate Loss durable event identity",
    );
    identities.add(event.id);
    // PostgreSQL rollback and other Session facts may leave numeric gaps.
    requireFact(
      Number.isSafeInteger(event.sequence) &&
        event.sequence > previous &&
        !sequences.has(event.sequence),
      "Loss execution events are duplicated or out of order",
    );
    sequences.add(event.sequence);
    previous = event.sequence;
    requireFact(
      typeof event.visible === "boolean" &&
        typeof event.created_at === "string" &&
        Number.isFinite(Date.parse(event.created_at)),
      "Loss event visibility and timestamp required",
    );
    requireFact(
      eventKinds.has(event.kind) &&
        object(event.payload) &&
        event.payload.kind === event.kind,
      "invalid Loss durable event kind",
    );
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      nonempty(
        event.payload.messageId,
        "original Loss message identity required",
      );
      requireFact(
        Array.isArray(event.payload.content),
        "original Loss message content required",
      );
      if (event.payload.responseId !== undefined)
        nonempty(
          event.payload.responseId,
          "original Loss response identity required",
        );
      if (event.kind === "agent_message")
        same(
          event.visible,
          event.payload.content.length > 0,
          "Loss assistant visibility changed",
        );
    }
    if (event.kind === "environment_change") {
      requireFact(
        event.visible === false &&
          run.input[0]?.text === phaseFor(agent.mode, "after"),
        "invalid Loss environment change fact",
      );
      same(
        event.payload.previousExecutionRevision,
        agent.initial.agent.executable_execution_revision,
        "Loss environment fact changed previous revision",
      );
      same(
        event.payload.currentExecutionRevision,
        agent.replacement.agent.executable_execution_revision,
        "Loss environment fact changed current revision",
      );
      nonempty(
        event.payload.content,
        "original Loss environment notice required",
      );
    }
  }
  const users = page.items.filter((event) => event.kind === "user_message");
  requireFact(
    users.length === 1 && users[0].visible,
    "one original Loss durable user prompt required",
  );
  same(users[0].payload.content, run.input, "Loss durable user input changed");
  requireFact(
    page.items.filter((event) => event.kind === "environment_change").length <=
      1,
    "Loss environment fact repeated",
  );
  return users[0];
}
function expectedArguments(mode, after) {
  return after
    ? { path: ".c5-loss.txt", offset: 1, limit: 4096 }
    : {
        command: `printf '${mode}-preserved\\n' >> /workspace/.c5-loss.txt; printf ${mode}-written`,
        working_dir: ".",
        timeout_ms: 5000,
      };
}
function inspectToolResult(last, mode, after) {
  requireFact(
    Array.isArray(last.content) &&
      last.content.length > 0 &&
      object(last.rawOutput),
    "original Loss durable Tool result required",
  );
  const output = last.rawOutput;
  requireFact(
    output.effect_state === "settled",
    "Loss durable Tool effects are not settled",
  );
  if (after)
    same(
      output.content,
      mode + "-preserved\n",
      "Loss durable read lost or repeated workspace bytes",
    );
  else
    requireFact(
      output.exit_code === 0 &&
        output.stdout === mode + "-written" &&
        output.stderr === "" &&
        output.truncated === false,
      "Loss durable write result changed",
    );
  requireFact(
    last.content.some((block) => {
      if (
        !object(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      )
        return false;
      try {
        return isDeepStrictEqual(JSON.parse(block.text), output);
      } catch {
        return false;
      }
    }),
    "Loss durable Tool text differs from its structured result",
  );
}
function inspectExecution(
  saved,
  prompt,
  agent,
  principal,
  identities,
  sequences,
) {
  const run = saved.run,
    after = prompt.phase === phaseFor(agent.mode, "after");
  for (const [field, expected] of Object.entries({
    state: "completed",
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    stop_reason: "end_turn",
    error_class: null,
  }))
    same(run[field], expected, "Loss Run is not durably completed and settled");
  requireFact(
    run.unknown_effect_source === undefined ||
      run.unknown_effect_source === null,
    "Loss Run retains unknown Tool effects",
  );
  inspectSnapshot(run, after ? agent.replacement : agent.initial, principal);
  same(
    run,
    after ? agent.after_run : agent.before_run,
    "Loss final Run differs from its original completed read",
  );
  const user = inspectEvents(saved.events, run, agent, identities, sequences);
  const tools = saved.events.items.filter(
    (event) => event.kind === "tool_call",
  );
  requireFact(
    tools.length >= 2,
    "Loss durable Tool start and completion required",
  );
  const first = tools[0].payload,
    last = tools.at(-1).payload;
  same(
    first.toolCallId,
    createHash("sha256")
      .update(JSON.stringify([run.run_id, 0, prompt.phase + "-tool"]))
      .digest("hex"),
    "Loss durable Tool changed original model identity",
  );
  same(
    first.modelName,
    after ? "read" : "bash",
    "Loss durable Tool changed original model name",
  );
  same(
    first.arguments,
    expectedArguments(agent.mode, after),
    "Loss durable Tool changed original arguments",
  );
  for (const [index, event] of tools.entries()) {
    const payload = event.payload;
    same(
      payload.toolCallId,
      first.toolCallId,
      "Loss durable Tool identity changed",
    );
    requireFact(
      event.visible === true && payload.initial === (index === 0),
      "Loss durable Tool start repeated or missing",
    );
    requireFact(
      payload.status ===
        (index === tools.length - 1 ? "completed" : "in_progress"),
      "Loss durable Tool progress or completion changed",
    );
    if (payload.arguments !== undefined)
      same(
        payload.arguments,
        first.arguments,
        "Loss durable Tool progress changed arguments",
      );
    if (payload.modelName !== undefined)
      same(
        payload.modelName,
        first.modelName,
        "Loss durable Tool progress changed model name",
      );
    if (payload.content !== undefined)
      requireFact(
        Array.isArray(payload.content),
        "Loss durable Tool content required",
      );
  }
  inspectToolResult(last, agent.mode, after);
  const dispatches = saved.events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => {
      requireFact(
        event.payload.toolCalls === undefined ||
          Array.isArray(event.payload.toolCalls),
        "original Loss model Tool dispatch required",
      );
      return (event.payload.toolCalls ?? []).map((call) => ({
        call,
        sequence: event.sequence,
      }));
    });
  requireFact(
    dispatches.length === 1,
    "Loss model Tool dispatch missing or repeated",
  );
  same(
    dispatches[0].call,
    { id: first.toolCallId, name: first.modelName, arguments: first.arguments },
    "Loss model dispatch differs from durable Tool execution",
  );
  requireFact(
    user.sequence < dispatches[0].sequence &&
      dispatches[0].sequence < tools[0].sequence,
    "Loss Tool preceded its original user input or model dispatch",
  );
  const replies = saved.events.items.filter(
    (event) => event.kind === "agent_message" && event.visible,
  );
  requireFact(
    replies.length > 0 && replies[0].sequence > tools.at(-1).sequence,
    "Loss durable final reply preceded Tool completion",
  );
  const reply = replies
    .flatMap((event) => event.payload.content)
    .map((block) => {
      requireFact(
        object(block) &&
          block.type === "text" &&
          typeof block.text === "string",
        "original Loss durable reply text required",
      );
      return block.text;
    })
    .join("");
  same(reply, prompt.phase + " completed", "Loss durable final reply changed");
  const usage = saved.events.items.filter((event) => event.kind === "usage");
  requireFact(
    usage.length === 2,
    "two original Loss model usage receipts required",
  );
  for (const event of usage)
    requireFact(
      event.visible === true &&
        object(event.payload.measurement) &&
        Number.isFinite(event.payload.used) &&
        event.payload.used >= 0 &&
        Number.isFinite(event.payload.size) &&
        event.payload.size > 0,
      "original Loss durable usage receipt required",
    );
  same(
    run.usage_measurements,
    usage.map((event) => event.payload.measurement),
    "Loss Run usage differs from durable events",
  );
}

function inspectAudits(evidence, agent, context, runIds, identities) {
  completePage(agent.audit?.page, "Loss Session Run page");
  requireFact(
    agent.audit.page.items.length === 2 &&
      Array.isArray(agent.audit.all) &&
      agent.audit.all.length === 2,
    "two original durable Loss Runs required per Agent",
  );
  const listed = new Map();
  for (const row of agent.audit.page.items) {
    requireFact(object(row), "original Loss Run summary required");
    for (const field of summaryFields)
      nonempty(row[field], "complete Loss Run summary required");
    same(row.agent_id, agent.id, "foreign listed Loss Agent");
    same(row.session_id, agent.session_id, "foreign listed Loss Session");
    same(
      row.principal_id,
      evidence.principal.user_id,
      "foreign listed Loss Principal",
    );
    requireFact(!listed.has(row.run_id), "duplicate listed Loss Run");
    listed.set(row.run_id, row);
  }
  const result = new Map(),
    sequences = new Set();
  for (const saved of agent.audit.all) {
    requireFact(object(saved?.run), "original Loss Run detail required");
    const run = saved.run;
    requireFact(
      listed.has(run.run_id) && !runIds.has(run.run_id),
      "Loss Run detail missing, repeated or foreign",
    );
    runIds.add(run.run_id);
    same(
      summarize(run),
      listed.get(run.run_id),
      "Loss Run detail differs from original list",
    );
    const matches = context.prompts.filter((prompt) =>
      isDeepStrictEqual(prompt.requestParams.prompt, run.input),
    );
    requireFact(
      matches.length === 1 && !result.has(matches[0].phase),
      "Loss Run is not bound to one original prompt",
    );
    inspectExecution(
      saved,
      matches[0],
      agent,
      evidence.principal,
      identities,
      sequences,
    );
    result.set(matches[0].phase, saved);
  }
  requireFact(
    result.size === 2,
    "both original Loss prompt executions required",
  );
  const before = result.get(phaseFor(agent.mode, "before"));
  const after = result.get(phaseFor(agent.mode, "after"));
  requireFact(
    before.events.items.at(-1).sequence < after.events.items[0].sequence,
    "Loss after-recovery events preceded original execution",
  );
  return { before, after };
}

// Match the actual ACP v1 projection, including progress, file observations and
// response IDs. This checks persisted events against original SDK notifications.
function toolUpdate(event) {
  const file = event.file;
  if (file !== undefined) {
    requireFact(object(file), "original Loss file observation required");
    nonempty(file.path, "original Loss file path required");
  }
  const locations =
    file === undefined ? event.locations : [{ path: file.path }];
  const diff = [];
  if (file?.change !== undefined && file.change.before !== file.change.after) {
    requireFact(
      object(file.change) &&
        (file.change.before === null ||
          typeof file.change.before === "string") &&
        typeof file.change.after === "string",
      "invalid Loss durable file change",
    );
    diff.push({
      type: "diff",
      path: file.path,
      oldText: file.change.before,
      newText: file.change.after,
    });
  }
  return {
    sessionUpdate: event.initial ? "tool_call" : "tool_call_update",
    toolCallId: event.toolCallId,
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.toolKind === undefined ? {} : { kind: event.toolKind }),
    ...(locations === undefined ? {} : { locations }),
    ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
    ...(event.modelName === undefined ? {} : { name: event.modelName }),
    ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
    status: event.status === "cancelled" ? "failed" : event.status,
    ...(event.content === undefined && file === undefined
      ? {}
      : {
          content: [
            ...(event.content ?? []).map((content) => ({
              type: "content",
              content,
            })),
            ...diff,
          ],
        }),
  };
}
function messageUpdates(event) {
  return event.content.flatMap((block) => {
    requireFact(object(block), "original Loss message block required");
    const parts = [];
    if (
      block.type !== "text" ||
      typeof block.text !== "string" ||
      block.text.length <= 65536
    )
      parts.push(block);
    else
      for (let start = 0; start < block.text.length;) {
        let end = Math.min(start + 65536, block.text.length);
        if (end < block.text.length) {
          const before = block.text.charCodeAt(end - 1),
            after = block.text.charCodeAt(end);
          if (
            before >= 0xd800 &&
            before <= 0xdbff &&
            after >= 0xdc00 &&
            after <= 0xdfff
          )
            end--;
        }
        parts.push({ ...block, text: block.text.slice(start, end) });
        start = end;
      }
    return parts.map((content) => ({
      sessionUpdate: event.kind + "_chunk",
      messageId: event.responseId ?? event.messageId,
      content,
    }));
  });
}
function projected(saved, replay = false) {
  return saved.events.items
    .filter((event) => event.visible)
    .flatMap(({ payload }) => {
      let updates;
      switch (payload.kind) {
        case "user_message":
          updates = replay ? messageUpdates(payload) : [];
          break;
        case "agent_message":
        case "agent_thought":
          updates = messageUpdates(payload);
          break;
        case "tool_call":
          updates = [toolUpdate(payload)];
          break;
        case "usage":
          updates = [
            {
              sessionUpdate: "usage_update",
              used: payload.used,
              size: payload.size,
              ...(payload.cost === undefined ? {} : { cost: payload.cost }),
            },
          ];
          break;
        case "state":
          updates = [];
          break;
        default:
          throw new Error("unexpected visible Loss execution event");
      }
      return updates.map((update) => ({
        sessionId: saved.run.session_id,
        update,
      }));
    });
}
function executionUpdates(frames, session) {
  requireFact(
    Array.isArray(frames),
    "original Loss SDK notifications required",
  );
  return frames.flatMap((frame) => {
    requireFact(
      object(frame) && object(frame.update) && frame.sessionId === session,
      "foreign or invalid Loss SDK notification",
    );
    return metadataUpdates.has(frame.update.sessionUpdate)
      ? []
      : [{ sessionId: frame.sessionId, update: frame.update }];
  });
}
function inspectNotifications(agent, context, saved) {
  const replay = projected(saved.before, true);
  const expected = [
    [...projected(saved.before), ...replay],
    replay,
    [...replay, ...projected(saved.after)],
  ];
  for (const [index, { connection }] of context.entries.entries())
    same(
      executionUpdates(connection.updates, agent.session_id),
      expected[index],
      "Loss original SDK execution or replay differs from durable events",
    );
  return replay.filter((frame) =>
    historyUpdates.has(frame.update.sessionUpdate),
  );
}
function inspectCheckpoints(agent, context, saved, model, history) {
  const baseline = { items: [summarize(saved.before.run)], next_cursor: null };
  // The shared model server also retains the preceding live case during cold.
  const modelBaseline = model.slice(0, agent.mode === "live" ? 2 : 6);
  const checkpoint = (state) => {
    completePage(state?.page, "Loss checkpoint Run page");
    same(state.page, baseline, "Loss denial or replay changed durable Runs");
    same(
      modelRows(state.model_requests),
      modelBaseline,
      "Loss denial or replay invoked the model",
    );
  };
  const denial = agent.denial;
  requireFact(object(denial), "original Loss denial checkpoints required");
  requireFact(
    denial.connection_index === context.entries[1].index &&
      denial.request_id === context.denial.requestId,
    "Loss denial checkpoint changed original request identity",
  );
  for (const state of [denial.before, denial.after]) {
    checkpoint(state);
    same(
      state.updates,
      context.entries[1].connection.updates,
      "Loss denial changed original SDK notifications",
    );
  }
  same(
    denial.after.updates,
    denial.before.updates,
    "Loss denial emitted notifications",
  );
  requireFact(
    Array.isArray(agent.replays) && agent.replays.length === 3,
    "all three original Loss replay checkpoints required",
  );
  const used = new Set();
  for (const [position, { index }] of context.entries.entries()) {
    const matches = agent.replays.filter(
      (replay) =>
        replay?.connection_index === index &&
        replay.request_id === context.loads[position].requestId,
    );
    requireFact(
      matches.length === 1 && !used.has(index),
      "Loss replay changed original connection-local request identity",
    );
    used.add(index);
    const replay = matches[0];
    checkpoint(replay.before);
    checkpoint(replay.after);
    same(
      replay.after.history,
      history,
      "Loss replay changed original durable Session history",
    );
  }
}

// Pure admission of captured original SDK/Admin/model business receipts. These
// counts do not certify physical Runtime operations, SQL observation lineage,
// cancellation, RPC counts or actual resource joins; the real flow owns those.
export function inspectLossBusinessEvidence(evidence) {
  inspectOwner(evidence);
  requireFact(
    Array.isArray(evidence.agents) && evidence.agents.length === 2,
    "both original Loss Agents required",
  );
  requireFact(
    Array.isArray(evidence.private_connections) &&
      evidence.private_connections.length === 6,
    "six original Loss connections required",
  );
  const model = inspectModel(evidence.provider_requests);
  const agentIds = new Set(),
    sessions = new Set(),
    runIds = new Set(),
    identities = new Set();
  for (const mode of modes) {
    const matches = evidence.agents.filter((agent) => agent?.mode === mode);
    requireFact(
      matches.length === 1,
      "one original Loss Agent required per mode",
    );
    const agent = matches[0];
    inspectAgent(agent, evidence.principal);
    requireFact(
      !agentIds.has(agent.id) && !sessions.has(agent.session_id),
      "Loss Agents or Sessions overlap",
    );
    agentIds.add(agent.id);
    sessions.add(agent.session_id);
    const context = inspectConnections(evidence, agent);
    const saved = inspectAudits(evidence, agent, context, runIds, identities);
    const history = inspectNotifications(agent, context, saved);
    inspectCheckpoints(agent, context, saved, model, history);
  }
  return {
    status: "passed",
    agents: 2,
    connections: 6,
    initializations: 6,
    business_requests: 14,
    runs: 4,
    completed_runs: 4,
    persisted_tools: 4,
    denied_prompts: 2,
    provider_requests: 8,
    replays: 6,
  };
}
