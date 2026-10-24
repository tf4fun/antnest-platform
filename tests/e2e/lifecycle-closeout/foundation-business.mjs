import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
import { assertCompletedModelAttempts } from "../../support/model-attempt-evidence.mjs";

const phases = ["c3-held-run", "c3-after-rebuild"];
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
const eventKinds = new Set([
  "user_message",
  "agent_message",
  "agent_thought",
  "tool_call",
  "usage",
  "state",
  "environment_change",
  "model_attempt",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value, message) =>
  assert(typeof value === "string" && value.trim().length > 0, message);
const same = (actual, expected, message) =>
  assert(isDeepStrictEqual(actual, expected), message);

function completePage(page, name) {
  assert(Array.isArray(page?.items), name + " items required");
  assert(page.items.length <= 100, name + " exceeds one evidence page");
  assert.equal(page.next_cursor, null, "complete " + name + " required");
}

function response(connection, row) {
  const frames = connection.raw_frames.filter(
    (frame) =>
      Object.hasOwn(frame, "id") &&
      String(frame.id) === row.requestId &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
  );
  assert.equal(frames.length, 1, "one original SDK response required");
  return frames[0];
}

function inspectConnections(evidence) {
  const connections = evidence.private_connections;
  assert(Array.isArray(connections) && connections.length === 2);
  for (const connection of connections) {
    assert.equal(connection.version, 1, "default Foundation uses ACP v1");
    same(connection.agentId, evidence.agent_id, "foreign Foundation Agent");
    // Reuse the recorder's wire/response checks without making diagnostic IDs
    // admission inputs. Request identity remains local to each connection.
    const businessRow = (row) => ({
      ...row,
      connectionTraceID: undefined,
      clientSpanID: undefined,
    });
    checkPrivateACPConnection({
      ...connection,
      connectionTraceID: undefined,
      clientSpanID: undefined,
      initialization: businessRow(connection.initialization),
      evidence: connection.evidence.map(businessRow),
    });
  }
  const [first, second] = connections.map((connection) => connection.evidence);
  same(
    first.map((row) => row.method),
    [
      "session/new",
      "session/new",
      "session/prompt",
      "session/prompt",
      "session/prompt",
    ],
    "first connection changed the original Foundation requests",
  );
  same(
    second.map((row) => row.method),
    ["session/load", "session/prompt"],
    "second connection changed the original Foundation requests",
  );
  const session = first[0].sessionId;
  const deniedSession = first[1].sessionId;
  nonempty(session, "original Foundation Session required");
  nonempty(deniedSession, "original rejected Session required");
  assert(session !== deniedSession, "accepted and rejected Sessions overlap");
  same(
    first.map((row) => row.sessionId),
    [session, deniedSession, session, deniedSession, deniedSession],
    "first connection changed original Session identities",
  );
  same(
    second.map((row) => row.sessionId),
    [session, session],
    "rebuild changed the original Session",
  );
  const busy = admissionErrorReceipt("agent_busy");
  const busyReceipt = {
    rpcCode: busy.code,
    code: busy.data.code,
    retryable: busy.data.retryable,
  };
  for (const [index, connection] of connections.entries()) {
    for (const [rowIndex, row] of connection.evidence.entries()) {
      assert(object(row.requestParams), "original request input required");
      same(
        row.inputSessionID,
        row.requestParams.sessionId ?? null,
        "original request Session changed",
      );
      const denied = index === 0 && rowIndex >= 3;
      const frame = response(connection, row);
      if (denied) {
        assert.equal(row.rejection, "agent_busy");
        assert.equal(row.outcome, "failed");
        same(row.rejectionReceipt, busyReceipt, "busy receipt changed");
        assertAdmissionError(frame.error, "agent_busy");
        same(
          row.requestParams,
          {
            sessionId: deniedSession,
            prompt: [{ type: "text", text: "c3-denied" }],
          },
          "busy denial is not bound to its original input",
        );
        continue;
      }
      assert.equal(row.rejection, undefined);
      assert.equal(row.outcome, "succeeded");
      same(
        row.requestReceipt,
        {
          requestId: row.requestId,
          params: row.requestParams,
          result: row.requestResult,
        },
        "successful request lost its original SDK receipt",
      );
      if (row.method === "session/prompt") {
        assert.equal(row.kind, "ordinary");
        assert.equal(row.phase, phases[index]);
        assert.equal(row.toolName ?? "bash", index === 0 ? "bash" : "read");
        same(
          row.requestParams,
          {
            sessionId: session,
            prompt: [{ type: "text", text: phases[index] }],
          },
          "successful prompt changed its original input",
        );
        assert.equal(row.requestResult.stopReason, "end_turn");
        same(
          frame.result?.stopReason,
          row.requestResult.stopReason,
          "raw prompt response changed its original SDK result",
        );
      } else {
        same(
          row.requestParams,
          {
            cwd: "/workspace",
            mcpServers: [],
            ...(row.method === "session/load" ? { sessionId: session } : {}),
          },
          "new/load input changed",
        );
      }
    }
  }
  return {
    connections,
    session,
    deniedSession,
    prompts: [first[2], second[1]],
    denied: first.slice(3),
  };
}

function modelRows(rows) {
  assert(Array.isArray(rows), "original model request inventory required");
  return rows.map((row) => {
    assert(object(row), "original model request required");
    nonempty(row.phase, "model phase required");
    assert(["tool", "reply"].includes(row.stage), "unknown model stage");
    assert(
      Number.isFinite(row.received_at_ms) && row.received_at_ms > 0,
      "original model receipt time required",
    );
    return {
      phase: row.phase,
      stage: row.stage,
      received_at_ms: row.received_at_ms,
    };
  });
}

function inspectModel(evidence) {
  const requests = modelRows(evidence.provider_requests);
  same(
    requests.map(({ phase, stage }) => [phase, stage]),
    phases.flatMap((phase) => ["tool", "reply"].map((stage) => [phase, stage])),
    "Foundation model requests are missing, repeated or out of order",
  );
  return requests;
}

function inspectEvents(page, run, identities, sequences) {
  completePage(page, "execution event page");
  assert.equal(page.stream, "execution");
  let previous = 0;
  for (const event of page.items) {
    nonempty(event.id, "persisted event identity required");
    assert(!identities.has(event.id), "duplicate persisted event identity");
    identities.add(event.id);
    assert(
      Number.isSafeInteger(event.sequence) && event.sequence > previous,
      "persisted events are out of order",
    );
    assert(!sequences.has(event.sequence), "duplicate Session event sequence");
    sequences.add(event.sequence);
    previous = event.sequence;
    assert.equal(typeof event.visible, "boolean");
    assert(
      typeof event.created_at === "string" &&
        Number.isFinite(Date.parse(event.created_at)),
      "persisted event timestamp required",
    );
    assert(eventKinds.has(event.kind), "unexpected persisted Foundation event");
    assert(object(event.payload), "persisted event payload required");
    assert.equal(
      event.payload.kind,
      event.kind,
      "persisted event kind changed",
    );
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      same(
        event.payload.messageId,
        event.id,
        "persisted message identity changed",
      );
      assert(
        Array.isArray(event.payload.content),
        "persisted message content required",
      );
      if (event.payload.responseId !== undefined)
        nonempty(
          event.payload.responseId,
          "original response identity required",
        );
      if (event.kind === "agent_message")
        assert.equal(event.visible, event.payload.content.length > 0);
    }
    if (event.kind === "environment_change")
      assert.equal(
        event.visible,
        false,
        "environment change became public history",
      );
  }
  const users = page.items.filter((event) => event.kind === "user_message");
  assert.equal(users.length, 1, "one durable original user prompt required");
  assert.equal(users[0].visible, true);
  same(users[0].payload.content, run.input, "durable user prompt changed");
  return users[0];
}

function inspectExecution(saved, prompt, evidence, identities, sequences) {
  const { run, events } = saved;
  assert.equal(run.state, "completed");
  assert.equal(run.terminal_class, "completed");
  assert.equal(run.executor_state, "quiescent");
  assert.equal(run.tool_effect_state, "settled");
  assert.equal(run.stop_reason, "end_turn");
  assert.equal(run.error_class, null);
  assert(
    run.unknown_effect_source === undefined ||
      run.unknown_effect_source === null,
    "unknown Tool effects remain",
  );
  assert(
    object(run.execution_snapshot),
    "original execution snapshot required",
  );
  same(
    run.execution_snapshot.executionRevision,
    evidence.execution_revisions[prompt.phase],
    "Run changed its original Agent execution revision",
  );
  const user = inspectEvents(events, run, identities, sequences);
  const tools = events.items.filter((event) => event.kind === "tool_call");
  assert(tools.length >= 2, "durable Tool start and completion required");
  const first = tools[0].payload;
  const last = tools.at(-1).payload;
  nonempty(first.toolCallId, "durable Tool identity required");
  assert.equal(first.modelName, prompt.phase === phases[0] ? "bash" : "read");
  assert(object(first.arguments), "durable Tool arguments required");
  for (const [index, event] of tools.entries()) {
    same(
      event.payload.toolCallId,
      first.toolCallId,
      "durable Tool identity changed",
    );
    assert.equal(event.visible, true);
    assert.equal(
      event.payload.initial,
      index === 0,
      "Tool start repeated or missing",
    );
    assert.equal(
      event.payload.status,
      index === tools.length - 1 ? "completed" : "in_progress",
      "Tool progress or completion changed",
    );
    if (event.payload.content !== undefined)
      assert(
        Array.isArray(event.payload.content),
        "durable Tool content required",
      );
  }
  assert(
    Array.isArray(last.content) && last.content.length > 0,
    "Tool result missing",
  );
  const dispatches = events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => {
      const calls = event.payload.toolCalls;
      assert(calls === undefined || Array.isArray(calls));
      return (calls ?? []).map((call) => ({ call, sequence: event.sequence }));
    });
  assert.equal(
    dispatches.length,
    1,
    "one original model Tool dispatch required",
  );
  same(
    dispatches[0].call,
    { id: first.toolCallId, name: first.modelName, arguments: first.arguments },
    "model Tool dispatch differs from durable Tool execution",
  );
  assert(
    user.sequence < tools[0].sequence,
    "Tool preceded original user input",
  );
  assert(
    dispatches[0].sequence < tools[0].sequence,
    "Tool preceded model dispatch",
  );
  const replies = events.items.filter(
    (event) => event.kind === "agent_message" && event.visible,
  );
  assert(replies.length > 0, "durable final assistant reply required");
  const reply = replies
    .flatMap((event) => event.payload.content)
    .map((block) => {
      assert(
        object(block) &&
          block.type === "text" &&
          typeof block.text === "string",
      );
      return block.text;
    })
    .join("");
  same(
    reply,
    prompt.phase + " completed",
    "durable final assistant reply changed",
  );
  assert(
    replies[0].sequence > tools.at(-1).sequence,
    "assistant preceded Tool completion",
  );
  const usage = events.items.filter((event) => event.kind === "usage");
  assert.equal(usage.length, 2, "two durable model usage receipts required");
  for (const event of usage) {
    assert.equal(event.visible, true);
    assert(object(event.payload.measurement), "per-call usage receipt missing");
    assert(Number.isFinite(event.payload.used) && event.payload.used >= 0);
    assert(Number.isFinite(event.payload.size) && event.payload.size > 0);
  }
  same(
    run.usage_measurements,
    usage.map((event) => event.payload.measurement),
    "Run usage differs from its complete durable events",
  );
  assertCompletedModelAttempts(run, events.items);
}

function inspectAudits(evidence, context) {
  const audits = evidence.audits;
  assert(Array.isArray(audits) && audits.length === 2);
  const sessions = new Map();
  for (const audit of audits) {
    nonempty(audit.session_id, "original audit Session required");
    assert(!sessions.has(audit.session_id), "duplicate audit Session");
    sessions.set(audit.session_id, audit);
  }
  const active = sessions.get(context.session);
  const denied = sessions.get(context.deniedSession);
  assert(active && denied, "both original Session inventories required");
  completePage(active.page, "accepted Session Run page");
  completePage(denied.page, "rejected Session Run page");
  assert.equal(active.page.items.length, 2, "two durable Runs required");
  same(denied.page.items, [], "rejected Session acquired a Run");
  same(denied.all, [], "rejected Session acquired durable execution");
  assert(Array.isArray(active.all) && active.all.length === 2);
  const listed = new Map();
  for (const row of active.page.items) {
    for (const field of summaryFields)
      nonempty(row[field], "complete original Run summary required");
    same(row.agent_id, evidence.agent_id, "foreign listed Agent");
    same(row.principal_id, evidence.principal_id, "foreign listed Principal");
    same(row.session_id, context.session, "foreign listed Session");
    assert(!listed.has(row.run_id), "duplicate listed Run");
    listed.set(row.run_id, row);
  }
  const identities = new Set();
  const sequences = new Set();
  const runIds = new Set();
  const byPhase = new Map();
  for (const saved of active.all) {
    assert(object(saved?.run), "durable Run detail required");
    const run = saved.run;
    const original = listed.get(run.run_id);
    assert(original, "Run detail was not in the original list");
    assert(!runIds.has(run.run_id), "duplicate durable Run");
    runIds.add(run.run_id);
    for (const field of summaryFields)
      same(
        run[field],
        original[field],
        "Run detail changed its original summary",
      );
    const matches = context.prompts.filter((prompt) =>
      isDeepStrictEqual(prompt.requestParams.prompt, run.input),
    );
    assert.equal(matches.length, 1, "Run is not bound to one original prompt");
    const prompt = matches[0];
    assert(
      !byPhase.has(prompt.phase),
      "original prompt produced multiple Runs",
    );
    inspectExecution(saved, prompt, evidence, identities, sequences);
    byPhase.set(prompt.phase, saved);
  }
  assert.equal(byPhase.size, 2, "both original prompt executions required");
  return byPhase;
}

// Mirror the v1 projection in transport/acp/v1/agent.ts and file-content.ts,
// including intermediate Tool progress, response IDs and file observations.
function toolUpdate(event) {
  const file = event.file;
  if (file !== undefined) {
    assert(object(file), "durable file observation required");
    nonempty(file.path, "durable file path required");
  }
  const locations =
    file === undefined ? event.locations : [{ path: file.path }];
  const diff = [];
  if (file?.change !== undefined && file.change.before !== file.change.after) {
    assert(object(file.change));
    assert(
      file.change.before === null || typeof file.change.before === "string",
    );
    assert.equal(typeof file.change.after, "string");
    diff.push({
      type: "diff",
      path: file.path,
      oldText: file.change.before,
      newText: file.change.after,
    });
  }
  return {
    sessionUpdate: event.initial ? "tool_call" : "tool_call_update",
    ...(event.title === undefined ? {} : { title: event.title }),
    toolCallId: event.toolCallId,
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
  const updates = [];
  for (const block of event.content) {
    assert(object(block), "durable message block required");
    const parts = [];
    if (
      block.type !== "text" ||
      typeof block.text !== "string" ||
      block.text.length <= 65536
    )
      parts.push(block);
    else {
      for (let start = 0; start < block.text.length;) {
        let end = Math.min(start + 65536, block.text.length);
        if (end < block.text.length) {
          const before = block.text.charCodeAt(end - 1);
          const after = block.text.charCodeAt(end);
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
    }
    for (const content of parts)
      updates.push({
        sessionUpdate: event.kind + "_chunk",
        messageId: event.responseId ?? event.messageId,
        content,
      });
  }
  return updates;
}

function projected(saved, sessionId, { replay = false } = {}) {
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
          assert.fail("unexpected visible Foundation event");
      }
      return updates.map((update) => ({ sessionId, update }));
    });
}

function executionUpdates(connection, context) {
  assert(
    Array.isArray(connection.updates),
    "original SDK notifications required",
  );
  const updates = [];
  for (const frame of connection.updates) {
    assert(
      object(frame) && object(frame.update),
      "original SDK notification required",
    );
    assert(
      frame.sessionId === context.session ||
        frame.sessionId === context.deniedSession,
      "foreign SDK notification Session",
    );
    if (metadataUpdates.has(frame.update.sessionUpdate)) continue;
    same(
      frame.sessionId,
      context.session,
      "rejected Session received execution",
    );
    updates.push({ sessionId: frame.sessionId, update: frame.update });
  }
  return updates;
}

function inspectNotifications(context, byPhase) {
  const held = byPhase.get(phases[0]);
  const fresh = byPhase.get(phases[1]);
  same(
    executionUpdates(context.connections[0], context),
    projected(held, context.session),
    "original held execution notifications differ from durable events",
  );
  same(
    executionUpdates(context.connections[1], context),
    [
      ...projected(held, context.session, { replay: true }),
      ...projected(fresh, context.session),
    ],
    "load replay or new execution differs from durable events",
  );
}

function inspectBusy(evidence, context, model) {
  const checks = evidence.busy_checks;
  assert(
    Array.isArray(checks) && checks.length === 2,
    "both busy checkpoints required",
  );
  same(
    checks.map((check) => check.request_id),
    context.denied.map((row) => row.requestId),
    "busy checkpoints changed original request identities",
  );
  const finalUpdates = context.connections[0].updates.filter(
    (frame) => frame.sessionId === context.deniedSession,
  );
  for (const check of checks) {
    same(
      check.session_id,
      context.deniedSession,
      "busy checkpoint changed Session",
    );
    for (const state of [check.before, check.after]) {
      completePage(state?.page, "busy Session Run page");
      same(state.page.items, [], "busy denial admitted execution");
      same(
        modelRows(state.model_requests),
        [model[0]],
        "busy denial reached the model",
      );
      assert(
        Array.isArray(state.updates),
        "original busy notifications required",
      );
      for (const frame of state.updates) {
        same(
          frame.sessionId,
          context.deniedSession,
          "foreign busy notification",
        );
        assert(
          metadataUpdates.has(frame.update?.sessionUpdate),
          "busy denial emitted execution notifications",
        );
      }
      same(
        state.updates,
        finalUpdates,
        "busy notifications changed after rejection",
      );
    }
    same(
      check.after.updates,
      check.before.updates,
      "busy denial changed notifications",
    );
  }
}

// A pure inspection of captured wire and Admin DTOs. Its count summary is not a
// certificate of resource joins, cancellation, Runtime stopping or RPC counts.
export function inspectFoundationBusinessEvidence(evidence) {
  nonempty(evidence?.agent_id, "original Foundation Agent required");
  nonempty(evidence.principal_id, "original Foundation Principal required");
  assert(
    object(evidence.execution_revisions),
    "original Agent revisions required",
  );
  for (const phase of phases)
    nonempty(
      evidence.execution_revisions[phase],
      "original Agent revision required",
    );
  assert(
    evidence.execution_revisions[phases[0]] !==
      evidence.execution_revisions[phases[1]],
    "rebuild did not change the Agent execution revision",
  );
  const context = inspectConnections(evidence);
  const model = inspectModel(evidence);
  const byPhase = inspectAudits(evidence, context);
  inspectNotifications(context, byPhase);
  inspectBusy(evidence, context, model);
  return {
    status: "passed",
    connections: 2,
    initializations: 2,
    business_requests: 7,
    completed_prompts: 2,
    denied_prompts: 2,
    runs: 2,
    tool_calls: 2,
    provider_requests: 4,
  };
}
