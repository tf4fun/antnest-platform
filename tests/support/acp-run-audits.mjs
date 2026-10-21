import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, reason) => {
  if (!condition)
    throw new Error("Prompt Run audit evidence is invalid: " + reason);
};
const record = (value, reason) => {
  check(object(value), reason);
  return value;
};
const list = (value, reason) => {
  check(Array.isArray(value), reason);
  return value;
};
const id = (value) =>
  check(
    typeof value === "string" && value.trim().length > 0,
    "missing identity",
  );
const same = (actual, expected, reason) =>
  check(isDeepStrictEqual(actual, expected), reason);
const summaryFields = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const toolUpdateKinds = new Set(["tool_call", "tool_call_update"]);
const terminalToolStates = new Set(["completed", "failed", "cancelled"]);

function page(value, stream) {
  record(value, "missing Audit page");
  const items = list(value.items, "missing Audit items");
  check(
    items.length <= 100 && value.next_cursor === null,
    "incomplete Audit page",
  );
  if (stream !== undefined)
    check(value.stream === stream, "wrong Audit stream");
  return items;
}

function readyInventory(readyAgents, principalId) {
  id(principalId);
  check(
    list(readyAgents, "missing original ready Agents").length > 0,
    "empty ready inventory",
  );
  const ready = new Map();
  for (const agent of readyAgents) {
    record(agent, "missing ready Agent");
    id(agent.agent_id);
    check(!ready.has(agent.agent_id), "duplicate ready Agent");
    check(agent.owner_user_id === principalId, "ready Agent owner changed");
    check(
      agent.lifecycle_state === "created" &&
        agent.activation_state === "enabled" &&
        agent.desired_state === "enabled" &&
        agent.runtime_state === "available" &&
        !agent.active_operation_request_id,
      "Agent was not ready",
    );
    id(agent.executable_execution_revision);
    id(
      record(agent.runtime, "missing ready Runtime revision").runtime_revision,
    );
    if (agent.agent_spec_revision !== undefined) id(agent.agent_spec_revision);
    ready.set(agent.agent_id, agent);
  }
  return ready;
}

function originalRequests(requests, ready) {
  check(
    list(requests, "missing original Prompts").length > 0,
    "empty Prompt inventory",
  );
  for (const request of requests) {
    record(request, "missing original Prompt");
    check(
      ready.has(request.agentId) && [1, 2].includes(request.protocolVersion),
      "foreign Prompt Agent or protocol",
    );
    id(request.sessionId);
    id(request.phase);
    const receipt = record(
      request.promptReceipt,
      "missing original Prompt receipt",
    );
    id(receipt.requestId);
    if (request.requestId !== undefined)
      check(
        receipt.requestId === request.requestId,
        "original Prompt request identity changed",
      );
    if (receipt.sessionId !== undefined)
      check(
        receipt.sessionId === request.sessionId,
        "original Prompt Session changed",
      );
    same(
      receipt.input,
      [{ type: "text", text: request.phase }],
      "original Prompt input changed",
    );
    record(receipt.result, "missing original Prompt result");
    if (request.protocolVersion === 1)
      check(
        receipt.result.stopReason === "end_turn",
        "original Prompt did not complete",
      );
    else id(receipt.result.messageId);
    for (const frame of list(
      receipt.updates,
      "missing original live updates",
    )) {
      record(frame, "missing original live update");
      check(frame.sessionId === request.sessionId, "foreign live Session");
      id(
        record(frame.update, "missing original live update body").sessionUpdate,
      );
    }
    for (const tool of list(
      request.expectedTools,
      "missing original Tool oracle",
    )) {
      record(tool, "missing original Tool oracle entry");
      id(tool.name);
      record(tool.arguments, "missing original Tool arguments");
    }
  }
  return requests;
}

function executionEvents(value, run, eventIds, sequences) {
  const events = page(value, "execution");
  let previous = 0;
  if (!sequences.has(run.session_id)) sequences.set(run.session_id, new Set());
  const sessionSequences = sequences.get(run.session_id);
  for (const event of events) {
    record(event, "missing persisted event");
    id(event.id);
    check(!eventIds.has(event.id), "duplicate persisted event identity");
    eventIds.add(event.id);
    check(
      Number.isSafeInteger(event.sequence) &&
        event.sequence > previous &&
        !sessionSequences.has(event.sequence),
      "duplicate or unordered Session event",
    );
    previous = event.sequence;
    sessionSequences.add(event.sequence);
    check(
      typeof event.visible === "boolean" &&
        typeof event.created_at === "string" &&
        Number.isFinite(Date.parse(event.created_at)),
      "incomplete persisted event",
    );
    id(event.kind);
    const payload = record(event.payload, "missing persisted event body");
    check(payload.kind === event.kind, "persisted event kind changed");
    if (
      ["user_message", "agent_message", "agent_thought"].includes(event.kind)
    ) {
      check(
        payload.messageId === event.id,
        "persisted message identity changed",
      );
      list(payload.content, "missing persisted message content");
      if (payload.responseId !== undefined) id(payload.responseId);
    }
  }
  return events;
}

function liveMessageParts(updates, role) {
  const result = [];
  for (const { update } of updates) {
    if (![role, role + "_chunk"].includes(update.sessionUpdate)) continue;
    id(update.messageId);
    const content = update.sessionUpdate.endsWith("_chunk")
      ? [record(update.content, "missing live message chunk")]
      : list(update.content, "missing live message content");
    for (const block of content)
      result.push({ messageId: update.messageId, content: block });
  }
  return result;
}

function messagesFor(events, request) {
  const users = events.filter((event) => event.kind === "user_message");
  check(
    users.length === 1 && users[0].visible === true,
    "missing or repeated persisted user message",
  );
  const user = users[0];
  same(
    user.payload.content,
    request.promptReceipt.input,
    "persisted user input changed",
  );
  const updates = request.promptReceipt.updates;
  const liveUsers = liveMessageParts(updates, "user_message");
  if (request.protocolVersion === 2) {
    check(
      request.promptReceipt.result.messageId === user.id,
      "v2 ACK changed durable user identity",
    );
    check(liveUsers.length > 0, "original v2 user notification missing");
  }
  // The original v1 accepted Prompt suppresses its user echo. When an echo is
  // present, it still has to describe this same persisted user message.
  if (liveUsers.length)
    same(
      liveUsers,
      user.payload.content.map((content) => ({ messageId: user.id, content })),
      "original user notification changed",
    );
  const replies = events.filter(
    (event) =>
      event.kind === "agent_message" && event.payload.content.length > 0,
  );
  check(
    replies.length > 0 && replies.every((event) => event.visible === true),
    "persisted assistant reply missing",
  );
  const expected = [];
  let text = "";
  for (const { payload } of replies) {
    for (const content of payload.content) {
      check(
        object(content) &&
          content.type === "text" &&
          typeof content.text === "string",
        "invalid assistant reply",
      );
      text += content.text;
      expected.push({
        messageId: payload.responseId ?? payload.messageId,
        content,
      });
    }
  }
  check(
    text === request.phase + " verified",
    "assistant reply changed the original phase",
  );
  // v2 streaming chunks carry responseId; whole non-streamed messages carry
  // messageId and an array. Flatten only that protocol representation.
  same(
    liveMessageParts(updates, "agent_message"),
    expected,
    "original assistant reply differs from persistence",
  );
  return replies;
}

function toolsFor(events, run, request, replies) {
  const dispatches = [];
  for (const event of events.filter((row) => row.kind === "agent_message")) {
    const calls = event.payload.toolCalls;
    if (calls === undefined) continue;
    for (const call of list(calls, "invalid persisted Tool dispatches"))
      dispatches.push({
        event,
        call: record(call, "missing persisted Tool dispatch"),
      });
  }
  check(
    dispatches.length === request.expectedTools.length,
    "missing or extra persisted Tool dispatch",
  );
  const stored = events.filter((event) => event.kind === "tool_call");
  const live = request.promptReceipt.updates.filter((frame) =>
    toolUpdateKinds.has(frame.update.sessionUpdate),
  );
  check(
    stored.length === live.length,
    "persisted and live Tool inventories differ",
  );
  const expectedIds = new Set();
  let previousTerminal = 0;
  for (const [step, tool] of request.expectedTools.entries()) {
    const { event: dispatch, call } = dispatches[step];
    const toolId = createHash("sha256")
      .update(JSON.stringify([run.run_id, step, request.phase]))
      .digest("hex");
    check(
      call.id === toolId && call.name === tool.name,
      "Tool dispatch identity changed",
    );
    same(call.arguments, tool.arguments, "Tool dispatch arguments changed");
    expectedIds.add(toolId);
    const history = stored.filter(
      (event) => event.payload.toolCallId === toolId,
    );
    check(
      history.length > 0 &&
        dispatch.sequence > previousTerminal &&
        history[0].sequence > dispatch.sequence,
      "missing or reordered Tool lifecycle",
    );
    const first = history[0].payload;
    check(
      first.initial === true && first.modelName === tool.name,
      "missing original Tool intent",
    );
    same(first.arguments, tool.arguments, "persisted Tool input changed");
    for (const [index, event] of history.entries()) {
      const payload = event.payload;
      check(
        payload.initial === (index === 0),
        "repeated or missing Tool start",
      );
      check(
        index === history.length - 1
          ? terminalToolStates.has(payload.status)
          : payload.status === "in_progress",
        "Tool did not settle exactly once",
      );
    }
    previousTerminal = history.at(-1).sequence;
  }
  check(
    stored.every((event) => expectedIds.has(event.payload.toolCallId)),
    "foreign persisted Tool event",
  );
  for (const [index, event] of stored.entries()) {
    const payload = event.payload,
      actual = live[index].update;
    check(
      actual.toolCallId === payload.toolCallId &&
        actual.sessionUpdate ===
          (request.protocolVersion === 1 && payload.initial
            ? "tool_call"
            : "tool_call_update"),
      "original Tool update identity changed",
    );
    check(
      actual.status ===
        (request.protocolVersion === 1 && payload.status === "cancelled"
          ? "failed"
          : payload.status),
      "original Tool status differs from persistence",
    );
    same(
      actual.rawInput,
      payload.arguments,
      "original Tool input differs from persistence",
    );
    same(
      actual.name,
      payload.modelName,
      "original Tool name differs from persistence",
    );
    const content =
      actual.content === undefined
        ? []
        : list(actual.content, "invalid live Tool content");
    // File display diffs have their own profile gate. They supplement the
    // original wrapped Tool result and cannot replace or change its body.
    same(
      content
        .filter((item) => item?.type === "content")
        .map((item) => item.content),
      payload.content ?? [],
      "original Tool result differs from persistence",
    );
  }
  check(
    replies[0].sequence > previousTerminal,
    "assistant replied before Tool completion",
  );
  return dispatches.length;
}

function inspectRun(
  saved,
  summary,
  request,
  ready,
  principalId,
  eventIds,
  sequences,
) {
  const run = record(saved.run, "missing Run detail");
  for (const field of summaryFields)
    same(
      run[field],
      summary[field],
      "Run detail differs from its original list",
    );
  check(
    run.agent_id === request.agentId &&
      run.session_id === request.sessionId &&
      run.principal_id === principalId,
    "Run authority or Session changed",
  );
  same(
    run.input,
    request.promptReceipt.input,
    "Run input differs from its original Prompt",
  );
  const snapshot = record(
    run.execution_snapshot,
    "missing public execution snapshot",
  );
  check(
    snapshot.executionRevision === ready.executable_execution_revision,
    "Run execution revision changed",
  );
  if (ready.agent_spec_revision !== undefined)
    check(
      snapshot.agentSpecRevision === ready.agent_spec_revision,
      "Run Agent specification changed",
    );
  check(
    run.state === "completed" &&
      run.terminal_class === "completed" &&
      run.executor_state === "quiescent" &&
      ["none", "settled"].includes(run.tool_effect_state) &&
      run.stop_reason === "end_turn" &&
      run.error_class === null &&
      (run.unknown_effect_source === null ||
        run.unknown_effect_source === undefined),
    "Run did not complete with known effects",
  );
  const events = executionEvents(saved.events, run, eventIds, sequences);
  const replies = messagesFor(events, request);
  return toolsFor(events, run, request, replies);
}

// This checks original public Audit/SDK facts only. Physical Runtime effects,
// model counts, permission denial, Plan gates and actual cleanup stay with the
// owning client; no diagnostic correlation fields participate in admission.
export function inspectPromptRunAudits(evidence) {
  record(evidence, "missing original Audit evidence");
  const ready = readyInventory(evidence.ready_agents, evidence.principal_id);
  const requests = originalRequests(evidence.requests, ready);
  const agents = list(evidence.agents, "missing original Agent Audits");
  check(agents.length === ready.size, "missing or extra Agent Audit");
  const seenAgents = new Set(),
    runIds = new Set(),
    matched = new Set(),
    eventIds = new Set(),
    sequences = new Map();
  let toolCalls = 0;
  for (const agent of agents) {
    record(agent, "missing original Agent Audit");
    check(
      ready.has(agent.agent_id) && !seenAgents.has(agent.agent_id),
      "foreign or duplicate Agent Audit",
    );
    seenAgents.add(agent.agent_id);
    const originals = requests.filter(
      (request) => request.agentId === agent.agent_id,
    );
    const summaries = page(agent.page),
      all = list(agent.all, "missing original Run details");
    check(
      summaries.length === originals.length && all.length === summaries.length,
      "missing or extra Run",
    );
    const listed = new Map();
    for (const summary of summaries) {
      record(summary, "missing original Run summary");
      for (const field of summaryFields) id(summary[field]);
      check(
        summary.agent_id === agent.agent_id &&
          summary.principal_id === evidence.principal_id &&
          !listed.has(summary.run_id),
        "Run summary authority or identity changed",
      );
      listed.set(summary.run_id, summary);
    }
    for (const saved of all) {
      record(saved, "missing original Run Audit");
      const run = record(saved.run, "missing Run detail");
      id(run.run_id);
      check(
        listed.has(run.run_id) && !runIds.has(run.run_id),
        "unlisted or duplicate Run detail",
      );
      runIds.add(run.run_id);
      const matches = originals.filter(
        (request) =>
          request.sessionId === run.session_id &&
          isDeepStrictEqual(request.promptReceipt.input, run.input),
      );
      check(
        matches.length === 1 && !matched.has(matches[0]),
        "Run is not bound to one original Prompt",
      );
      const request = matches[0];
      matched.add(request);
      toolCalls += inspectRun(
        saved,
        listed.get(run.run_id),
        request,
        ready.get(agent.agent_id),
        evidence.principal_id,
        eventIds,
        sequences,
      );
    }
  }
  check(
    matched.size === requests.length,
    "original Prompt has no persisted Run",
  );
  return {
    status: "passed",
    agents: ready.size,
    runs: runIds.size,
    completed: runIds.size,
    tool_calls: toolCalls,
  };
}

export async function collectPromptRunAudits({
  read,
  readyAgents,
  requests,
  principalId,
  preserve,
}) {
  const evidence = {
    principal_id: principalId,
    ready_agents: [],
    requests: [],
    agents: [],
  };
  let failure,
    failed = false;
  try {
    check(
      typeof read === "function" && typeof preserve === "function",
      "Audit read and archive are required",
    );
    evidence.ready_agents = structuredClone(readyAgents);
    evidence.requests = structuredClone(requests);
    const ready = readyInventory(evidence.ready_agents, principalId);
    originalRequests(evidence.requests, ready);
    for (const agentId of ready.keys()) {
      const receipt = { agent_id: agentId, page: null, all: [] };
      evidence.agents.push(receipt);
      receipt.page = await read(
        `/api/admin/execution-audits?agent_id=${encodeURIComponent(agentId)}&limit=100`,
      );
      for (const summary of page(receipt.page)) {
        id(summary?.run_id);
        const path = `/api/admin/execution-audits/${encodeURIComponent(summary.run_id)}`;
        const detail = { run: null, events: null };
        receipt.all.push(detail);
        detail.run = await read(path);
        detail.events = await read(path + "/events?limit=100");
        page(detail.events, "execution");
      }
    }
    inspectPromptRunAudits(evidence);
    return evidence;
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (typeof preserve === "function") {
      try {
        await preserve(evidence, failure);
      } catch (error) {
        if (failed)
          throw new AggregateError(
            [failure, error],
            "Prompt Run Audit and private archive failed",
          );
        throw error;
      }
    }
  }
}
