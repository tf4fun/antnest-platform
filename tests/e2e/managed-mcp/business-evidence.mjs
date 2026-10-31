import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertPromptComplete, assertReplay } from "./protocol.mjs";
import { assertModelSequence } from "./rebuild-evidence.mjs";

const plans = [
  ["managed-bootstrap", ["write", "write"]],
  ["managed-exercise", ["mcp__alpha__fail", "mcp__alpha__echo", "bash"]],
  ["managed-mutate", ["write"]],
  ["managed-fresh", ["mcp__alpha__echo"]],
  ["managed-draining", ["mcp__alpha__echo", "mcp__alpha__echo"]],
  ["managed-rebuilt", ["mcp__beta__echo"]],
];
const summaryFields = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const publicSnapshotFields = new Set([
  "providerConnectionId",
  "modelProfileId",
  "modelProfileRevision",
  "configurationRevision",
  "agentSpecRevision",
  "executionRevision",
  "deadlineAt",
  "agentExecutionSpecDigest",
  "executionSpec",
]);
const messageKinds = new Set([
  "user_message",
  "agent_message",
  "agent_thought",
]);
const toolUpdates = new Set(["tool_call", "tool_call_update"]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value, label) =>
  assert(typeof value === "string" && value.trim().length > 0, label);

function completePage(page, label) {
  assert(object(page) && Array.isArray(page.items), label + " items required");
  assert(page.items.length <= 100, label + " exceeds requested page");
  assert.equal(page.next_cursor, null, "complete " + label + " required");
}

function originalRequests(evidence) {
  assert(
    [1, 2].includes(evidence.version),
    "Managed protocol version required",
  );
  for (const field of ["agentId", "sessionId", "principalId"])
    nonempty(evidence[field], "original Managed identity required");
  assert(Array.isArray(evidence.requests));
  assert.equal(
    evidence.requests.length,
    plans.length,
    "six original Managed prompts required",
  );
  const identities = new Set();
  return plans.map(([phase, names]) => {
    const matches = evidence.requests.filter(
      (request) => request.phase === phase,
    );
    assert.equal(
      matches.length,
      1,
      "missing or duplicate original Managed phase",
    );
    const request = matches[0],
      receipt = request.requestReceipt;
    assert.equal(request.kind, "managed");
    assert.equal(request.label, phase);
    assert.equal(request.boundary, "private-acp");
    assert.equal(request.transport, "websocket");
    assert.equal(request.protocolVersion, evidence.version);
    assert.equal(request.method, "session/prompt");
    assert.equal(request.agentId, evidence.agentId);
    assert.equal(request.sessionId, evidence.sessionId);
    assert.equal(request.outcome, "succeeded");
    nonempty(request.requestId, "actual Managed request identity required");
    assert(
      !identities.has(request.requestId),
      "duplicate Managed request identity",
    );
    identities.add(request.requestId);
    assert(object(receipt), "actual Managed prompt receipt required");
    assert.equal(receipt.requestId, request.requestId);
    assert.equal(receipt.params?.sessionId, evidence.sessionId);
    assert.deepEqual(receipt.params.prompt, [{ type: "text", text: phase }]);
    if (evidence.version === 1)
      assert.deepEqual(receipt.result, { stopReason: "end_turn" });
    else {
      nonempty(receipt.result?.messageId, "v2 durable input identity required");
      assert.deepEqual(receipt.result, { messageId: receipt.result.messageId });
    }
    assert(
      receipt.error === undefined || receipt.error === null,
      "successful Managed prompt has an error receipt",
    );
    const captured = request.snapshot;
    assert(object(captured), "captured Runtime identity required");
    assert.equal(captured.agent_id, evidence.agentId);
    for (const field of [
      "runtime_revision",
      "runtime_execution_id",
      "mcp_endpoint",
      "execution_revision",
    ])
      nonempty(captured[field], "captured Runtime field required");
    return { phase, names, request, receipt };
  });
}

function inspectSnapshot(run, captured) {
  const snapshot = run.execution_snapshot;
  // Admin exposes an allowlisted snapshot, not private Runtime authority.
  // Its execution revision binds this Run to the original captureRuntime()
  // receipt; process and endpoint identity remain in that separate receipt.
  assert(object(snapshot), "durable public execution snapshot required");
  assert(
    Object.keys(snapshot).every((field) => publicSnapshotFields.has(field)),
    "unexpected public execution snapshot field",
  );
  for (const field of [
    "providerConnectionId",
    "modelProfileId",
    "agentSpecRevision",
    "executionRevision",
    "agentExecutionSpecDigest",
  ])
    nonempty(snapshot[field], "captured public execution field required");
  assert(
    !Object.hasOwn(snapshot, "modelProfileRevision") ||
      (Number.isSafeInteger(snapshot.modelProfileRevision) &&
        snapshot.modelProfileRevision > 0),
    "invalid captured model profile revision",
  );
  if (Object.hasOwn(run, "model_profile_revision"))
    assert.equal(
      run.model_profile_revision,
      snapshot.modelProfileRevision ?? null,
      "audit model profile revision differs from the captured snapshot",
    );
  assert.equal(snapshot.executionRevision, captured.execution_revision);
  assert(
    Number.isSafeInteger(snapshot.configurationRevision) &&
      snapshot.configurationRevision > 0,
    "captured configuration revision required",
  );
  assert(
    typeof snapshot.deadlineAt === "string" &&
      Number.isFinite(Date.parse(snapshot.deadlineAt)) &&
      object(snapshot.executionSpec),
    "captured public execution boundary required",
  );
}

function inspectEvents(events, run, eventIds, sequences) {
  completePage(events, "execution event page");
  assert.equal(events.stream, "execution");
  let previous = 0;
  for (const event of events.items) {
    nonempty(event.id, "durable event identity required");
    assert(!eventIds.has(event.id), "duplicate durable event identity");
    eventIds.add(event.id);
    assert(
      Number.isSafeInteger(event.sequence) && event.sequence > previous,
      "unordered durable event sequence",
    );
    assert(!sequences.has(event.sequence), "duplicate Session event sequence");
    sequences.add(event.sequence);
    previous = event.sequence;
    assert.equal(typeof event.visible, "boolean");
    assert(
      Number.isFinite(Date.parse(event.created_at)),
      "invalid durable event timestamp",
    );
    nonempty(event.kind, "durable event kind required");
    assert(object(event.payload), "durable event payload required");
    assert.equal(event.payload.kind, event.kind, "durable event kind changed");
    if (messageKinds.has(event.kind)) {
      assert.equal(
        event.payload.messageId,
        event.id,
        "durable message identity changed",
      );
      assert(
        Array.isArray(event.payload.content),
        "durable message content required",
      );
      if (event.kind === "agent_message")
        assert.equal(event.visible, event.payload.content.length > 0);
      if (event.payload.responseId !== undefined)
        nonempty(
          event.payload.responseId,
          "durable response identity required",
        );
    }
  }
  const users = events.items.filter((event) => event.kind === "user_message");
  assert.equal(users.length, 1, "one durable input required per Run");
  assert.equal(users[0].visible, true);
  assert.deepEqual(
    users[0].payload.content,
    run.input,
    "durable input changed",
  );
  return users[0];
}

function mergedContent(blocks) {
  const result = [];
  for (const block of blocks) {
    assert(
      object(block) && typeof block.type === "string",
      "message content block required",
    );
    const previous = result.at(-1);
    if (
      block.type === "text" &&
      previous?.type === "text" &&
      typeof block.text === "string" &&
      typeof previous.text === "string" &&
      isDeepStrictEqual({ ...block, text: "" }, { ...previous, text: "" })
    )
      previous.text += block.text;
    else result.push(structuredClone(block));
  }
  return result;
}

function normalizeMessages(messages) {
  const result = [];
  for (const message of messages) {
    nonempty(message.id, "message notification identity required");
    const previous = result.at(-1);
    if (previous?.kind === message.kind && previous.id === message.id)
      previous.content = mergedContent([
        ...previous.content,
        ...message.content,
      ]);
    else result.push({ ...message, content: mergedContent(message.content) });
  }
  return result;
}

function durableMessages(records, { omitUsers = false } = {}) {
  return normalizeMessages(
    records.flatMap(({ events }) =>
      events.items
        .filter(
          (event) =>
            event.visible &&
            messageKinds.has(event.kind) &&
            !(omitUsers && event.kind === "user_message"),
        )
        .map(({ payload }) => ({
          kind: payload.kind,
          id: payload.responseId ?? payload.messageId,
          content: payload.content,
        })),
    ),
  );
}

function observedMessages(notifications, sessionId) {
  assert(
    Array.isArray(notifications),
    "original Managed notifications required",
  );
  const messages = [];
  for (const notification of notifications) {
    assert.equal(
      notification.sessionId,
      sessionId,
      "foreign Managed notification Session",
    );
    const update = notification.update;
    assert(object(update), "Managed notification update required");
    nonempty(update.sessionUpdate, "Managed notification kind required");
    const kind = update.sessionUpdate.replace(/_chunk$/u, "");
    if (!messageKinds.has(kind)) continue;
    const content = Array.isArray(update.content)
      ? update.content
      : [update.content];
    messages.push({ kind, id: update.messageId, content });
  }
  return normalizeMessages(messages);
}

function inspectReply(events, phase, terminalSequence) {
  const replies = events.items.filter(
    (event) => event.visible && event.kind === "agent_message",
  );
  assert(replies.length > 0, "durable Managed answer missing");
  assert(
    replies.every((event) => event.sequence > terminalSequence),
    "answer preceded Tool completion",
  );
  const messages = normalizeMessages(
    replies.map(({ payload }) => ({
      kind: payload.kind,
      id: payload.responseId ?? payload.messageId,
      content: payload.content,
    })),
  );
  assert.equal(messages.length, 1, "extra durable Managed reply");
  assert.deepEqual(messages[0].content, [
    { type: "text", text: `${phase} verified` },
  ]);
}

function inspectTools(events, expected, seenCalls, runId) {
  const stored = events.items.filter((event) => event.kind === "tool_call");
  const proposals = events.items
    .filter((event) => event.kind === "agent_message")
    .flatMap((event) => {
      const calls = event.payload.toolCalls;
      assert(
        calls === undefined || Array.isArray(calls),
        "durable model Tool proposal required",
      );
      return (calls ?? []).map((call) => ({ call, sequence: event.sequence }));
    });
  assert.equal(
    proposals.length,
    expected.names.length,
    "missing or additional model Tool proposal",
  );
  const calls = new Map();
  for (const event of stored) {
    const call = event.payload;
    assert.equal(event.visible, true);
    nonempty(call.toolCallId, "durable Tool identity required");
    if (!calls.has(call.toolCallId)) calls.set(call.toolCallId, []);
    calls.get(call.toolCallId).push(event);
  }
  assert.equal(
    calls.size,
    expected.names.length,
    "missing or additional durable Tool",
  );
  let managed = 0,
    builtin = 0,
    failed = 0,
    terminalSequence = 0;
  for (const [step, name] of expected.names.entries()) {
    const providerId = `${expected.phase}-${step}`;
    const id = createHash("sha256")
      .update(JSON.stringify([runId, step, providerId]))
      .digest("hex");
    assert(!seenCalls.has(id), "Tool belongs to more than one Run");
    seenCalls.add(id);
    const lifecycle = calls.get(id);
    assert(lifecycle?.length >= 2, "durable Tool start and terminal required");
    const first = lifecycle[0],
      last = lifecycle.at(-1);
    assert.equal(first.payload.initial, true, "durable Tool start missing");
    assert.equal(first.payload.status, "in_progress");
    assert.equal(first.payload.modelName, name);
    assert(object(first.payload.arguments), "durable Tool arguments required");
    nonempty(first.payload.title, "durable Tool title required");
    assert.deepEqual(
      proposals[step].call,
      {
        id,
        name,
        arguments: first.payload.arguments,
      },
      "Tool dispatch differs from durable model proposal",
    );
    assert(
      proposals[step].sequence > terminalSequence,
      "next model Tool preceded the prior result",
    );
    assert(
      proposals[step].sequence < first.sequence,
      "Tool started before model proposal",
    );
    const terminalStatus = name === "mcp__alpha__fail" ? "failed" : "completed";
    for (const [index, event] of lifecycle.entries()) {
      const payload = event.payload;
      assert.equal(payload.initial, index === 0, "repeated durable Tool start");
      assert.equal(
        payload.status,
        index === lifecycle.length - 1 ? terminalStatus : "in_progress",
        "missing, repeated or unexpected Tool terminal",
      );
      if (payload.modelName !== undefined)
        assert.equal(payload.modelName, name);
      if (payload.arguments !== undefined)
        assert.deepEqual(payload.arguments, first.payload.arguments);
    }
    assert.equal(last.payload.initial, false);
    assert(Array.isArray(last.payload.content), "durable Tool result required");
    assert(last.sequence > first.sequence);
    terminalSequence = Math.max(terminalSequence, last.sequence);
    if (terminalStatus === "failed") failed++;
    if (name.startsWith("mcp__")) managed++;
    else builtin++;
  }
  return {
    stored,
    managed,
    builtin,
    failed,
    terminalSequence,
    calls: calls.size,
  };
}

function inspectToolContent(actual, payload, version) {
  if (payload.content === undefined && payload.file === undefined) {
    assert.equal(actual.content, undefined);
    return;
  }
  const expected = (payload.content ?? []).map((content) => ({
    type: "content",
    content,
  }));
  const file = payload.file;
  if (file?.change !== undefined && file.change.before !== file.change.after) {
    if (version === 1)
      expected.push({
        type: "diff",
        path: file.path,
        oldText: file.change.before,
        newText: file.change.after,
      });
    else
      expected.push({
        type: "diff",
        changes: [
          {
            path: file.path,
            operation: file.change.before === null ? "add" : "modify",
            fileType: "text",
          },
        ],
      });
  }
  if (version === 2 && expected.at(-1)?.type === "diff") {
    assert(Array.isArray(actual.content));
    assert.equal(actual.content.length, expected.length);
    const observed = actual.content.map((content, index) => {
      if (index !== expected.length - 1 || content.patch === undefined)
        return content;
      // v2's bounded patch is optional presentation. Its authoritative path and
      // operation are compared below; original/replay retain the complete patch.
      assert.equal(content.patch.format, "git_patch");
      nonempty(content.patch.text, "v2 rendered patch text required");
      const { patch, ...rest } = content;
      void patch;
      return rest;
    });
    assert.deepEqual(
      observed,
      expected,
      "Tool file result differs from durable result",
    );
  } else
    assert.deepEqual(
      actual.content,
      expected,
      "Tool result differs from durable result",
    );
}

function inspectToolNotifications(notifications, stored, version) {
  const observed = notifications.filter(({ update }) =>
    toolUpdates.has(update.sessionUpdate),
  );
  assert.equal(
    observed.length,
    stored.length,
    "durable and observed Tool inventories differ",
  );
  for (const [index, { payload }] of stored.entries()) {
    const actual = observed[index].update;
    assert.equal(
      actual.sessionUpdate,
      version === 1 && payload.initial ? "tool_call" : "tool_call_update",
    );
    for (const [field, expected] of Object.entries({
      toolCallId: payload.toolCallId,
      status: payload.status,
      title: payload.title,
      name: payload.modelName,
      rawInput: payload.arguments,
      kind: payload.toolKind,
      locations:
        payload.file === undefined
          ? payload.locations
          : [{ path: payload.file.path }],
      rawOutput: payload.rawOutput,
    }))
      assert.deepEqual(
        actual[field],
        expected,
        "Tool notification differs from durable event",
      );
    inspectToolContent(actual, payload, version);
  }
}

function inspectPromptNotifications(evidence, expected, records) {
  const original = evidence.original;
  let after = 0;
  for (const [index, current] of expected.entries()) {
    const answers = original.flatMap(({ update }, position) => {
      if (
        !["agent_message", "agent_message_chunk"].includes(update.sessionUpdate)
      )
        return [];
      const content = Array.isArray(update.content)
        ? update.content
        : [update.content];
      const text = content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("");
      return text === `${current.phase} verified` ? [position] : [];
    });
    assert.equal(
      answers.length,
      1,
      "missing or duplicate Managed completion answer",
    );
    assert(answers[0] >= after, "reordered Managed completion answer");
    const answerPosition = answers[0];
    let end = answerPosition;
    if (evidence.version === 2) {
      end = original.findIndex(
        ({ update }, position) =>
          position > answerPosition &&
          update.sessionUpdate === "state_update" &&
          update.state === "idle",
      );
      assert(end > answers[0], "v2 idle completion missing");
      const user = records[index].events.items.find(
        (event) => event.kind === "user_message",
      );
      assert.equal(
        current.receipt.result.messageId,
        user.id,
        "v2 ACK changed durable input identity",
      );
    }
    assertPromptComplete(
      evidence.version,
      current.receipt.result,
      original.slice(after, end + 1),
      current.phase,
      evidence.sessionId,
    );
    after = end + 1;
  }
  assert(
    !original
      .slice(after)
      .some(
        ({ update }) =>
          toolUpdates.has(update.sessionUpdate) ||
          messageKinds.has(update.sessionUpdate.replace(/_chunk$/u, "")) ||
          update.sessionUpdate === "state_update",
      ),
    "unaccounted Managed output after completion",
  );
  assertReplay(
    evidence.version,
    original,
    evidence.replayed,
    expected.map(({ phase }) => phase),
    evidence.sessionId,
  );
}

export function inspectManagedBusinessEvidence(evidence) {
  assert(object(evidence), "Managed raw business evidence required");
  assert.deepEqual(
    evidence.errors,
    [],
    "Managed evidence contains a read failure",
  );
  const expected = originalRequests(evidence);
  assertModelSequence(evidence.model);
  completePage(evidence.auditList, "Managed Run page");
  assert.equal(
    evidence.auditList.items.length,
    expected.length,
    "six actual Managed Runs required",
  );
  assert(Array.isArray(evidence.runs));
  assert.equal(
    evidence.runs.length,
    expected.length,
    "complete Managed Run details required",
  );
  const summaries = new Map();
  for (const summary of evidence.auditList.items) {
    for (const field of summaryFields)
      nonempty(summary[field], "incomplete Managed Run summary");
    assert.equal(summary.agent_id, evidence.agentId);
    assert.equal(summary.session_id, evidence.sessionId);
    assert.equal(summary.principal_id, evidence.principalId);
    assert(!summaries.has(summary.run_id), "duplicate listed Managed Run");
    summaries.set(summary.run_id, summary);
  }
  const records = new Map(),
    runIds = new Set(),
    eventIds = new Set(),
    sequences = new Set(),
    calls = new Set();
  for (const record of evidence.runs) {
    const run = record.run;
    nonempty(run?.run_id, "actual Managed Run detail required");
    assert(!runIds.has(run.run_id), "duplicate Managed Run detail");
    runIds.add(run.run_id);
    const summary = summaries.get(run.run_id);
    assert(summary, "Managed Run detail absent from its list");
    for (const field of summaryFields)
      assert.equal(
        run[field],
        summary[field],
        "Managed Run detail changed its list",
      );
    const matches = expected.filter(({ receipt }) =>
      isDeepStrictEqual(receipt.params.prompt, run.input),
    );
    assert.equal(
      matches.length,
      1,
      "Run is not bound to one original Managed prompt",
    );
    const current = matches[0];
    assert(
      !records.has(current.phase),
      "one Managed prompt produced duplicate Runs",
    );
    records.set(current.phase, record);
    assert.equal(run.state, "completed");
    assert.equal(run.terminal_class, "completed");
    assert.equal(run.executor_state, "quiescent");
    assert.equal(run.tool_effect_state, "settled");
    assert.equal(run.stop_reason, "end_turn");
    assert.equal(run.error_class, null);
    assert(
      run.unknown_effect_source === undefined ||
        run.unknown_effect_source === null,
    );
    assert(
      Number.isFinite(Date.parse(run.created_at)) &&
        Number.isFinite(Date.parse(run.updated_at)),
    );
    inspectSnapshot(run, current.request.snapshot);
    inspectEvents(record.events, run, eventIds, sequences);
  }
  const ordered = expected.map(({ phase }) => {
    const record = records.get(phase);
    assert(record, "Managed phase lacks durable Run evidence");
    return record;
  });
  const allTools = [];
  let toolCount = 0,
    managed = 0,
    builtin = 0,
    failed = 0,
    previousSequence = 0;
  for (const [index, current] of expected.entries()) {
    const { run, events } = ordered[index];
    for (const event of events.items) {
      assert(
        event.sequence > previousSequence,
        "Managed Run history changed original prompt order",
      );
      previousSequence = event.sequence;
    }
    const tools = inspectTools(events, current, calls, run.run_id);
    inspectReply(events, current.phase, tools.terminalSequence);
    allTools.push(...tools.stored);
    toolCount += tools.calls;
    managed += tools.managed;
    builtin += tools.builtin;
    failed += tools.failed;
  }
  assert.deepEqual(
    observedMessages(evidence.original, evidence.sessionId),
    durableMessages(ordered, { omitUsers: evidence.version === 1 }),
    "original Managed messages differ from durable history",
  );
  assert.deepEqual(
    observedMessages(evidence.replayed, evidence.sessionId),
    durableMessages(ordered),
    "replayed Managed messages differ from durable history",
  );
  inspectToolNotifications(evidence.original, allTools, evidence.version);
  inspectToolNotifications(evidence.replayed, allTools, evidence.version);
  inspectPromptNotifications(evidence, expected, ordered);
  assert.equal(calls.size, toolCount);
  assert.equal(toolCount, 10);
  assert.equal(managed, 6);
  assert.equal(builtin, 4);
  assert.equal(failed, 1);
  return {
    status: "passed",
    runs: runIds.size,
    tool_calls: toolCount,
    managed_tool_calls: managed,
    builtin_tool_calls: builtin,
    failed_tool_calls: failed,
    model_requests: evidence.model.requests.length,
  };
}

function throwFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Managed audit reading and evidence archive failed",
    );
}

export async function collectManagedBusinessEvidence(
  input,
  { readJSON, preserve, signal } = {},
) {
  assert.equal(
    typeof preserve,
    "function",
    "Managed raw evidence archive required",
  );
  const evidence = { auditList: null, runs: [], errors: [] };
  let summary;
  try {
    Object.assign(evidence, structuredClone(input), {
      auditList: null,
      runs: [],
      errors: [],
    });
    assert.equal(typeof readJSON, "function", "Managed audit reader required");
    nonempty(evidence.agentId, "original Managed Agent required");
    nonempty(evidence.sessionId, "original Managed Session required");
    signal?.throwIfAborted();
    const query = new URLSearchParams({
      agent_id: evidence.agentId,
      session_id: evidence.sessionId,
      limit: "100",
    });
    evidence.auditList = structuredClone(
      await readJSON("/api/admin/execution-audits?" + query, { signal }),
    );
    signal?.throwIfAborted();
    completePage(evidence.auditList, "Managed Run page");
    assert.equal(
      evidence.auditList.items.length,
      plans.length,
      "six actual Managed Runs required",
    );
    for (const listed of evidence.auditList.items) {
      nonempty(listed.run_id, "listed Managed Run identity required");
      signal?.throwIfAborted();
      const path =
        "/api/admin/execution-audits/" + encodeURIComponent(listed.run_id);
      const record = { run: null, events: null };
      evidence.runs.push(record);
      record.run = structuredClone(await readJSON(path, { signal }));
      signal?.throwIfAborted();
      record.events = structuredClone(
        await readJSON(path + "/events?limit=100", { signal }),
      );
      // Store a completed read before checking cancellation, so its original
      // response survives in the partial archive even when cancellation won.
      signal?.throwIfAborted();
      completePage(record.events, "execution event page");
    }
    summary = inspectManagedBusinessEvidence(evidence);
    signal?.throwIfAborted();
  } catch (error) {
    evidence.errors.push(error);
  }
  try {
    await preserve(evidence);
  } catch (error) {
    evidence.errors.push(error);
  }
  if (signal?.aborted && !evidence.errors.includes(signal.reason))
    evidence.errors.push(signal.reason);
  throwFailures(evidence.errors);
  return { evidence, summary };
}
